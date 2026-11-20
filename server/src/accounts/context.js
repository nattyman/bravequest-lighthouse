// The shared account helpers every account-aware route uses: sessions and cookies, the request checks,
// the owner resolver, roles and tools, `me`, the audit writer. Spec: ACCOUNTS.md (sections 1 and 2).
//
// createApp builds one context and hands it to each route module (auth-routes.js, saves-routes.js,
// admin-routes.js). It is also exposed as handler.accounts for tests.

import { keyFromRequest, saveIdForKey } from '../http.js';
import { createHasher, hmacHex, randomToken, sha256Hex } from './crypto.js';
import { createLimiter } from '../http.js';
import {
  ACCOUNT_LIMITS, DEFAULT_TESTER_TOOLS, MAX_EMAIL_CHARS, SESSION, TOOL_GROUPS,
} from './limits.js';

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url
const PRUNE_EVERY_MS = 10 * 60_000;

/** Lower-cases and trims an email; null unless it looks like an address. */
export function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(email)) return null;
  return email;
}

/** A short device label from a User-Agent ("Chrome on Android"); the raw string is never kept. */
export function deviceNote(ua) {
  const s = typeof ua === 'string' ? ua.slice(0, 512) : '';
  if (!s) return '';
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : 'Browser';
  const os = /iPad/.test(s) ? 'iPad'
    : /iPhone|iPod/.test(s) ? 'iPhone'
    : /Android/.test(s) ? 'Android'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux'
    : '';
  return (os ? `${browser} on ${os}` : browser).slice(0, SESSION.noteChars);
}

/** Reads the bq_s cookie's token from a request; null when absent or malformed. */
export function tokenFromCookie(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== SESSION.cookie) continue;
    const v = part.slice(i + 1).trim();
    return TOKEN_RE.test(v) ? v : null;
  }
  return null;
}

/**
 * @param store      the main store (store.accounts, store.sessions, store.signIns, store.settings, store.audit ...)
 * @param accounts   the accounts config (see config.js): { enabled, appUrl, sessionSecret, cookieInsecure,
 *                   superAdminEmails, mailer, admin, limits?, hasher? }
 * @param origins    compileOrigins() result from app.js
 */
export function createAccountsContext({ store, accounts = {}, origins, now = Date.now, log = () => {} }) {
  const enabled = accounts.enabled === true;
  const superEmails = new Set((accounts.superAdminEmails ?? []).map((e) => String(e).trim().toLowerCase()));
  const hasher = accounts.hasher ?? createHasher();
  const limits = {};
  for (const name of Object.keys(ACCOUNT_LIMITS)) {
    limits[name] = createLimiter({ ...ACCOUNT_LIMITS[name], ...(accounts.limits?.[name] ?? {}) }, now);
  }
  let lastPrune = 0;

  const cookieAttrs = (maxAgeS) =>
    `Path=/; Max-Age=${maxAgeS}; HttpOnly${accounts.cookieInsecure ? '' : '; Secure'}; SameSite=Lax`;

  const ctx = {
    enabled,
    config: accounts,
    store,
    mailer: accounts.mailer ?? null,
    hasher,
    limits,
    now,
    log,

    normaliseEmail,
    deviceNote,
    tokenFromCookie,
    hashSessionToken: sha256Hex,
    /** HMAC with SESSION_SECRET, for sign-in links and codes (a six-digit code is too small for a bare hash). */
    secretHash: (value) => hmacHex(accounts.sessionSecret ?? '', value),

    isSuperEmail: (email) => superEmails.has(String(email ?? '').toLowerCase()),
    isSuper: (account) => Boolean(account) && superEmails.has(account.email),

    /** True when the request may act on a cookie session: X-BQ-Client: 1 and an exactly-listed Origin. */
    clientCheck(req) {
      return req.headers['x-bq-client'] === '1' && origins.isExact(req.headers.origin);
    },

    setSessionCookie(res, token) {
      res.setHeader('Set-Cookie', `${SESSION.cookie}=${token}; ${cookieAttrs(Math.floor(SESSION.lifetimeMs / 1000))}`);
    },
    clearSessionCookie(res) {
      res.setHeader('Set-Cookie', `${SESSION.cookie}=; ${cookieAttrs(0)}`);
    },

    /** True when the session was created within SESSION.freshMs (needed for a first password and deletion). */
    isFresh: (session) => Boolean(session) && now() - session.createdAt <= SESSION.freshMs,

    /** Creates a session for the account, sets the cookie. -> session */
    async startSession(req, res, account) {
      const token = randomToken(SESSION.tokenBytes);
      const at = now();
      const session = {
        tokenHash: sha256Hex(token), accountId: account.id, at, expiresAt: at + SESSION.lifetimeMs,
        note: deviceNote(req.headers['user-agent']),
      };
      await store.sessions.create(session);
      ctx.setSessionCookie(res, token);
      ctx.pruneSoon();
      return { ...session, createdAt: at, renewedAt: at, lastUsedAt: at };
    },

    /** Deletes expired sessions and sign-ins, at most every 10 minutes, without holding up the request. */
    pruneSoon() {
      const t = now();
      if (t - lastPrune < PRUNE_EVERY_MS) return;
      lastPrune = t;
      Promise.all([store.sessions.prune(t), store.signIns.prune(t)]).catch((err) => {
        log(`prune failed ${err?.code || err?.name || 'Error'}`);
      });
    },

    /**
     * The session behind a request's bq_s cookie.
     * -> null                                      no cookie, or accounts are off, or the cookie is not a live
     *                                              session (the cookie is then cleared)
     * -> { error: 'bad_origin', status: 403 }      live session, not GET/HEAD, and clientCheck failed
     * -> { error: 'disabled', status: 403 }        the account is disabled
     * -> { session, account, tokenHash }           renewed (cookie re-set) when due; last-used times touched
     */
    async sessionFromRequest(req, res) {
      if (!enabled) return null;
      const hadCookie = typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${SESSION.cookie}=`);
      const token = tokenFromCookie(req);
      if (!token) {
        if (hadCookie) ctx.clearSessionCookie(res);
        return null;
      }
      const tokenHash = sha256Hex(token);
      const t = now();
      const session = await store.sessions.get(tokenHash);
      if (!session || session.expiresAt <= t) {
        if (session) await store.sessions.delete(tokenHash);
        ctx.clearSessionCookie(res);
        return null;
      }
      const account = await store.accounts.byId(session.accountId);
      if (!account) {
        await store.sessions.delete(tokenHash);
        ctx.clearSessionCookie(res);
        return null;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !ctx.clientCheck(req)) {
        return { error: 'bad_origin', status: 403 };
      }
      if (account.status !== 'active') return { error: 'disabled', status: 403 };
      if (t - session.renewedAt >= SESSION.renewAfterMs) {
        const expiresAt = t + SESSION.lifetimeMs;
        await store.sessions.renew(tokenHash, { at: t, expiresAt });
        Object.assign(session, { renewedAt: t, lastUsedAt: t, expiresAt });
        ctx.setSessionCookie(res, token);
        await store.accounts.touch(account.id, t);
      } else if (t - session.lastUsedAt >= SESSION.touchAfterMs) {
        await store.sessions.touch(tokenHash, t);
        session.lastUsedAt = t;
        await store.accounts.touch(account.id, t);
      }
      return { session, account, tokenHash };
    },

    /**
     * Who a request belongs to: the one place that decides it.
     * -> { owner: { kind: 'account', id, account, session } }  a live bq_s cookie (wins over a Bearer code)
     * -> { owner: { kind: 'guest', id } }                      a valid Authorization: Bearer <sync code>,
     *                                                          id = sha256(normalised code), as today
     * -> { owner: null }                                       neither
     * -> { error, status }                                     'bad_origin' / 'disabled' (403) from the cookie,
     *                                                          or 'bad_key' (401): an Authorization header
     *                                                          that is not a valid code, with no session
     */
    async resolveOwner(req, res) {
      const s = await ctx.sessionFromRequest(req, res);
      if (s?.error) return s;
      if (s) return { owner: { kind: 'account', id: s.account.id, account: s.account, session: s.session } };
      if (req.headers.authorization !== undefined) {
        const key = keyFromRequest(req);
        if (!key) return { error: 'bad_key', status: 401 };
        return { owner: { kind: 'guest', id: saveIdForKey(key) } };
      }
      return { owner: null };
    },

    /** The tool groups an account gets: player none; tester settings.tester_tools + its own; admin all. */
    async toolsFor(account) {
      if (!account) return [];
      if (account.role === 'admin') return [...TOOL_GROUPS];
      if (account.role !== 'tester') return [];
      const stored = await store.settings.get('tester_tools');
      const base = Array.isArray(stored) ? stored : DEFAULT_TESTER_TOOLS;
      const set = new Set([...base, ...(account.tools ?? [])]);
      return TOOL_GROUPS.filter((g) => set.has(g));
    },

    /** The public `me`: { id, email, name, role, tools, hasPassword, created }. */
    async me(account) {
      return {
        id: account.id,
        email: account.email,
        name: account.displayName,
        role: account.role,
        tools: await ctx.toolsFor(account),
        hasPassword: Boolean(account.passwordHash),
        created: account.createdAt,
      };
    },

    /** Writes one audit row. */
    async audit({ adminEmail, action, accountId = null, detail = {} }) {
      await store.audit.add({ at: now(), adminEmail, action, accountId, detail });
    },
  };
  return ctx;
}
