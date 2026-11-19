// Sign-in, sessions and the account routes (in-memory store). Spec: ACCOUNTS.md (sections 0, 1, 2, 3, 5).
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { startServer, freshKey } from './_helpers.js';
import {
  APP_URL, GAME, ITCH, SUPER, freshEmail, freshIp, sha256, startAccounts, tick,
} from './_accounts.js';
import { createApp, isAccountPath } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { accountsConfigFromEnv } from '../src/accounts/config.js';
import { createHasher, checkNewPassword } from '../src/accounts/crypto.js';
import { createFakeMailer, createResendMailer } from '../src/accounts/mailer.js';
import { accountDeletedEmail, passwordChangedEmail, signInEmail } from '../src/accounts/emails.js';
import { deviceNote, normaliseEmail, tokenFromCookie } from '../src/accounts/context.js';
import { ACCOUNT_LIMITS, SESSION, SIGN_IN, TOOL_GROUPS } from '../src/accounts/limits.js';

const DAY = 86_400_000;
const MIN = 60_000;
const ACCOUNT_PATHS = ['/v1/auth/start', '/v1/auth/code', '/v1/auth/link', '/v1/auth/password', '/v1/auth/signout', '/v1/me', '/v1/saves', '/v1/saves/1', '/v1/auth/nope'];

// ---------------------------------------------------------------------------
describe('the switches', () => {
  test('accounts off: every account path answers 503 accounts_off, guests are unchanged', async () => {
    const s = await startAccounts({ accounts: { enabled: false } });
    try {
      for (const path of ACCOUNT_PATHS) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          const r = await s.api(path, { method, body: method === 'GET' ? undefined : {} });
          assert.equal(r.status, 503, `${method} ${path}`);
          assert.deepEqual(r.body, { error: 'accounts_off' });
          assert.equal(r.headers.get('cache-control'), 'no-store');
        }
      }
      // Preflight still answers, so the browser can read the 503.
      const pre = await s.api('/v1/me', { method: 'OPTIONS', client: false });
      assert.equal(pre.status, 204);
      // Guest routes keep today's CORS headers exactly while accounts are off.
      const key = freshKey();
      const put = await fetch(`${s.url}/v1/save`, {
        method: 'PUT', headers: { Authorization: `Bearer ${key}`, Origin: GAME, 'X-Forwarded-For': freshIp() },
        body: JSON.stringify({ v: 1, at: 5, objective: 'o', save: 'x' }),
      });
      assert.equal(put.status, 200);
      assert.equal(put.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
      assert.equal(put.headers.get('access-control-allow-methods'), 'GET, PUT, POST, OPTIONS');
      assert.equal(put.headers.get('access-control-allow-credentials'), null);
      // A cookie is ignored entirely while off.
      assert.deepEqual(await s.app.accounts.resolveOwner({ headers: { cookie: `bq_s=${'a'.repeat(43)}` }, method: 'GET' }, { setHeader() {} }), { owner: null });
    } finally {
      await s.close();
    }
  });

  test('without an accounts config the service is the guest-only service (no account paths)', async () => {
    const s = await startServer();
    try {
      for (const path of ['/v1/me', '/v1/auth/start', '/v1/saves', '/admin/v1/accounts']) {
        assert.equal((await fetch(`${s.url}${path}`)).status, 404, path);
      }
      assert.equal(s.app.accounts, null);
    } finally {
      await s.close();
    }
  });

  test('accountsConfigFromEnv: on only with ACCOUNTS=on, APP_URL, SESSION_SECRET and a mail sender', () => {
    const full = {
      ACCOUNTS: 'on', APP_URL: 'https://game.example', SESSION_SECRET: 'x'.repeat(32), RESEND_API_KEY: 're_123', MAIL_FROM: 'A <a@b.example>',
    };
    const on = accountsConfigFromEnv(full);
    assert.equal(on.enabled, true);
    assert.equal(on.mailer.kind, 'resend');
    assert.equal(on.cookieInsecure, false);
    assert.equal(on.admin, null);
    for (const drop of Object.keys(full)) {
      const env = { ...full };
      delete env[drop];
      const c = accountsConfigFromEnv(env);
      assert.equal(c.enabled, false, drop);
      assert.ok(c.problems.length > 0);
      // Problems name settings, never values.
      assert.ok(!c.problems.join(' ').includes('re_123') && !c.problems.join(' ').includes('x'.repeat(32)));
    }
    assert.equal(accountsConfigFromEnv({ ...full, ACCOUNTS: 'off' }).enabled, false);
    assert.equal(accountsConfigFromEnv({ ...full, SESSION_SECRET: 'short' }).enabled, false);
    const fake = accountsConfigFromEnv({ ACCOUNTS: 'on', APP_URL: 'http://localhost:8996/', SESSION_SECRET: 'y'.repeat(40), MAIL_FAKE: '1', COOKIE_INSECURE: '1' });
    assert.equal(fake.enabled, true);
    assert.equal(fake.mailer.kind, 'fake');
    assert.equal(fake.cookieInsecure, true);
    assert.deepEqual(accountsConfigFromEnv({ SUPER_ADMIN_EMAILS: ' Boss@Example.test, b@c.d ,' }).superAdminEmails, ['boss@example.test', 'b@c.d']);
    assert.deepEqual(accountsConfigFromEnv({ ADMIN_API_KEY: 'k'.repeat(32) }).admin, { apiKey: 'k'.repeat(32) });
    const short = accountsConfigFromEnv({ ADMIN_API_KEY: 'k'.repeat(31) });
    assert.equal(short.admin, null);
    assert.equal(short.adminKeyTooShort, true);
  });

  test('isAccountPath', () => {
    for (const p of ACCOUNT_PATHS) assert.ok(isAccountPath(p), p);
    for (const p of ['/v1/save', '/v1/record', '/v1/board', '/v1/mee', '/v1/savesx', '/health', '/v1/authx']) assert.ok(!isAccountPath(p), p);
  });
});

// ---------------------------------------------------------------------------
describe('sign-in by link and code', () => {
  let s;
  before(async () => { s = await startAccounts(); });
  after(() => s.close());

  test('start: 200 {ok, id} for any well-formed address, the same for new and existing accounts', async () => {
    const existing = freshEmail();
    await s.signIn(existing);
    const a = await s.api('/v1/auth/start', { method: 'POST', body: { email: existing } });
    const b = await s.api('/v1/auth/start', { method: 'POST', body: { email: freshEmail() } });
    for (const r of [a, b]) {
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ['id', 'ok']);
      assert.equal(r.body.ok, true);
      assert.match(r.body.id, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(r.cookie, null);
    }
    // A disabled account gets the same answer.
    const dis = freshEmail();
    const acct = await s.store.accounts.signIn(dis, { at: s.clock.t });
    await s.store.accounts.update(acct.id, { status: 'disabled' });
    const c = await s.api('/v1/auth/start', { method: 'POST', body: { email: dis } });
    assert.equal(c.status, 200);
    assert.deepEqual(Object.keys(c.body).sort(), ['id', 'ok']);
  });

  test('start: a malformed address is 400 bad_email; a bad body is 400 bad_request', async () => {
    for (const email of ['', 'no-at', 'a@b', 'a b@c.de', '<x>@y.zz', 42, null, 'x'.repeat(250) + '@e.co']) {
      const r = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
      assert.equal(r.status, 400, String(email));
      assert.deepEqual(r.body, { error: 'bad_email' });
    }
    assert.equal((await s.api('/v1/auth/start', { method: 'POST', body: 'not json' })).body.error, 'bad_request');
  });

  test('start: one email holding the link and the six-digit code; the address is cleaned', async () => {
    const email = freshEmail();
    const before = s.mailer.sent.length;
    const r = await s.api('/v1/auth/start', { method: 'POST', body: { email: `  ${email.toUpperCase()} ` } });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(s.mailer.sent.length, before + 1);
    const msg = s.mailer.last();
    assert.equal(msg.to, email);
    const token = s.tokenFrom(msg);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(msg.text.includes(`${APP_URL}?signin=${token}`));
    assert.ok(msg.html.includes(`${APP_URL}?signin=${token}`));
    const code = s.codeFrom(msg);
    assert.ok(msg.html.includes(`>${code}<`));
    assert.match(msg.text, /expire in 15 minutes/);
    assert.match(msg.text, /didn't ask for this, ignore/);
    // The store holds neither the code nor the token.
    const row = s.store._mem.signIns.get(r.body.id);
    assert.equal(row.email, email);
    assert.ok(!JSON.stringify(row).includes(token) && !JSON.stringify(row).includes(code));
  });

  test('code: right code signs in and creates the account (role player)', async () => {
    const email = freshEmail();
    const start = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code: s.codeFrom(s.mailer.last(email)) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(Object.keys(r.body.me).sort(), ['created', 'email', 'hasPassword', 'id', 'name', 'role', 'tools']);
    assert.deepEqual(
      { ...r.body.me, id: undefined },
      { id: undefined, email, name: '', role: 'player', tools: [], hasPassword: false, created: s.clock.t },
    );
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    const me = await s.api('/v1/me', { cookie: r.token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, r.body.me);
    // Signing in again finds the same account.
    const again = await s.signIn(email);
    assert.equal(again.id, r.body.me.id);
  });

  test('code: wrong codes say how many tries are left; after five the sign-in is dead', async () => {
    const email = freshEmail();
    const start = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const right = s.codeFrom(s.mailer.last(email));
    const wrong = right === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 0; left--) {
      const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code: wrong } });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'bad_code', left });
      assert.equal(r.cookie, null);
    }
    const late = await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code: right } });
    assert.equal(late.status, 410);
    assert.deepEqual(late.body, { error: 'expired' });
    assert.equal(await s.store.accounts.byEmail(email), null);
  });

  test('code: a malformed code costs a try like a wrong one', async () => {
    const email = freshEmail();
    const start = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code: '12a' } });
    assert.deepEqual(r.body, { error: 'bad_code', left: 4 });
  });

  test('code: parallel guesses get at most five comparisons', async () => {
    const email = freshEmail();
    const start = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const right = s.codeFrom(s.mailer.last(email));
    const wrongs = Array.from({ length: 12 }, (_, i) => String((Number(right) + 1 + i) % 1_000_000).padStart(6, '0'));
    const rs = await Promise.all(wrongs.map((code) => s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code } })));
    assert.equal(rs.filter((r) => r.status === 400).length, 5);
    assert.equal(rs.filter((r) => r.status === 410).length, 7);
  });

  test('code: unknown ids, used codes and expired codes are 410 expired', async () => {
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: 'AAAAAAAAAAAAAAAAAAAAAA', code: '123456' } })).status, 410);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: '../x', code: '123456' } })).status, 410);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { code: '123456' } })).status, 410);
    const email = freshEmail();
    const start = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const code = s.codeFrom(s.mailer.last(email));
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code } })).status, 200);
    const reuse = await s.api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code } });
    assert.equal(reuse.status, 410);
    // Expiry: 15 minutes.
    const e2 = freshEmail();
    const st2 = await s.api('/v1/auth/start', { method: 'POST', body: { email: e2 } });
    await tick();
    const msg = s.mailer.last(e2);
    s.clock.advance(SIGN_IN.lifetimeMs);
    assert.deepEqual((await s.api('/v1/auth/code', { method: 'POST', body: { id: st2.body.id, code: s.codeFrom(msg) } })).body, { error: 'expired' });
    assert.deepEqual((await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } })).body, { error: 'expired' });
  });

  test('code just inside 15 minutes still works', async () => {
    const email = freshEmail();
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    s.clock.advance(SIGN_IN.lifetimeMs - 1000);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(s.mailer.last(email)) } })).status, 200);
  });

  test('link: signs in once; then it, and the code from the same email, are spent', async () => {
    const email = freshEmail();
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const msg = s.mailer.last(email);
    const r = await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } });
    assert.equal(r.status, 200);
    assert.equal(r.body.me.email, email);
    assert.ok(r.token);
    assert.equal((await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } })).status, 410);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(msg) } })).status, 410);
  });

  test('code first spends the link', async () => {
    const email = freshEmail();
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const msg = s.mailer.last(email);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(msg) } })).status, 200);
    assert.deepEqual((await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } })).body, { error: 'expired' });
  });

  test('a successful sign-in also retires the other sign-in emails still waiting for that address', async () => {
    const email = freshEmail();
    await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const first = s.mailer.last(email);
    const st2 = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const second = s.mailer.last(email);
    assert.equal((await s.api('/v1/auth/code', { method: 'POST', body: { id: st2.body.id, code: s.codeFrom(second) } })).status, 200);
    assert.equal((await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(first) } })).status, 410);
  });

  test('link: malformed or unknown tokens are 410 expired', async () => {
    for (const token of [undefined, '', 'short', 'x'.repeat(43), 'a'.repeat(44), 5]) {
      const r = await s.api('/v1/auth/link', { method: 'POST', body: { token } });
      assert.equal(r.status, 410, String(token));
    }
  });

  test('a disabled account cannot sign in by code or link (403 disabled, no cookie)', async () => {
    const email = freshEmail();
    const a = await s.store.accounts.signIn(email, { at: s.clock.t });
    await s.store.accounts.update(a.id, { status: 'disabled' });
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(s.mailer.last(email)) } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: 'disabled' });
    assert.equal(r.token, null);
  });

  test('a mail failure is logged without the address and does not change the answer', async () => {
    const t = await startAccounts();
    try {
      t.mailer.fail(true);
      const email = freshEmail();
      const r = await t.api('/v1/auth/start', { method: 'POST', body: { email } });
      assert.equal(r.status, 200);
      await tick();
      await tick();
      const lines = t.logs.join('\n');
      assert.match(lines, /mail failed \(sign-in\) mail_fake/);
      assert.ok(!lines.includes(email) && !lines.includes(email.split('@')[0]));
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('sign-in limits', () => {
  test('start: 5 an hour per address (then 200 and no email), 20 an hour per client (then 429 + Retry-After)', async () => {
    const s = await startAccounts();
    try {
      const email = freshEmail();
      const ips = Array.from({ length: 7 }, freshIp);
      for (let i = 0; i < 7; i++) {
        const r = await s.api('/v1/auth/start', { method: 'POST', body: { email }, ip: ips[i] });
        assert.equal(r.status, 200);
      }
      await tick();
      assert.equal(s.mailer.sent.filter((m) => m.to === email).length, ACCOUNT_LIMITS.startPerEmail.max);
      // The sixth answer's id leads nowhere.
      const ip = freshIp();
      for (let i = 0; i < ACCOUNT_LIMITS.startPerIp.max; i++) {
        assert.equal((await s.api('/v1/auth/start', { method: 'POST', body: { email: freshEmail() }, ip })).status, 200);
      }
      const over = await s.api('/v1/auth/start', { method: 'POST', body: { email: freshEmail() }, ip });
      assert.equal(over.status, 429);
      assert.deepEqual(over.body, { error: 'rate_limited' });
      assert.ok(Number(over.headers.get('retry-after')) > 0);
      assert.equal(over.headers.get('access-control-expose-headers'), 'Retry-After');
      // An hour later both limits have cleared.
      s.clock.advance(60 * MIN);
      assert.equal((await s.api('/v1/auth/start', { method: 'POST', body: { email: freshEmail() }, ip })).status, 200);
      const before = s.mailer.sent.length;
      await s.api('/v1/auth/start', { method: 'POST', body: { email }, ip: freshIp() });
      await tick();
      assert.equal(s.mailer.sent.length, before + 1);
    } finally {
      await s.close();
    }
  });

  test('password: 10 per 15 minutes per address + client, 30 per client', async () => {
    const s = await startAccounts({ accounts: { hasher: createHasher({ params: { N: 1024, r: 8, p: 1, keyLen: 32, saltBytes: 16 } }) } });
    try {
      const email = freshEmail();
      const ip = freshIp();
      for (let i = 0; i < ACCOUNT_LIMITS.passwordPerEmailIp.max; i++) {
        assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'wrong-password-1' }, ip })).status, 401);
      }
      const over = await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'wrong-password-1' }, ip });
      assert.equal(over.status, 429);
      assert.ok(Number(over.headers.get('retry-after')) > 0);
      // The same address from another client is still allowed.
      assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'x'.repeat(12) } })).status, 401);
      // Per client: 30 whatever the address (10 used above).
      for (let i = 0; i < ACCOUNT_LIMITS.passwordPerIp.max - ACCOUNT_LIMITS.passwordPerEmailIp.max - 1; i++) {
        assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email: freshEmail(), password: 'wrong-password-1' }, ip })).status, 401);
      }
      assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email: freshEmail(), password: 'wrong-password-1' }, ip })).status, 429);
      s.clock.advance(15 * MIN);
      assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'wrong-password-1' }, ip })).status, 401);
    } finally {
      await s.close();
    }
  });

  test('code + link: 60 attempts per 15 minutes per client', async () => {
    const s = await startAccounts({ accounts: { limits: { attemptsPerIp: { max: 3 } } } });
    try {
      const ip = freshIp();
      for (let i = 0; i < 3; i++) assert.equal((await s.api('/v1/auth/link', { method: 'POST', body: { token: 'x' }, ip })).status, 410);
      const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: 'AAAAAAAAAAAA', code: '123456' }, ip });
      assert.equal(r.status, 429);
      assert.ok(r.headers.get('retry-after'));
      assert.equal(ACCOUNT_LIMITS.attemptsPerIp.max, 60);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('sessions and cookies', () => {
  let s;
  before(async () => { s = await startAccounts(); });
  after(() => s.close());

  test('the cookie: bq_s, HttpOnly, Secure, SameSite=Lax, Path=/, 60 days, no Domain; only its hash is stored', async () => {
    const email = freshEmail();
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(s.mailer.last(email)) } });
    assert.match(r.cookie, /^bq_s=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=5184000; HttpOnly; Secure; SameSite=Lax$/);
    assert.ok(!/domain/i.test(r.cookie));
    assert.equal(SESSION.lifetimeMs / 1000, 5184000);
    const sessions = [...s.store._mem.sessions.values()];
    const mine = sessions.find((x) => x.tokenHash === sha256(r.token));
    assert.ok(mine);
    assert.equal(mine.expiresAt, s.clock.t + 60 * DAY);
    assert.ok(!JSON.stringify(sessions).includes(r.token));
  });

  test('COOKIE_INSECURE drops only Secure', async () => {
    const t = await startAccounts({ accounts: { cookieInsecure: true } });
    try {
      const { token } = await t.signIn(freshEmail());
      const out = await t.api('/v1/auth/signout', { method: 'POST', cookie: token });
      assert.equal(out.cookie, 'bq_s=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      const me = await t.signIn(freshEmail());
      assert.ok(me.token);
    } finally {
      await t.close();
    }
  });

  test('the session note is a short device label, not the User-Agent', async () => {
    const email = freshEmail();
    const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
    await tick();
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
    const r = await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: s.codeFrom(s.mailer.last(email)) }, headers: { 'User-Agent': ua } });
    assert.equal((await s.store.sessions.get(sha256(r.token))).note, 'Chrome on Android');
    assert.equal(deviceNote('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
    assert.equal(deviceNote('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox on Windows');
    assert.equal(deviceNote(undefined), '');
  });

  test('rolling renewal: re-set after a day, extended to 60 days from then; quiet before that', async () => {
    const { token } = await s.signIn(freshEmail());
    const h = sha256(token);
    const t0 = s.clock.t;
    s.clock.advance(23 * 60 * MIN);
    const early = await s.api('/v1/me', { cookie: token });
    assert.equal(early.status, 200);
    assert.equal(early.cookie, null);
    assert.equal((await s.store.sessions.get(h)).expiresAt, t0 + 60 * DAY);
    s.clock.advance(61 * MIN); // just over a day since sign-in
    const renewed = await s.api('/v1/me', { cookie: token });
    assert.equal(renewed.status, 200);
    assert.match(renewed.cookie, new RegExp(`^bq_s=${token}; Path=/; Max-Age=5184000; HttpOnly; Secure; SameSite=Lax$`));
    const row = await s.store.sessions.get(h);
    assert.equal(row.expiresAt, s.clock.t + 60 * DAY);
    assert.equal(row.renewedAt, s.clock.t);
    assert.equal(row.createdAt, t0);
    assert.equal((await s.api('/v1/me', { cookie: token })).cookie, null);
  });

  test('a regular player stays signed in past 60 days; an idle one is signed out at 60 days', async () => {
    const regular = await s.signIn(freshEmail());
    const idle = await s.signIn(freshEmail());
    for (let i = 0; i < 4; i++) {
      s.clock.advance(30 * DAY);
      assert.equal((await s.api('/v1/me', { cookie: regular.token })).status, 200);
    }
    const r = await s.api('/v1/me', { cookie: idle.token });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: 'signed_out' });
    assert.equal(r.cookie, 'bq_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    assert.equal(await s.store.sessions.get(sha256(idle.token)), null);
  });

  test('last_used_at and last_seen_at move, at most every few minutes', async () => {
    const { token, id } = await s.signIn(freshEmail());
    const h = sha256(token);
    const t0 = s.clock.t;
    s.clock.advance(MIN);
    await s.api('/v1/me', { cookie: token });
    assert.equal((await s.store.sessions.get(h)).lastUsedAt, t0);
    s.clock.advance(SESSION.touchAfterMs);
    await s.api('/v1/me', { cookie: token });
    assert.equal((await s.store.sessions.get(h)).lastUsedAt, s.clock.t);
    assert.equal((await s.store.accounts.byId(id)).lastSeenAt, s.clock.t);
  });

  test('a missing, malformed or unknown cookie is 401 signed_out (a bad cookie is also cleared)', async () => {
    const none = await s.api('/v1/me');
    assert.deepEqual([none.status, none.body, none.cookie], [401, { error: 'signed_out' }, null]);
    for (const c of ['bq_s=nope', `bq_s=${'a'.repeat(43)}`]) {
      const r = await s.api('/v1/me', { headers: { Cookie: c } });
      assert.equal(r.status, 401);
      assert.match(r.cookie, /^bq_s=; Path=\/; Max-Age=0/);
    }
    assert.equal(tokenFromCookie({ headers: { cookie: `x=1; bq_s=${'b'.repeat(43)}; y=2` } }), 'b'.repeat(43));
    assert.equal(tokenFromCookie({ headers: { cookie: 'bq_sx=1' } }), null);
  });

  test('a disabled account\'s session is 403 disabled', async () => {
    const { token, id } = await s.signIn(freshEmail());
    await s.store.accounts.update(id, { status: 'disabled' });
    const r = await s.api('/v1/me', { cookie: token });
    assert.deepEqual([r.status, r.body], [403, { error: 'disabled' }]);
  });
});

// ---------------------------------------------------------------------------
describe('CORS and the X-BQ-Client / Origin check', () => {
  let s;
  before(async () => { s = await startAccounts(); });
  after(() => s.close());

  test('exactly-listed origins get credentials on account paths; wildcard ones never do', async () => {
    const exact = await s.api('/v1/me', { client: false });
    assert.equal(exact.headers.get('access-control-allow-origin'), GAME);
    assert.equal(exact.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(exact.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, X-BQ-Client');
    assert.equal(exact.headers.get('access-control-allow-methods'), 'GET, PUT, POST, DELETE, OPTIONS');
    assert.equal(exact.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal(exact.headers.get('vary'), 'Origin');
    for (const origin of [ITCH, 'http://localhost:8996']) {
      const wild = await s.api('/v1/me', { origin, client: false });
      assert.equal(wild.headers.get('access-control-allow-origin'), origin);
      assert.equal(wild.headers.get('access-control-allow-credentials'), null, origin);
    }
    const refused = await s.api('/v1/me', { origin: 'https://evil.example' });
    assert.deepEqual([refused.status, refused.body], [403, { error: 'origin_not_allowed' }]);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
  });

  test('preflight on account paths is 204 with credentials for an exact origin', async () => {
    const r = await s.api('/v1/auth/code', {
      method: 'OPTIONS', client: false,
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-bq-client' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
    assert.match(r.headers.get('access-control-allow-headers'), /X-BQ-Client/);
    const p2 = await s.api('/v1/me', { method: 'OPTIONS', client: false, origin: ITCH });
    assert.equal(p2.status, 204);
    assert.equal(p2.headers.get('access-control-allow-credentials'), null);
  });

  test('while accounts are on, guest /v1 paths also allow the header and credentials (the game sends both)', async () => {
    for (const path of ['/v1/save', '/v1/record', '/v1/board']) {
      const r = await s.api(path, { method: 'OPTIONS', client: false });
      assert.equal(r.status, 204, path);
      assert.equal(r.headers.get('access-control-allow-credentials'), 'true');
      assert.equal(r.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, X-BQ-Client');
      const w = await s.api(path, { method: 'OPTIONS', client: false, origin: ITCH });
      assert.equal(w.headers.get('access-control-allow-credentials'), null);
    }
    // /health keeps its plain headers.
    const h = await s.api('/health', { client: false });
    assert.equal(h.headers.get('access-control-allow-credentials'), null);
  });

  test('cookie writes need X-BQ-Client: 1 and an exactly-listed Origin, else 403 bad_origin', async () => {
    const { token } = await s.signIn(freshEmail());
    const cases = [
      { client: false },
      { origin: null },
      { origin: ITCH },
      { headers: { 'X-BQ-Client': '0' }, client: false },
    ];
    for (const c of cases) {
      for (const [method, path, body] of [['PUT', '/v1/me', { name: 'Zed Keeper' }], ['DELETE', '/v1/me'], ['POST', '/v1/auth/signout', {}]]) {
        const r = await s.api(path, { method, body, cookie: token, ...c });
        assert.equal(r.status, 403, `${method} ${path} ${JSON.stringify(c)}`);
        assert.deepEqual(r.body, { error: 'bad_origin' });
      }
    }
    // Nothing happened.
    assert.equal((await s.api('/v1/me', { cookie: token })).body.name, '');
    // Reads do not need it.
    assert.equal((await s.api('/v1/me', { cookie: token, client: false })).status, 200);
    assert.equal((await s.api('/v1/me', { cookie: token, client: false, origin: null })).status, 200);
  });

  test('the routes that create a session need the check too', async () => {
    for (const path of ['/v1/auth/code', '/v1/auth/link', '/v1/auth/password']) {
      for (const c of [{ client: false }, { origin: null }, { origin: ITCH }]) {
        const r = await s.api(path, { method: 'POST', body: {}, ...c });
        assert.deepEqual([r.status, r.body], [403, { error: 'bad_origin' }], `${path} ${JSON.stringify(c)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the owner resolver', () => {
  let s;
  before(async () => { s = await startAccounts(); });
  after(() => s.close());
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

  test('account by cookie, else guest by Bearer code exactly as today, account wins when both', async () => {
    const ctx = s.app.accounts;
    const { token, id } = await s.signIn(freshEmail());
    const key = 'abcd-efgh-jkmn-pqrs';
    const guestId = sha256('ABCDEFGHJKMNPQRS');

    const a = await ctx.resolveOwner({ method: 'GET', headers: { cookie: `bq_s=${token}` } }, res());
    assert.equal(a.owner.kind, 'account');
    assert.equal(a.owner.id, id);
    assert.equal(a.owner.account.id, id);
    assert.ok(a.owner.session.createdAt);

    const g = await ctx.resolveOwner({ method: 'PUT', headers: { authorization: `Bearer ${key}` } }, res());
    assert.deepEqual(g, { owner: { kind: 'guest', id: guestId } });

    const both = await ctx.resolveOwner({ method: 'GET', headers: { cookie: `bq_s=${token}`, authorization: `Bearer ${key}` } }, res());
    assert.equal(both.owner.kind, 'account');
    // A malformed code does not matter when the cookie is good.
    const bothBad = await ctx.resolveOwner({ method: 'GET', headers: { cookie: `bq_s=${token}`, authorization: 'Bearer nope' } }, res());
    assert.equal(bothBad.owner.kind, 'account');

    assert.deepEqual(await ctx.resolveOwner({ method: 'GET', headers: {} }, res()), { owner: null });
    assert.deepEqual(await ctx.resolveOwner({ method: 'GET', headers: { authorization: 'Bearer nope' } }, res()), { error: 'bad_key', status: 401 });
    // A dead cookie falls back to the code.
    const dead = await ctx.resolveOwner({ method: 'GET', headers: { cookie: `bq_s=${'z'.repeat(43)}`, authorization: `Bearer ${key}` } }, res());
    assert.deepEqual(dead, { owner: { kind: 'guest', id: guestId } });
  });

  test('a cookie write without the client check is bad_origin; a disabled account is disabled', async () => {
    const ctx = s.app.accounts;
    const { token, id } = await s.signIn(freshEmail());
    const w = await ctx.resolveOwner({ method: 'PUT', headers: { cookie: `bq_s=${token}`, authorization: 'Bearer ABCDEFGHJKMNPQRS' } }, res());
    assert.deepEqual(w, { error: 'bad_origin', status: 403 });
    const ok = await ctx.resolveOwner({ method: 'PUT', headers: { cookie: `bq_s=${token}`, 'x-bq-client': '1', origin: GAME } }, res());
    assert.equal(ok.owner.kind, 'account');
    await s.store.accounts.update(id, { status: 'disabled' });
    assert.deepEqual(await ctx.resolveOwner({ method: 'GET', headers: { cookie: `bq_s=${token}` } }, res()), { error: 'disabled', status: 403 });
  });
});

// ---------------------------------------------------------------------------
const FAST = () => createHasher({ params: { N: 1024, r: 8, p: 1, keyLen: 32, saltBytes: 16 } });

describe('passwords', () => {
  let s;
  before(async () => { s = await startAccounts(); }); // the real scrypt cost
  after(() => s.close());

  test('set a first password (fresh session), then sign in with it', async () => {
    const email = freshEmail();
    const { token } = await s.signIn(email);
    const other = await s.signIn(email);
    const before = s.mailer.sent.length;
    const r = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'correct horse battery' } } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.me.hasPassword, true);
    const stored = (await s.store.accounts.byEmail(email)).passwordHash;
    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.ok(!stored.includes('correct horse'));
    // The other session ended; this one did not. The "password changed" email went out.
    assert.equal((await s.api('/v1/me', { cookie: other.token })).status, 401);
    assert.equal((await s.api('/v1/me', { cookie: token })).status, 200);
    await tick();
    assert.equal(s.mailer.sent.length, before + 1);
    assert.equal(s.mailer.last(email).subject, passwordChangedEmail().subject);

    const login = await s.api('/v1/auth/password', { method: 'POST', body: { email: email.toUpperCase(), password: 'correct horse battery' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.me.email, email);
    assert.ok(login.token);
  });

  test('every password sign-in failure is the same 401 bad_login', async () => {
    const withPw = freshEmail();
    const { token } = await s.signIn(withPw);
    await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'a fine long password' } } });
    const noPw = freshEmail();
    await s.signIn(noPw);
    const disabled = freshEmail();
    const d = await s.signIn(disabled);
    await s.api('/v1/me', { method: 'PUT', cookie: d.token, body: { password: { new: 'a fine long password' } } });
    await s.store.accounts.update(d.id, { status: 'disabled' });
    const cases = [
      { email: withPw, password: 'the wrong password' },
      { email: freshEmail(), password: 'a fine long password' },
      { email: noPw, password: 'a fine long password' },
      { email: noPw, password: '' },
      { email: disabled, password: 'a fine long password' },
      { email: 'not an email', password: 'a fine long password' },
      { email: withPw },
    ];
    for (const body of cases) {
      const r = await s.api('/v1/auth/password', { method: 'POST', body });
      assert.equal(r.status, 401, JSON.stringify(body));
      assert.deepEqual(r.body, { error: 'bad_login' });
      assert.equal(r.cookie, null);
    }
  });

  test('weak passwords are 400 weak_password', async () => {
    const { token } = await s.signIn(freshEmail());
    for (const pw of ['short', '123456789', 'password123', 'Password123', 'aaaaaaaaaaaa', 'x'.repeat(201), 12345678901, null]) {
      const r = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: pw } } });
      assert.equal(r.status, 400, String(pw));
      assert.deepEqual(r.body, { error: 'weak_password' });
    }
    assert.equal(checkNewPassword('ten chars!'), null);
    assert.equal(checkNewPassword('nine char'), 'weak_password');
    assert.equal(checkNewPassword('x'.repeat(200).replace(/^x/, 'y')), null);
  });

  test('reauth: a first password needs a session made in the last 15 minutes', async () => {
    const { token } = await s.signIn(freshEmail());
    s.clock.advance(SESSION.freshMs + 1000);
    const r = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'a fine long password' } } });
    assert.deepEqual([r.status, r.body], [403, { error: 'reauth' }]);
  });

  test('changing a password needs the current one (not a fresh session)', async () => {
    const email = freshEmail();
    const { token } = await s.signIn(email);
    await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'first long password' } } });
    s.clock.advance(DAY * 2);
    const missing = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'second long password' } } });
    assert.deepEqual([missing.status, missing.body], [401, { error: 'bad_login' }]);
    const wrong = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'second long password', current: 'not it at all' } } });
    assert.deepEqual([wrong.status, wrong.body], [401, { error: 'bad_login' }]);
    // A failed change writes nothing, not even the name sent with it.
    const both = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { name: 'Halfway Keeper', password: { new: 'second long password', current: 'nope nope nope' } } });
    assert.equal(both.status, 401);
    assert.equal((await s.api('/v1/me', { cookie: token })).body.name, '');
    const ok = await s.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'second long password', current: 'first long password' } } });
    assert.equal(ok.status, 200);
    assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'first long password' } })).status, 401);
    assert.equal((await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'second long password' } })).status, 200);
  });

  test('the hasher caps concurrent work and refuses beyond its queue', async () => {
    const h = createHasher({ concurrent: 1, queue: 2, params: { N: 1024, r: 8, p: 1, keyLen: 32, saltBytes: 16 } });
    const runs = Array.from({ length: 5 }, (_, i) => h.hash(`password number ${i}`).then(() => 'ok', (e) => e.code));
    assert.equal(h.active, 1);
    assert.equal(h.waiting, 2);
    assert.deepEqual(await Promise.all(runs), ['ok', 'ok', 'ok', 'busy', 'busy']);
    const stored = await h.hash('round trip pw');
    assert.equal(await h.verify('round trip pw', stored), true);
    assert.equal(await h.verify('round trip px', stored), false);
    assert.equal(await h.verify('anything', null), false);
    assert.equal(await h.verify('anything', 'scrypt$999999999$8$1$AAAA$BBBB'), false); // absurd cost refused, not run
    assert.equal(await h.verify('anything', 'scrypt$garbage'), false);
  });

  test('a busy hasher answers 429 with Retry-After', async () => {
    const busy = { hash: async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); }, verify: async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); } };
    const t = await startAccounts({ accounts: { hasher: busy } });
    try {
      const r = await t.api('/v1/auth/password', { method: 'POST', body: { email: freshEmail(), password: 'whatever long' } });
      assert.equal(r.status, 429);
      assert.equal(r.headers.get('retry-after'), '2');
      const { token } = await t.signIn(freshEmail());
      const p = await t.api('/v1/me', { method: 'PUT', cookie: token, body: { password: { new: 'a fine long password' } } });
      assert.equal(p.status, 429);
    } finally {
      await t.close();
    }
  });

  test('a burst of password sign-ins all get an answer (queued or 429), none hang', async () => {
    const t = await startAccounts({ accounts: { hasher: createHasher({ concurrent: 1, queue: 3, params: { N: 1024, r: 8, p: 1, keyLen: 32, saltBytes: 16 } }) } });
    try {
      const rs = await Promise.all(Array.from({ length: 12 }, () =>
        t.api('/v1/auth/password', { method: 'POST', body: { email: freshEmail(), password: 'some long password' } })));
      const statuses = rs.map((r) => r.status);
      assert.ok(statuses.every((x) => x === 401 || x === 429), statuses.join(','));
      assert.ok(statuses.includes(429));
    } finally {
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('the account: name, roles, sign out, delete', () => {
  let s;
  before(async () => { s = await startAccounts({ accounts: { hasher: FAST() } }); });
  after(() => s.close());
  const put = (token, body) => s.api('/v1/me', { method: 'PUT', cookie: token, body });

  test('keeper name: the record name rules, unique across accounts and guests, "" clears', async () => {
    const a = await s.signIn(freshEmail());
    const b = await s.signIn(freshEmail());
    const r = await put(a.token, { name: '  Lamp   Keeper ' });
    assert.equal(r.status, 200);
    assert.equal(r.body.me.name, 'Lamp Keeper');
    for (const name of ['ab', 'x'.repeat(17), 'bad!name', '---', 'Sh1tKeeper', 7]) {
      const bad = await put(b.token, { name });
      assert.deepEqual([bad.status, bad.body], [400, { error: 'name_invalid' }], String(name));
    }
    assert.deepEqual((await put(b.token, { name: 'LAMP keeper' })).body, { error: 'name_taken' });
    // A guest's board name.
    s.store._records.set('guest-id-1', { id: 'guest-id-1', name: 'Fog Walker', nameKey: 'fog walker', hidden: false, bosses: {}, splits: {} });
    assert.equal((await put(b.token, { name: 'fog walker' })).status, 409);
    // null and absent keep the name; '' clears it and frees it.
    assert.equal((await put(a.token, { name: null })).body.me.name, 'Lamp Keeper');
    assert.equal((await put(a.token, {})).body.me.name, 'Lamp Keeper');
    assert.equal((await put(a.token, { name: '' })).body.me.name, '');
    assert.equal((await put(b.token, { name: 'Lamp Keeper' })).body.me.name, 'Lamp Keeper');
    assert.equal((await s.api('/v1/me', { cookie: b.token })).body.name, 'Lamp Keeper');
  });

  test("keeper name also updates the account's record row when there is one", async () => {
    const a = await s.signIn(freshEmail());
    const rid = `a:${a.id}`;
    s.store._records.set(rid, { id: rid, name: '', nameKey: '', hidden: false, bosses: {}, splits: {} });
    await put(a.token, { name: 'Tide Reader' });
    assert.deepEqual([s.store._records.get(rid).name, s.store._records.get(rid).nameKey], ['Tide Reader', 'tide reader']);
    await put(a.token, { name: '' });
    assert.equal(s.store._records.get(rid).name, '');
  });

  test('bad bodies are 400 bad_request', async () => {
    const a = await s.signIn(freshEmail());
    assert.equal((await put(a.token, 'nope')).status, 400);
    assert.deepEqual((await put(a.token, { password: 'flat' })).body, { error: 'bad_request' });
    assert.deepEqual((await put(a.token, { password: { new: 'a fine long password', current: 5 } })).body, { error: 'bad_request' });
    const big = await put(a.token, { name: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
  });

  test('roles and tools: player none, tester the shared set plus their own, admin all six', async () => {
    const p = await s.signIn(freshEmail());
    assert.deepEqual((await s.api('/v1/me', { cookie: p.token })).body.tools, []);
    await s.store.accounts.update(p.id, { role: 'tester' });
    let me = (await s.api('/v1/me', { cookie: p.token })).body;
    assert.deepEqual([me.role, me.tools], ['tester', ['start', 'give', 'map', 'teleport']]);
    await s.store.accounts.update(p.id, { tools: ['monsters', 'not-a-group'] });
    me = (await s.api('/v1/me', { cookie: p.token })).body;
    assert.deepEqual(me.tools, ['start', 'give', 'map', 'teleport', 'monsters']);
    await s.store.settings.set('tester_tools', ['cheats']);
    me = (await s.api('/v1/me', { cookie: p.token })).body;
    assert.deepEqual(me.tools, ['cheats', 'monsters']);
    await s.store.settings.set('tester_tools', ['start', 'give', 'map', 'teleport']);
    await s.store.accounts.update(p.id, { role: 'admin' });
    me = (await s.api('/v1/me', { cookie: p.token })).body;
    assert.deepEqual(me.tools, [...TOOL_GROUPS]);
    await s.store.accounts.update(p.id, { role: 'player' });
    assert.deepEqual((await s.api('/v1/me', { cookie: p.token })).body.tools, []);
  });

  test('super admins are made admin at every sign-in and cannot delete themselves', async () => {
    const boss = await s.signIn(SUPER.toUpperCase());
    assert.equal(boss.me.role, 'admin');
    assert.deepEqual(boss.me.tools, [...TOOL_GROUPS]);
    await s.store.accounts.update(boss.id, { role: 'player' }); // as if demoted by hand in the database
    const again = await s.signIn(SUPER);
    assert.equal(again.me.role, 'admin');
    const del = await s.api('/v1/me', { method: 'DELETE', cookie: again.token });
    assert.deepEqual([del.status, del.body], [409, { error: 'super' }]);
    assert.ok(await s.store.accounts.byId(boss.id));
    assert.equal(s.app.accounts.isSuper(await s.store.accounts.byId(boss.id)), true);
    assert.equal(s.app.accounts.isSuperEmail('someone@else.test'), false);
  });

  test('sign out here ends this session only; everywhere ends them all; both clear the cookie', async () => {
    const email = freshEmail();
    const one = await s.signIn(email);
    const two = await s.signIn(email);
    const three = await s.signIn(email);
    const out = await s.api('/v1/auth/signout', { method: 'POST', cookie: one.token });
    assert.deepEqual([out.status, out.body], [200, { ok: true }]);
    assert.equal(out.cookie, 'bq_s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
    assert.equal((await s.api('/v1/me', { cookie: one.token })).status, 401);
    assert.equal((await s.api('/v1/me', { cookie: two.token })).status, 200);
    const all = await s.api('/v1/auth/signout', { method: 'POST', cookie: two.token, body: { everywhere: true } });
    assert.equal(all.status, 200);
    assert.equal((await s.api('/v1/me', { cookie: two.token })).status, 401);
    assert.equal((await s.api('/v1/me', { cookie: three.token })).status, 401);
    assert.deepEqual(await s.store.sessions.listForAccount(one.id), []);
    // Signed out already: still 200, still clears.
    const again = await s.api('/v1/auth/signout', { method: 'POST' });
    assert.deepEqual([again.status, again.body], [200, { ok: true }]);
    assert.match(again.cookie, /Max-Age=0/);
  });

  test('delete my account removes the account, its saves, record, sessions and sign-ins, and emails', async () => {
    const email = freshEmail();
    const a = await s.signIn(email);
    const b = await s.signIn(email);
    await put(a.token, { name: 'Gone Soon' });
    const rid = `a:${a.id}`;
    s.store._records.set(rid, { id: rid, name: 'Gone Soon', nameKey: 'gone soon', hidden: false, bosses: {}, splits: {} });
    await s.store.slots.put(a.id, 1, { at: 1, objective: 'o', body: 'save' }, {});
    await s.store.slots.put(a.id, 2, { at: 1, objective: 'o', body: 'save' }, {});
    await s.api('/v1/auth/start', { method: 'POST', body: { email } }); // a sign-in still waiting
    const before = s.mailer.sent.length;
    const r = await s.api('/v1/me', { method: 'DELETE', cookie: a.token });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.match(r.cookie, /^bq_s=; Path=\/; Max-Age=0/);
    assert.equal(await s.store.accounts.byId(a.id), null);
    assert.equal(await s.store.slots.count(a.id), 0);
    assert.equal(s.store._records.has(rid), false);
    assert.deepEqual(await s.store.sessions.listForAccount(a.id), []);
    assert.equal([...s.store._mem.signIns.values()].filter((x) => x.email === email).length, 0);
    assert.equal((await s.api('/v1/me', { cookie: b.token })).status, 401);
    await tick();
    assert.equal(s.mailer.sent.length, before + 1);
    assert.equal(s.mailer.last(email).subject, accountDeletedEmail().subject);
    // The name is free again; signing in again makes a new, empty account.
    const c = await s.signIn(freshEmail());
    assert.equal((await put(c.token, { name: 'Gone Soon' })).status, 200);
    const back = await s.signIn(email);
    assert.notEqual(back.id, a.id);
    assert.equal(back.me.name, '');
  });

  test('delete needs a session made in the last 15 minutes (403 reauth)', async () => {
    const a = await s.signIn(freshEmail());
    s.clock.advance(SESSION.freshMs + 1);
    const r = await s.api('/v1/me', { method: 'DELETE', cookie: a.token });
    assert.deepEqual([r.status, r.body], [403, { error: 'reauth' }]);
    assert.ok(await s.store.accounts.byId(a.id));
  });

  test('signed out: GET, PUT and DELETE /v1/me are 401 signed_out', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const r = await s.api('/v1/me', { method, body: method === 'PUT' ? { name: 'Abc' } : undefined });
      assert.deepEqual([r.status, r.body], [401, { error: 'signed_out' }], method);
    }
  });

  test('wrong methods are 405 with Allow', async () => {
    const r = await s.api('/v1/auth/start');
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST, OPTIONS');
    const m = await s.api('/v1/me', { method: 'POST', body: {} });
    assert.equal(m.status, 405);
    assert.equal(m.headers.get('allow'), 'GET, PUT, DELETE, OPTIONS');
    assert.equal((await s.api('/v1/auth/nope', { method: 'POST', body: {} })).status, 404);
  });
});

// ---------------------------------------------------------------------------
describe('nothing sensitive in the logs', () => {
  test('emails, codes, tokens, cookies and passwords never reach the log', async () => {
    const s = await startAccounts({ accounts: { hasher: FAST() } });
    try {
      const email = freshEmail();
      const secrets = [email, email.split('@')[0]];
      const st = await s.api('/v1/auth/start', { method: 'POST', body: { email } });
      await tick();
      const msg = s.mailer.last(email);
      secrets.push(s.codeFrom(msg), s.tokenFrom(msg), st.body.id);
      await s.api('/v1/auth/code', { method: 'POST', body: { id: st.body.id, code: '000000' } });
      const r = await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } });
      secrets.push(r.token, sha256(r.token));
      await s.api('/v1/me', { method: 'PUT', cookie: r.token, body: { password: { new: 'my secret passphrase' } } });
      secrets.push('my secret passphrase');
      await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'my secret passphrase' } });
      await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'another secret phrase' } });
      secrets.push('another secret phrase');
      await s.api('/v1/me', { cookie: r.token });
      // A failing store must not leak either (500, class/code only).
      const orig = s.store.accounts.byEmail;
      s.store.accounts.byEmail = async () => { throw new Error(`boom ${email}`); };
      const boom = await s.api('/v1/auth/password', { method: 'POST', body: { email, password: 'my secret passphrase' } });
      assert.equal(boom.status, 500);
      s.store.accounts.byEmail = orig;
      await s.api('/v1/me', { method: 'DELETE', cookie: r.token });
      await tick();
      const all = s.logs.join('\n');
      assert.ok(s.logs.length > 8);
      for (const secret of secrets) assert.ok(!all.includes(secret), `log holds ${secret}`);
      assert.ok(!/@/.test(all));
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('stubs for the save-slot and admin routes', () => {
  test('/v1/saves* answers 501 while accounts are on', async () => {
    const s = await startAccounts();
    try {
      for (const [method, path] of [['GET', '/v1/saves'], ['GET', '/v1/saves/3'], ['PUT', '/v1/saves/3'], ['POST', '/v1/saves/claim']]) {
        const r = await s.api(path, { method, body: method === 'GET' ? undefined : {} });
        assert.deepEqual([r.status, r.body], [501, { error: 'not_implemented' }], `${method} ${path}`);
      }
    } finally {
      await s.close();
    }
  });

  test('admin prefix: 404 with no key, through the tunnel or from a browser; 401 wrong key; 400 no admin email', async () => {
    const KEY = 'k'.repeat(40);
    const off = await startAccounts();
    const on = await startAccounts({ accounts: { admin: { apiKey: KEY } } });
    const call = (srv, headers, path = '/admin/v1/accounts') => fetch(`${srv.url}${path}`, { headers });
    try {
      assert.equal((await call(off, { 'X-Admin-Key': KEY, 'X-Admin-Email': 'a@b.cd' })).status, 404);
      const good = { 'X-Admin-Key': KEY, 'X-Admin-Email': 'Admin@Example.test' };
      assert.equal((await call(on, { ...good, 'CF-Connecting-IP': '1.2.3.4' })).status, 404);
      assert.equal((await call(on, { ...good, 'CF-Ray': 'abc' })).status, 404);
      assert.equal((await call(on, { ...good, Origin: GAME })).status, 404);
      const wrong = await call(on, { ...good, 'X-Admin-Key': 'k'.repeat(39) + 'x' });
      assert.deepEqual([wrong.status, await wrong.json()], [401, { error: 'admin_key' }]);
      assert.equal((await call(on, { 'X-Admin-Email': 'a@b.cd' })).status, 401);
      const noEmail = await call(on, { 'X-Admin-Key': KEY });
      assert.deepEqual([noEmail.status, await noEmail.json()], [400, { error: 'admin_email' }]);
      // Past the guard the admin routes answer (they are tested in admin.test.js).
      const ok = await call(on, good);
      assert.deepEqual([ok.status, (await ok.json()).total], [200, 0]);
      assert.equal((await call(on, good, '/admin/v1')).status, 404);
      // Outside the prefix nothing changes.
      assert.equal((await call(on, good, '/admin/v2')).status, 404);
    } finally {
      await off.close();
      await on.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('mail', () => {
  test('the three emails: text and simple HTML, no remote images, no tracking', () => {
    const all = [
      signInEmail({ link: 'https://g.example/?signin=T0K', code: '042817' }),
      passwordChangedEmail(),
      accountDeletedEmail(),
    ];
    for (const m of all) {
      assert.ok(m.subject && m.text && m.html.startsWith('<!DOCTYPE html>'));
      assert.ok(!/<img|src=|url\(|<script|<link/i.test(m.html));
    }
    const si = all[0];
    assert.match(si.text, /https:\/\/g\.example\/\?signin=T0K/);
    assert.match(si.text, /042817/);
    assert.match(si.html, /href="https:\/\/g\.example\/\?signin=T0K"/);
    assert.match(si.html, /font-size:34px[^>]*>042817</);
    // Only the sign-in link is a link.
    assert.equal((si.html.match(/href=/g) || []).length, 1);
    assert.equal((all[1].html.match(/href=/g) || []).length, 0);
    // Values are escaped.
    assert.match(signInEmail({ link: 'https://g.example/?a=1&signin=x"y', code: '1' }).html, /a=1&amp;signin=x&quot;y/);
  });

  test('the Resend sender posts to the API with the key; a non-2xx answer rejects', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: calls.length === 1, status: calls.length === 1 ? 200 : 422 };
    };
    const m = createResendMailer({ apiKey: 're_test', from: 'Brave Quest <keeper@example.test>', fetchImpl });
    await m.send({ to: 'x@example.test', subject: 'S', text: 'T', html: '<p>H</p>' });
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      from: 'Brave Quest <keeper@example.test>', to: ['x@example.test'], subject: 'S', text: 'T', html: '<p>H</p>',
    });
    await assert.rejects(m.send({ to: 'x@example.test', subject: 'S', text: 'T', html: '' }), (e) => e.code === 'mail_422' && !e.message.includes('x@'));
    assert.throws(() => createResendMailer({ apiKey: '', from: 'a' }));
  });

  test('the fake mailer keeps messages and can fail', async () => {
    const m = createFakeMailer();
    await m.send({ to: 'a@b.cd', subject: '1', text: '', html: '' });
    await m.send({ to: 'e@f.gh', subject: '2', text: '', html: '' });
    assert.equal(m.sent.length, 2);
    assert.equal(m.last('a@b.cd').subject, '1');
    assert.equal(m.last().subject, '2');
    m.fail();
    await assert.rejects(m.send({ to: 'a@b.cd' }));
  });
});

test('normaliseEmail', () => {
  assert.equal(normaliseEmail('  A.B+tag@Example.TEST '), 'a.b+tag@example.test');
  for (const bad of ['', 'a', 'a@', '@b.c', 'a@b', 'a@@b.c', 'a b@c.d', null, {}]) assert.equal(normaliseEmail(bad), null, String(bad));
});

test('createApp with accounts and a postgres-shaped store does not touch the store at construction', () => {
  const store = createMemoryStore();
  const app = createApp({ store, config: { accounts: { enabled: true, mailer: createFakeMailer(), sessionSecret: 'x'.repeat(32), appUrl: APP_URL } } });
  assert.equal(app.accounts.enabled, true);
  assert.equal(store._mem.accounts.size, 0);
});
