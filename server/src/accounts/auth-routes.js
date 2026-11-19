// Sign-in and the account: /v1/auth/start|code|link|password|signout and GET/PUT/DELETE /v1/me.
// Spec: ACCOUNTS.md (section 3, "Sign-in" and "The account").
//
// authRoutes(ctx) -> [{ method, path, run(req, res, { ip }) }]. Mounted by createApp under the accounts switch.
// Nothing here logs an email, token, code, cookie or password.

import { readJsonBody, send, sendLimited } from '../http.js';
import { cleanName } from '../records.js';
import { checkNewPassword, randomToken, safeEqual, sha256Hex, sixDigitCode } from './crypto.js';
import { accountDeletedEmail, passwordChangedEmail, signInEmail } from './emails.js';
import { PASSWORD, SIGN_IN } from './limits.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function authRoutes(ctx) {
  const { store, limits, now, log, hasher } = ctx;

  const busy = (res) => sendLimited(res, { retryAfter: PASSWORD.busyRetryAfterS });
  const isBusy = (err) => err?.code === 'busy';

  /** Sends mail without holding up (or changing) the answer; a failure is one log line with no address. */
  function mailLater(to, message, what) {
    if (!ctx.mailer) return;
    Promise.resolve()
      .then(() => ctx.mailer.send({ to, ...message }))
      .catch((err) => log(`mail failed (${what}) ${err?.code || err?.name || 'Error'}`));
  }

  const linkHash = (token) => ctx.secretHash(`link:${token}`);
  const codeHash = (id, code) => ctx.secretHash(`code:${id}:${code}`);

  function signInLink(token) {
    const base = ctx.config.appUrl;
    return `${base}${base.includes('?') ? '&' : '?'}signin=${token}`;
  }

  /** A link or code was right: find or create the account, start a session, answer with `me`. */
  async function finishSignIn(req, res, email) {
    const role = ctx.isSuperEmail(email) ? 'admin' : undefined;
    const account = await store.accounts.signIn(email, { at: now(), role });
    if (account.status !== 'active') return send(res, 403, { error: 'disabled' });
    await store.signIns.deleteForEmail(email); // any other codes still waiting in the inbox stop working
    await ctx.startSession(req, res, account);
    return send(res, 200, { ok: true, me: await ctx.me(account) });
  }

  // POST /v1/auth/start {email} -> 200 {ok:true, id}
  async function start(req, res, { ip }) {
    const verdict = limits.startPerIp.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const body = await readJsonBody(req, res);
    if (!body) return;
    const email = ctx.normaliseEmail(body.email);
    if (!email) return send(res, 400, { error: 'bad_email' });
    const id = randomToken(SIGN_IN.idBytes);
    // Over the per-address limit: the same answer, and no email. Nothing says whether the address has an account.
    if (!limits.startPerEmail.take(sha256Hex(email)).ok) return send(res, 200, { ok: true, id });
    const token = randomToken(SIGN_IN.tokenBytes);
    const code = sixDigitCode();
    const at = now();
    await store.signIns.create({
      id, email, linkHash: linkHash(token), codeHash: codeHash(id, code), at, expiresAt: at + SIGN_IN.lifetimeMs,
    });
    mailLater(email, signInEmail({ link: signInLink(token), code, minutes: Math.round(SIGN_IN.lifetimeMs / 60_000) }), 'sign-in');
    ctx.pruneSoon();
    return send(res, 200, { ok: true, id });
  }

  // POST /v1/auth/code {id, code} -> 200 {ok:true, me} + cookie | 400 bad_code {left} | 410 expired
  async function code(req, res, { ip }) {
    if (!ctx.clientCheck(req)) return send(res, 403, { error: 'bad_origin' });
    const verdict = limits.attemptsPerIp.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (typeof body.id !== 'string' || !ID_RE.test(body.id)) return send(res, 410, { error: 'expired' });
    const given = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : typeof body.code === 'number' ? String(body.code).padStart(6, '0') : '';
    const at = now();
    // Count the try first, then compare: parallel guesses cannot get more than SIGN_IN.codeTries comparisons.
    const row = await store.signIns.takeTry(body.id, { at, maxTries: SIGN_IN.codeTries });
    if (!row) return send(res, 410, { error: 'expired' });
    if (!/^\d{6}$/.test(given) || !safeEqual(codeHash(body.id, given), row.codeHash)) {
      return send(res, 400, { error: 'bad_code', left: Math.max(0, SIGN_IN.codeTries - row.tries) });
    }
    const email = await store.signIns.use(body.id, at);
    if (!email) return send(res, 410, { error: 'expired' });
    return finishSignIn(req, res, email);
  }

  // POST /v1/auth/link {token} -> 200 {ok:true, me} + cookie | 410 expired
  async function link(req, res, { ip }) {
    if (!ctx.clientCheck(req)) return send(res, 403, { error: 'bad_origin' });
    const verdict = limits.attemptsPerIp.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) return send(res, 410, { error: 'expired' });
    const email = await store.signIns.useLink(linkHash(body.token), now());
    if (!email) return send(res, 410, { error: 'expired' });
    return finishSignIn(req, res, email);
  }

  // POST /v1/auth/password {email, password} -> 200 {ok:true, me} + cookie | 401 bad_login
  async function password(req, res, { ip }) {
    if (!ctx.clientCheck(req)) return send(res, 403, { error: 'bad_origin' });
    let verdict = limits.passwordPerIp.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const body = await readJsonBody(req, res);
    if (!body) return;
    const email = ctx.normaliseEmail(body.email);
    const pw = typeof body.password === 'string' ? body.password.slice(0, PASSWORD.maxChars) : '';
    if (email) {
      verdict = limits.passwordPerEmailIp.take(`${sha256Hex(email)}|${ip}`);
      if (!verdict.ok) return sendLimited(res, verdict);
    }
    const account = email ? await store.accounts.byEmail(email) : null;
    let ok;
    try {
      // Always runs scrypt, also with no account or no password, so the answer's timing says nothing.
      ok = await hasher.verify(pw, account?.passwordHash ?? null);
    } catch (err) {
      if (isBusy(err)) return busy(res);
      throw err;
    }
    if (!ok || !account || !pw || account.status !== 'active') return send(res, 401, { error: 'bad_login' });
    const role = ctx.isSuperEmail(account.email) ? 'admin' : undefined;
    const fresh = await store.accounts.signIn(account.email, { at: now(), role });
    await ctx.startSession(req, res, fresh);
    return send(res, 200, { ok: true, me: await ctx.me(fresh) });
  }

  // POST /v1/auth/signout {everywhere?:true} -> 200 {ok:true}, cookie cleared
  async function signout(req, res, { ip }) {
    const verdict = limits.me.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const s = await ctx.sessionFromRequest(req, res);
    if (s?.error === 'bad_origin') return send(res, 403, { error: 'bad_origin' });
    const body = await readJsonBody(req, res, { allowEmpty: true });
    if (!body) return;
    const token = ctx.tokenFromCookie(req);
    if (s?.account && body.everywhere === true) await store.sessions.deleteForAccount(s.account.id);
    else if (token) await store.sessions.delete(ctx.hashSessionToken(token));
    ctx.clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  /** The signed-in session or an answer already sent (returns null then). */
  async function signedIn(req, res, ip) {
    const verdict = limits.me.take(ip);
    if (!verdict.ok) {
      sendLimited(res, verdict);
      return null;
    }
    const s = await ctx.sessionFromRequest(req, res);
    if (s?.error) {
      send(res, s.status, { error: s.error });
      return null;
    }
    if (!s) {
      send(res, 401, { error: 'signed_out' });
      return null;
    }
    return s;
  }

  // GET /v1/me -> 200 me | 401 signed_out
  async function getMe(req, res, { ip }) {
    const s = await signedIn(req, res, ip);
    if (!s) return;
    return send(res, 200, await ctx.me(s.account));
  }

  // PUT /v1/me {name?, password?:{new, current?}} -> 200 {ok:true, me}
  async function putMe(req, res, { ip }) {
    const s = await signedIn(req, res, ip);
    if (!s) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const { account, session, tokenHash } = s;

    // Check everything before writing anything.
    let name;
    if (body.name !== undefined && body.name !== null) {
      name = cleanName(body.name);
      if (!name) return send(res, 400, { error: 'name_invalid' });
    }
    let pw;
    if (body.password !== undefined && body.password !== null) {
      const p = body.password;
      if (typeof p !== 'object' || Array.isArray(p)) return send(res, 400, { error: 'bad_request' });
      if (checkNewPassword(p.new)) return send(res, 400, { error: 'weak_password' });
      if (p.current !== undefined && p.current !== null && typeof p.current !== 'string') return send(res, 400, { error: 'bad_request' });
      pw = { new: p.new, current: typeof p.current === 'string' ? p.current.slice(0, PASSWORD.maxChars) : null };
      if (account.passwordHash) {
        // Changing a password needs the current one.
        const verdict = limits.passwordPerEmailIp.take(`${sha256Hex(account.email)}|${ip}`);
        if (!verdict.ok) return sendLimited(res, verdict);
        if (!pw.current) return send(res, 401, { error: 'bad_login' });
        let ok;
        try {
          ok = await hasher.verify(pw.current, account.passwordHash);
        } catch (err) {
          if (isBusy(err)) return busy(res);
          throw err;
        }
        if (!ok) return send(res, 401, { error: 'bad_login' });
      } else if (!ctx.isFresh(session)) {
        // A first password needs a recent sign-in (by link or code), so a forgotten open session cannot set one.
        return send(res, 403, { error: 'reauth' });
      }
    }

    let hash;
    if (pw) {
      try {
        hash = await hasher.hash(pw.new);
      } catch (err) {
        if (isBusy(err)) return busy(res);
        throw err;
      }
    }
    if (name) {
      const r = await store.accounts.setName(account.id, name);
      if (r.status === 'name_taken') return send(res, 409, { error: 'name_taken' });
      if (r.status !== 'ok') return send(res, 401, { error: 'signed_out' });
    }
    if (hash) {
      await store.accounts.setPassword(account.id, hash);
      await store.sessions.deleteForAccount(account.id, { except: tokenHash });
      mailLater(account.email, passwordChangedEmail(), 'password-changed');
    }
    const fresh = await store.accounts.byId(account.id);
    return send(res, 200, { ok: true, me: await ctx.me(fresh) });
  }

  // DELETE /v1/me -> 200 {ok:true}, cookie cleared
  async function deleteMe(req, res, { ip }) {
    const s = await signedIn(req, res, ip);
    if (!s) return;
    if (ctx.isSuper(s.account)) return send(res, 409, { error: 'super' });
    if (!ctx.isFresh(s.session)) return send(res, 403, { error: 'reauth' });
    await store.accounts.delete(s.account.id);
    await store.signIns.deleteForEmail(s.account.email);
    mailLater(s.account.email, accountDeletedEmail(), 'account-deleted');
    ctx.clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  return [
    { method: 'POST', path: '/v1/auth/start', run: start },
    { method: 'POST', path: '/v1/auth/code', run: code },
    { method: 'POST', path: '/v1/auth/link', run: link },
    { method: 'POST', path: '/v1/auth/password', run: password },
    { method: 'POST', path: '/v1/auth/signout', run: signout },
    { method: 'GET', path: '/v1/me', run: getMe },
    { method: 'PUT', path: '/v1/me', run: putMe },
    { method: 'DELETE', path: '/v1/me', run: deleteMe },
  ];
}
