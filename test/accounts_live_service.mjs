// The real save service (server/) for test/accounts_live_e2e.py: the in-memory store, accounts on, and a fake mailer.
// Not part of the service: it imports the service's own pieces and adds a side port for the test only.
//   PORT          the service (default 8772)
//   SIDE_PORT     for the test: GET /mail (the emails sent), GET /store (a summary of what is stored),
//                 POST /clock?add=<ms> (moves the service's clock), POST /accounts?on=0|1 (accounts off / on, one store)
//   and the service's own variables: ALLOWED_ORIGINS, APP_URL, SESSION_SECRET, COOKIE_INSECURE, SUPER_ADMIN_EMAILS, ADMIN_API_KEY
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'server', 'src');
const { createApp } = await import(path.join(src, 'app.js'));
const { createMemoryStore } = await import(path.join(src, 'store.js'));
const { accountsConfigFromEnv } = await import(path.join(src, 'accounts', 'config.js'));
const { createFakeMailer } = await import(path.join(src, 'accounts', 'mailer.js'));

let offset = 0;
const now = () => Date.now() + offset;
const mailer = createFakeMailer();
const env = { ...process.env, ACCOUNTS: 'on', MAIL_FAKE: '1' };
const on = accountsConfigFromEnv(env);
const off = accountsConfigFromEnv({ ...env, ACCOUNTS: '' });
on.mailer = mailer;
off.mailer = mailer;
if (!on.enabled) {
  console.error(`accounts would stay off: ${on.problems.join('; ')}`);
  process.exit(1);
}
const store = createMemoryStore();
const mk = (accounts) => createApp({
  store,
  config: { allowedOrigins: process.env.ALLOWED_ORIGINS || '', trustProxy: false, accounts, now, log: () => {} },
});
const apps = { on: mk(on), off: mk(off) };
let cur = 'on';
http.createServer((req, res) => apps[cur](req, res)).listen(Number(process.env.PORT || 8772), '127.0.0.1');

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const out = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/mail') return out(mailer.sent.map(({ to, subject, text, at }) => ({ to, subject, text, at })));
  if (u.pathname === '/accounts') {
    if (u.searchParams.has('on')) cur = u.searchParams.get('on') === '1' ? 'on' : 'off';
    return out({ accounts: cur });
  }
  if (u.pathname === '/clock') {
    if (u.searchParams.get('add')) offset += Number(u.searchParams.get('add'));
    return out({ offset, now: now() });
  }
  if (u.pathname === '/store') {
    const m = store._mem;
    const records = [...store._records.entries()].map(([id, r]) => ({ id: id.startsWith('a:') ? id : 'guest:' + id.slice(0, 8), name: r.name, play: r.play, pct: r.pct }));
    const slots = {};
    for (const [id, mp] of m.accountSaves) slots[id] = [...mp.values()].map((r) => ({ slot: r.slot, name: r.name, test: r.test, at: r.at }));
    return out({
      guestSaves: [...store._saves.keys()].map((k) => k.slice(0, 8)), records,
      accounts: [...m.accounts.values()].map((a) => ({ id: a.id, email: a.email, role: a.role, status: a.status, name: a.displayName })),
      sessions: m.sessions.size, slots,
    });
  }
  res.statusCode = 404;
  res.end('{}');
}).listen(Number(process.env.SIDE_PORT || 8773), '127.0.0.1');
console.log('ready');
