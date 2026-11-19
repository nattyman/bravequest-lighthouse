// Helpers for the account tests (not a test file itself): a server with accounts on, a fake clock,
// a fake mailer, and requests the way the game makes them.
import { createHash } from 'node:crypto';
import { startServer } from './_helpers.js';
import { createFakeMailer } from '../src/accounts/mailer.js';
import { createMemoryStore } from '../src/store.js';

export const GAME = 'https://nattyman.github.io'; // an exactly-listed origin (may send cookies)
export const ITCH = 'https://html-classic.itch.zone'; // a wildcard-listed origin (never gets credentials)
export const SECRET = 'test-session-secret-0123456789abcdef';
export const APP_URL = 'https://bravequest.example.test/';
export const SUPER = 'boss@example.test';

let ipCounter = 0;
/** A fresh client address per call, so tests do not share rate-limit buckets unless they mean to. */
export const freshIp = () => {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

let emailCounter = 0;
export const freshEmail = () => `keeper${++emailCounter}.${Date.now().toString(36)}@example.test`;

/**
 * Starts a server with accounts on. Returns startServer's object plus { mailer, clock, api, signIn, codeFrom, tokenFrom }.
 *   clock.t (ms) / clock.advance(ms): the app's clock (limits, sessions and sign-ins all follow it)
 *   api(path, { method, body, cookie, origin (null = none), client (X-BQ-Client, default true), ip, headers })
 *      -> { status, body, headers, cookie (the Set-Cookie line or null), token (bq_s value or null) }
 */
export async function startAccounts({ accounts = {}, store = createMemoryStore(), config = {} } = {}) {
  const clock = { t: 1_800_000_000_000, advance(ms) { this.t += ms; } };
  const mailer = accounts.mailer ?? createFakeMailer();
  const s = await startServer({
    store,
    config: {
      now: () => clock.t,
      accounts: {
        enabled: true, appUrl: APP_URL, sessionSecret: SECRET, cookieInsecure: false, superAdminEmails: [SUPER],
        mailer, admin: null, ...accounts,
      },
      ...config,
    },
  });

  async function api(path, { method = 'GET', body, cookie, origin = GAME, client = true, ip, headers = {} } = {}) {
    const h = { 'X-Forwarded-For': ip ?? freshIp(), ...headers };
    if (origin) h.Origin = origin;
    if (client) h['X-BQ-Client'] = '1';
    if (cookie) h.Cookie = cookie.startsWith('bq_s=') ? cookie : `bq_s=${cookie}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(`${s.url}${path}`, {
      method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    const set = res.headers.getSetCookie();
    const line = set.find((c) => c.startsWith('bq_s=')) ?? null;
    const m = line && /^bq_s=([^;]*)/.exec(line);
    return { status: res.status, body: parsed, headers: res.headers, cookie: line, token: m && m[1] ? m[1] : null };
  }

  const codeFrom = (msg) => /code in the game: (\d{6})/.exec(msg.text)[1];
  const tokenFrom = (msg) => /[?&]signin=([A-Za-z0-9_-]+)/.exec(msg.text)[1];

  /** Signs an address in by code. -> { token, me, id } */
  async function signIn(email, { ip } = {}) {
    const start = await api('/v1/auth/start', { method: 'POST', body: { email }, ip });
    if (start.status !== 200) throw new Error(`start answered ${start.status}`);
    await new Promise((r) => setImmediate(r)); // the email is sent after the answer
    const msg = mailer.last(email.trim().toLowerCase());
    const r = await api('/v1/auth/code', { method: 'POST', body: { id: start.body.id, code: codeFrom(msg) }, ip });
    if (r.status !== 200) throw new Error(`code answered ${r.status} ${JSON.stringify(r.body)}`);
    return { token: r.token, me: r.body.me, id: r.body.me.id };
  }

  return { ...s, mailer, clock, api, signIn, codeFrom, tokenFrom };
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
/** Waits for fire-and-forget work (emails) to run. */
export const tick = () => new Promise((r) => setImmediate(r));
