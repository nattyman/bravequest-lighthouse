// The private admin API (/admin/v1/*): the guard, every route and rule. Spec: ACCOUNTS.md (section 4).
// All requests are real fetch() calls against a listening server, made the way the admin makes them
// (no Origin, X-Admin-Key, X-Admin-Email).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { startServer } from './_helpers.js';
import { SUPER, freshEmail, startAccounts, tick } from './_accounts.js';
import { accountsConfigFromEnv } from '../src/accounts/config.js';
import { createFakeMailer } from '../src/accounts/mailer.js';

const KEY = 'a-very-long-admin-key-0123456789abcdef';
const ADMIN = 'lead@example.test';
const MISSING = '00000000-0000-4000-8000-000000000000';
const GROUPS = ['start', 'cheats', 'give', 'map', 'teleport', 'monsters'];

/** A server with accounts on and the admin API on, plus admin(path, opts) -> { status, body, headers }. */
async function startAdmin(opts = {}) {
  const s = await startAccounts({ ...opts, accounts: { admin: { apiKey: KEY }, ...(opts.accounts ?? {}) } });
  s.admin = (path, { method = 'GET', body, key = KEY, email = ADMIN, headers = {} } = {}) => adminCall(s.url, path, { method, body, key, email, headers });
  return s;
}

async function adminCall(url, path, { method = 'GET', body, key = KEY, email = ADMIN, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (key !== null) h['X-Admin-Key'] = key;
  if (email !== null) h['X-Admin-Email'] = email;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(`${url}/admin/v1${path}`, {
    method, headers: h, redirect: 'manual', body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

const recordBody = (name) => ({
  name, nameKey: name ? name.toLowerCase() : undefined, crew: undefined, build: 'b9', play: 3600, deaths: 2, pct: 30, badges: 1,
  rank: 1, days: 2, act1: null, full: null, fullDeaths: null, splits: {}, bosses: {},
});

/** An account with two saves and a record row, made straight in the store. */
async function seedAccount(s, { email = freshEmail(), at } = {}) {
  const a = await s.store.accounts.signIn(email, { at: at ?? s.clock.t });
  await s.store.slots.put(a.id, 1, { at: 111, objective: 'Find the lantern', body: '{"v":1,"hp":3}', rec: { play: 60, pct: 5, rank: 0, ri: 0 } }, { updatedAt: s.clock.t });
  await s.store.slots.put(a.id, 4, { at: 222, objective: 'Cave', body: '{"v":1}', test: true }, { updatedAt: s.clock.t });
  const rid = s.store.accounts.recordId(a.id);
  await s.store.putSave(rid, { at: 1, objective: '', body: 'x' });
  await s.store.putRecord(rid, recordBody(undefined));
  return a;
}

const lastAudit = async (s) => (await s.store.audit.list({ page: 1, per: 1 })).rows[0];
const auditCount = async (s) => (await s.store.audit.list({ per: 1 })).total;
// consonants only: random letters and digits can spell a blocked word (digits count as look-alike letters)
const uname = () => `Kp${Array.from({ length: 8 }, () => 'bcdfghjklmnpqrtvwxz'[Math.floor(Math.random() * 19)]).join('')}`;

// ---------------------------------------------------------------------------
describe('admin guard', () => {
  test("Node's own fetch (as the admin calls it) gets through: GET, and POST with a JSON body; it sends no Origin", async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const res = await fetch(`${s.url}/admin/v1/settings`, {
        headers: { Accept: 'application/json', 'X-Admin-Key': KEY, 'X-Admin-Email': ADMIN }, redirect: 'manual',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { testerTools: ['start', 'give', 'map', 'teleport'] });
      const post = await fetch(`${s.url}/admin/v1/accounts/${a.id}`, {
        method: 'POST', redirect: 'manual',
        headers: { Accept: 'application/json', 'X-Admin-Key': KEY, 'X-Admin-Email': ADMIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'tester' }),
      });
      assert.equal(post.status, 200);
      assert.equal((await post.json()).account.role, 'tester');
      assert.equal(post.headers.get('cache-control'), 'no-store');
    } finally {
      await s.close();
    }
    // And the headers themselves: no Origin from Node's fetch, for GET or POST.
    const http = await import('node:http');
    const got = [];
    const srv = http.createServer((req, res) => { got.push(req.headers); res.end('{}'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const u = `http://127.0.0.1:${srv.address().port}`;
    try {
      await fetch(`${u}/x`, { headers: { 'X-Admin-Key': KEY } });
      await fetch(`${u}/x`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await fetch(`${u}/x`, { method: 'DELETE' });
      for (const h of got) {
        assert.equal(h.origin, undefined);
        assert.equal(h['cf-connecting-ip'], undefined);
        assert.equal(h['cf-ray'], undefined);
      }
    } finally {
      srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
  });

  test('through the tunnel (cf-connecting-ip or cf-ray) or from a browser (Origin): 404 even with the right key', async () => {
    const s = await startAdmin();
    try {
      for (const headers of [{ 'CF-Connecting-IP': '203.0.113.5' }, { 'CF-Ray': '8a1b2c3d4e5f-LHR' }, { 'cf-ray': '' }, { Origin: 'https://nattyman.github.io' }]) {
        for (const [method, path, body] of [['GET', '/accounts'], ['PUT', '/settings', { testerTools: [] }]]) {
          const r = await s.admin(path, { method, body, headers });
          assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }], `${method} ${JSON.stringify(headers)}`);
        }
      }
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });

  test('wrong or missing key: 401 admin_key; missing or bad X-Admin-Email: 400 admin_email', async () => {
    const s = await startAdmin();
    try {
      for (const key of [null, '', KEY.slice(0, -1), `${KEY}x`, KEY.toUpperCase()]) {
        assert.deepEqual(await s.admin('/accounts', { key }).then((r) => [r.status, r.body]), [401, { error: 'admin_key' }], String(key));
      }
      for (const email of [null, '', 'not-an-address']) {
        assert.deepEqual(await s.admin('/accounts', { email }).then((r) => [r.status, r.body]), [400, { error: 'admin_email' }], String(email));
      }
    } finally {
      await s.close();
    }
  });

  test('the prefix is 404 when ADMIN_API_KEY is unset or shorter than 32 characters', async () => {
    const off = await startAccounts(); // admin: null
    const short = await startAccounts({ accounts: { admin: { apiKey: 'k'.repeat(31) } } });
    const fromEnv = await startServer({ config: { accounts: accountsConfigFromEnv({ ADMIN_API_KEY: 'k'.repeat(31) }) } });
    try {
      for (const [srv, key] of [[off, KEY], [short, 'k'.repeat(31)], [fromEnv, 'k'.repeat(31)]]) {
        for (const path of ['/accounts', '/settings', '/audit']) {
          const r = await adminCall(srv.url, path, { key });
          assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }]);
        }
      }
    } finally {
      await Promise.all([off.close(), short.close(), fromEnv.close()]);
    }
  });

  test('the key is compared in constant time (crypto.timingSafeEqual on equal-length buffers, whatever was sent)', async () => {
    const s = await startAdmin();
    const real = crypto.timingSafeEqual;
    const calls = [];
    crypto.timingSafeEqual = (a, b) => {
      calls.push([a.length, b.length]);
      return real(a, b);
    };
    syncBuiltinESMExports();
    try {
      const before = calls.length;
      assert.equal((await s.admin('/settings', { key: `${KEY.slice(0, -1)}X` })).status, 401); // same length
      assert.equal((await s.admin('/settings', { key: 'short' })).status, 401); // different length
      assert.equal((await s.admin('/settings')).status, 200);
      const mine = calls.slice(before);
      assert.ok(mine.length >= 3, `timingSafeEqual ran ${mine.length} times`);
      for (const [x, y] of mine) assert.equal(x, y);
    } finally {
      crypto.timingSafeEqual = real;
      syncBuiltinESMExports();
      await s.close();
    }
  });

  test('works with accounts off (ACCOUNTS unset); the sign-in email then answers 503 accounts_off', async () => {
    const env = accountsConfigFromEnv({ ADMIN_API_KEY: KEY }); // no mailer, accounts off
    assert.equal(env.enabled, false);
    assert.equal(env.mailer, null);
    const s = await startServer({ config: { accounts: env } });
    try {
      const a = await s.store.accounts.signIn(freshEmail(), { at: Date.now() });
      const list = await adminCall(s.url, '/accounts');
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.rows.map((r) => r.id), [a.id]);
      assert.equal((await adminCall(s.url, `/accounts/${a.id}`)).status, 200);
      assert.equal((await adminCall(s.url, `/accounts/${a.id}`, { method: 'POST', body: { role: 'tester' } })).status, 200);
      const mail = await adminCall(s.url, `/accounts/${a.id}/signin-email`, { method: 'POST' });
      assert.deepEqual([mail.status, mail.body], [503, { error: 'accounts_off' }]);
      assert.equal((await adminCall(s.url, '/settings')).status, 200);
      // The public account routes stay off.
      assert.equal((await fetch(`${s.url}/v1/me`)).status, 503);
    } finally {
      await s.close();
    }
  });

  test('unknown paths are 404, wrong methods 405', async () => {
    const s = await startAdmin();
    try {
      assert.equal((await s.admin('')).status, 404);
      assert.equal((await s.admin('/nope')).status, 404);
      assert.equal((await s.admin('/accounts/x/y/z/w')).status, 404);
      const r = await s.admin('/settings', { method: 'DELETE' });
      assert.equal(r.status, 405);
      assert.match(r.headers.get('allow'), /GET/);
      assert.equal((await s.admin('/accounts', { method: 'POST', body: {} })).status, 405);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('GET /admin/v1/accounts', () => {
  test('rows, newest first, with saves and super; search on email or keeper name; role and status filters', async () => {
    const s = await startAdmin();
    try {
      const boss = await s.signIn(SUPER);
      s.clock.advance(1000);
      const a = await seedAccount(s, { email: 'Alice.Lamp@example.test'.toLowerCase() });
      s.clock.advance(1000);
      const b = await s.store.accounts.signIn('bob@example.test', { at: s.clock.t });
      await s.store.accounts.setName(b.id, { name: 'Moth Queen', key: 'moth queen' });
      await s.store.accounts.update(b.id, { role: 'tester' });
      s.clock.advance(1000);
      const c = await s.store.accounts.signIn('carol@example.test', { at: s.clock.t });
      await s.store.accounts.update(c.id, { status: 'disabled' });

      const all = await s.admin('/accounts');
      assert.equal(all.status, 200);
      assert.equal(all.body.total, 4);
      assert.equal(all.body.page, 1);
      assert.equal(all.body.per, 50);
      assert.deepEqual(all.body.rows.map((r) => r.id), [c.id, b.id, a.id, boss.id]);
      assert.deepEqual(all.body.rows[2], {
        id: a.id, email: 'alice.lamp@example.test', name: '', role: 'player', status: 'active',
        created: a.createdAt, lastSeen: a.lastSeenAt, saves: 2, super: false,
      });
      assert.equal(all.body.rows[3].super, true);
      assert.equal(all.body.rows[3].role, 'admin');
      assert.equal(typeof all.body.rows[0].created, 'number');

      const ids = async (qs) => (await s.admin(`/accounts?${qs}`)).body.rows.map((r) => r.id);
      assert.deepEqual(await ids('q=ALICE'), [a.id]);
      assert.deepEqual(await ids('q=moth%20q'), [b.id]); // keeper name, any case
      assert.deepEqual(await ids('q=%20QUEEN%20'), [b.id]); // trimmed
      assert.deepEqual(await ids('q=example.test&role=tester'), [b.id]);
      assert.deepEqual(await ids('status=disabled'), [c.id]);
      assert.deepEqual(await ids('role=admin'), [boss.id]);
      assert.deepEqual(await ids('role=player&status=active'), [a.id]);
      assert.deepEqual(await ids('q=%25'), []); // % is literal
      assert.deepEqual(await ids('q=nobody'), []);
      assert.deepEqual(await ids('q=&role=&status='), [c.id, b.id, a.id, boss.id]); // empty = no filter
      // Unknown filter values and malformed paging are refused.
      for (const qs of ['role=owner', 'status=gone', 'page=0', 'page=-1', 'page=x', 'per=0', 'per=abc']) {
        assert.deepEqual(await s.admin(`/accounts?${qs}`).then((r) => [r.status, r.body]), [400, { error: 'bad_request' }], qs);
      }
      // Reads write no audit rows.
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });

  test('paging is 1-based; per defaults to 50 and is capped at 200', async () => {
    const s = await startAdmin();
    try {
      const made = [];
      for (let i = 0; i < 205; i++) {
        made.push((await s.store.accounts.signIn(`p${i}@example.test`, { at: s.clock.t + i })).id);
      }
      made.reverse(); // newest first
      const p1 = await s.admin('/accounts');
      assert.deepEqual([p1.body.total, p1.body.rows.length], [205, 50]);
      assert.deepEqual(p1.body.rows.map((r) => r.id), made.slice(0, 50));
      const p2 = await s.admin('/accounts?page=2&per=50');
      assert.deepEqual(p2.body.rows.map((r) => r.id), made.slice(50, 100));
      const p5 = await s.admin('/accounts?page=5&per=50');
      assert.deepEqual(p5.body.rows.map((r) => r.id), made.slice(200));
      assert.deepEqual((await s.admin('/accounts?page=6')).body.rows, []);
      const big = await s.admin('/accounts?per=1000');
      assert.deepEqual([big.body.per, big.body.rows.length], [200, 200]);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('GET /admin/v1/accounts/:id', () => {
  test('the account, its saves (with bytes, no bodies), live sessions (no token hashes) and its record', async () => {
    const s = await startAdmin();
    try {
      const email = freshEmail();
      const a = await seedAccount(s, { email });
      await s.signIn(email); // one real session
      const r = await s.admin(`/accounts/${a.id}`);
      assert.equal(r.status, 200);
      const acc = await s.store.accounts.byId(a.id);
      assert.deepEqual(r.body.account, {
        id: a.id, email, name: '', role: 'player', tools: [], status: 'active', hasPassword: false,
        created: acc.createdAt, lastSeen: acc.lastSeenAt, super: false,
      });
      assert.deepEqual(r.body.saves, [
        { slot: 1, name: 'Save 1', test: false, at: 111, objective: 'Find the lantern', rec: { play: 60, pct: 5, rank: 0, ri: 0 }, updated: s.clock.t, bytes: 14 },
        { slot: 4, name: 'Save 4', test: true, at: 222, objective: 'Cave', rec: null, updated: s.clock.t, bytes: 7 },
      ]);
      assert.equal(r.body.sessions.length, 1);
      assert.deepEqual(Object.keys(r.body.sessions[0]).sort(), ['created', 'lastUsed', 'note']);
      assert.equal(r.body.sessions[0].created, s.clock.t);
      assert.ok(!JSON.stringify(r.body).includes('body'));
      assert.equal(r.body.record.build, 'b9');
      assert.equal(r.body.record.play, 3600);
      assert.equal(typeof r.body.record.at, 'number');
      // Expired sessions are left out.
      s.clock.advance(61 * 86_400_000);
      assert.deepEqual((await s.admin(`/accounts/${a.id}`)).body.sessions, []);
      // No record, no saves.
      const bare = await s.store.accounts.signIn(freshEmail(), { at: s.clock.t });
      const rb = await s.admin(`/accounts/${bare.id}`);
      assert.deepEqual([rb.body.saves, rb.body.sessions, rb.body.record], [[], [], null]);
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });

  test('unknown ids: malformed and well-formed-but-missing are both 404 not_found, on every account route', async () => {
    const s = await startAdmin();
    try {
      for (const id of ['nope', '12345', MISSING, `${MISSING.slice(0, -1)}Z`, '%27%3B--']) {
        for (const [method, path, body] of [
          ['GET', ''], ['POST', '', { role: 'tester' }], ['DELETE', ''], ['POST', '/signout'], ['POST', '/signin-email'],
          ['GET', '/saves/1'], ['DELETE', '/saves/1'],
        ]) {
          const r = await s.admin(`/accounts/${id}${path}`, { method, body });
          assert.deepEqual([r.status, r.body], [404, { error: 'not_found' }], `${method} ${id}${path}`);
        }
      }
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('POST /admin/v1/accounts/:id', () => {
  test('role, tools, status, name: one field at a time, each with its audit row (from -> to)', async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const post = (body) => s.admin(`/accounts/${a.id}`, { method: 'POST', body });

      let r = await post({ role: 'tester' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.account.role, 'tester');
      let row = await lastAudit(s);
      assert.deepEqual({ ...row, at: 0 }, {
        at: 0, adminEmail: ADMIN, action: 'role', accountId: a.id, email: a.email, detail: { from: 'player', to: 'tester' },
      });

      r = await post({ tools: ['monsters', 'cheats', 'cheats'] });
      assert.deepEqual(r.body.account.tools, ['cheats', 'monsters']); // known groups, panel order, no repeats
      row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['tools', { from: [], to: ['cheats', 'monsters'] }]);
      r = await post({ tools: [] });
      assert.deepEqual(r.body.account.tools, []);

      r = await post({ status: 'disabled' });
      assert.equal(r.body.account.status, 'disabled');
      row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['disable', { from: 'active', to: 'disabled', sessionsEnded: 0 }]);
      r = await post({ status: 'active' });
      assert.equal(r.body.account.status, 'active');
      row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['enable', { from: 'disabled', to: 'active' }]);

      const n = uname();
      r = await post({ name: `  ${n}  ` });
      assert.equal(r.body.account.name, n);
      row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['name', { from: '', to: n }]);
      // The name goes through the same path as PUT /v1/me: the account's record row follows it.
      assert.equal((await s.store.getRecord(s.store.accounts.recordId(a.id))).name, n);
      r = await post({ name: '' });
      assert.equal(r.body.account.name, '');
      assert.equal((await s.store.getRecord(s.store.accounts.recordId(a.id))).name, '');
      row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['name', { from: n, to: '' }]);

      // Several fields at once are accepted too (one audit row each).
      const before = await auditCount(s);
      r = await post({ role: 'player', status: 'active' });
      assert.equal(r.status, 200);
      assert.equal(await auditCount(s), before + 2);
    } finally {
      await s.close();
    }
  });

  test('validation: unknown values, unknown fields and empty bodies are 400; names 400 name_invalid / 409 name_taken', async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const other = await s.store.accounts.signIn(freshEmail(), { at: s.clock.t });
      const taken = uname();
      await s.store.accounts.setName(other.id, { name: taken, key: taken.toLowerCase() });
      const post = (body) => s.admin(`/accounts/${a.id}`, { method: 'POST', body }).then((r) => [r.status, r.body]);
      const before = await auditCount(s);
      for (const body of [
        { role: 'owner' }, { role: 'ADMIN' }, { role: null }, { tools: 'cheats' }, { tools: ['cheats', 'flying'] }, { tools: [1] },
        { status: 'banned' }, { status: true }, {}, { email: 'x@y.z' }, { role: 'tester', extra: 1 },
      ]) {
        assert.deepEqual(await post(body), [400, { error: 'bad_request' }], JSON.stringify(body));
      }
      assert.deepEqual(await s.admin(`/accounts/${a.id}`, { method: 'POST', body: 'not json' }).then((r) => r.status), 400);
      assert.deepEqual(await s.admin(`/accounts/${a.id}`, { method: 'POST', body: '[1]' }).then((r) => r.status), 400);
      for (const name of ['ab', 'x'.repeat(17), '!!!', 42, null]) {
        assert.deepEqual(await post({ name }), [400, { error: 'name_invalid' }], String(name));
      }
      assert.deepEqual(await post({ name: taken.toUpperCase() }), [409, { error: 'name_taken' }]);
      // A guest's board name counts too.
      await s.store.putSave('g1', { at: 1, objective: '', body: 'x' });
      const guestName = uname();
      await s.store.putRecord('g1', recordBody(guestName));
      assert.deepEqual(await post({ name: guestName }), [409, { error: 'name_taken' }]);
      // A refused name changes nothing else sent with it.
      assert.deepEqual(await post({ name: taken, role: 'tester' }), [409, { error: 'name_taken' }]);
      assert.equal((await s.store.accounts.byId(a.id)).role, 'player');
      assert.equal(await auditCount(s), before);
    } finally {
      await s.close();
    }
  });

  test('disabling ends every session of the account at once', async () => {
    const s = await startAdmin();
    try {
      const email = freshEmail();
      const one = await s.signIn(email);
      const two = await s.signIn(email);
      assert.equal((await s.api('/v1/me', { cookie: one.token })).status, 200);
      const r = await s.admin(`/accounts/${one.id}`, { method: 'POST', body: { status: 'disabled' } });
      assert.equal(r.status, 200);
      assert.deepEqual((await lastAudit(s)).detail, { from: 'active', to: 'disabled', sessionsEnded: 2 });
      assert.deepEqual(await s.store.sessions.listForAccount(one.id), []);
      for (const t of [one.token, two.token]) assert.equal((await s.api('/v1/me', { cookie: t })).status, 401);
      // A disabled account cannot sign in again until it is enabled.
      await assert.rejects(s.signIn(email), /403/);
      await s.admin(`/accounts/${one.id}`, { method: 'POST', body: { status: 'active' } });
      assert.equal((await s.signIn(email)).id, one.id);
    } finally {
      await s.close();
    }
  });

  test('a super admin: 409 super for role, tools, status and name, and nothing changes', async () => {
    const s = await startAdmin();
    try {
      const boss = await s.signIn(SUPER);
      for (const body of [{ role: 'player' }, { tools: ['cheats'] }, { status: 'disabled' }, { name: uname() }, { name: '' }, { role: 'nonsense' }, {}]) {
        const r = await s.admin(`/accounts/${boss.id}`, { method: 'POST', body });
        assert.deepEqual([r.status, r.body], [409, { error: 'super' }], JSON.stringify(body));
      }
      const acc = await s.store.accounts.byId(boss.id);
      assert.deepEqual([acc.role, acc.status, acc.tools, acc.displayName], ['admin', 'active', [], '']);
      assert.equal((await s.api('/v1/me', { cookie: boss.token })).status, 200);
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('sign out, sign-in email, delete', () => {
  test('POST .../signout ends all sessions (allowed for a super admin), with an audit row', async () => {
    const s = await startAdmin();
    try {
      const email = freshEmail();
      const one = await s.signIn(email);
      await s.signIn(email);
      const r = await s.admin(`/accounts/${one.id}/signout`, { method: 'POST' });
      assert.deepEqual([r.status, r.body], [200, { ok: true, ended: 2 }]);
      assert.equal((await s.api('/v1/me', { cookie: one.token })).status, 401);
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.accountId, row.detail], ['signout', one.id, { sessionsEnded: 2 }]);
      // The account itself is untouched and can sign in again.
      assert.equal((await s.signIn(email)).id, one.id);

      const boss = await s.signIn(SUPER);
      const rb = await s.admin(`/accounts/${boss.id}/signout`, { method: 'POST', body: {} });
      assert.deepEqual([rb.status, rb.body], [200, { ok: true, ended: 1 }]);
      assert.equal((await s.api('/v1/me', { cookie: boss.token })).status, 401);
    } finally {
      await s.close();
    }
  });

  test('POST .../signin-email sends the normal sign-in email, whose code and link both work (also for a super admin)', async () => {
    const s = await startAdmin();
    try {
      const email = freshEmail();
      const a = await s.store.accounts.signIn(email, { at: s.clock.t });
      s.mailer.clear();
      const r = await s.admin(`/accounts/${a.id}/signin-email`, { method: 'POST' });
      assert.deepEqual([r.status, r.body], [200, { ok: true }]);
      assert.equal(s.mailer.sent.length, 1);
      const msg = s.mailer.last(email);
      assert.ok(msg.subject && msg.html);
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.accountId, row.detail], ['signin-email', a.id, { sent: true }]);
      assert.ok(!JSON.stringify(row).includes(s.codeFrom(msg)));
      // The link signs in (the game posts it).
      const link = await s.api('/v1/auth/link', { method: 'POST', body: { token: s.tokenFrom(msg) } });
      assert.equal(link.status, 200);
      assert.equal(link.body.me.id, a.id);

      const boss = await s.store.accounts.signIn(SUPER, { at: s.clock.t, role: 'admin' });
      const rb = await s.admin(`/accounts/${boss.id}/signin-email`, { method: 'POST' });
      assert.equal(rb.status, 200);
      assert.equal(s.mailer.last().to, SUPER);
    } finally {
      await s.close();
    }
  });

  test('sign-in email: a disabled account is 409 disabled (no email); a mail failure is 502 mail_failed', async () => {
    const mailer = createFakeMailer();
    const s = await startAdmin({ accounts: { mailer } });
    try {
      const a = await s.store.accounts.signIn(freshEmail(), { at: s.clock.t });
      await s.store.accounts.update(a.id, { status: 'disabled' });
      const r = await s.admin(`/accounts/${a.id}/signin-email`, { method: 'POST' });
      assert.deepEqual([r.status, r.body], [409, { error: 'disabled' }]);
      assert.equal(mailer.sent.length, 0);
      await s.store.accounts.update(a.id, { status: 'active' });
      mailer.fail(true);
      const f = await s.admin(`/accounts/${a.id}/signin-email`, { method: 'POST' });
      assert.deepEqual([f.status, f.body], [502, { error: 'mail_failed' }]);
      assert.deepEqual((await lastAudit(s)).detail, { sent: false });
      assert.ok(s.logs.some((l) => l.startsWith('mail failed (admin sign-in)')));
      assert.ok(!s.logs.some((l) => l.includes(a.email)));
    } finally {
      await s.close();
    }
  });

  test('DELETE removes the account, its saves, record, sessions and sign-ins; audited with its address', async () => {
    const s = await startAdmin();
    try {
      const email = freshEmail();
      const a = await seedAccount(s, { email });
      const n = uname();
      await s.store.accounts.setName(a.id, { name: n, key: n.toLowerCase() });
      const { token } = await s.signIn(email);
      await s.api('/v1/auth/start', { method: 'POST', body: { email } }); // a sign-in waiting in the inbox
      await tick();
      const r = await s.admin(`/accounts/${a.id}`, { method: 'DELETE' });
      assert.deepEqual([r.status, r.body], [200, { ok: true }]);
      assert.equal(await s.store.accounts.byId(a.id), null);
      assert.equal(await s.store.slots.count(a.id), 0);
      assert.equal(await s.store.getRecord(s.store.accounts.recordId(a.id)), null);
      assert.deepEqual(await s.store.sessions.listForAccount(a.id), []);
      assert.equal([...s.store._mem.signIns.values()].filter((x) => x.email === email).length, 0);
      assert.equal((await s.api('/v1/me', { cookie: token })).status, 401);
      // The name is free again.
      const other = await s.store.accounts.signIn(freshEmail(), { at: s.clock.t });
      assert.equal((await s.store.accounts.setName(other.id, { name: n, key: n.toLowerCase() })).status, 'ok');
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.accountId, row.email, row.detail], ['delete', a.id, null, { email, name: n, role: 'player', saves: 2, record: true }]);
      assert.deepEqual((await s.admin(`/accounts/${a.id}`)).status, 404);
      assert.deepEqual((await s.admin(`/accounts/${a.id}`, { method: 'DELETE' })).status, 404);
    } finally {
      await s.close();
    }
  });

  test('DELETE is refused for a super admin (409 super) and nothing is removed', async () => {
    const s = await startAdmin();
    try {
      const boss = await s.signIn(SUPER);
      await s.store.slots.put(boss.id, 2, { at: 1, objective: '', body: 'b' }, { updatedAt: s.clock.t });
      const r = await s.admin(`/accounts/${boss.id}`, { method: 'DELETE' });
      assert.deepEqual([r.status, r.body], [409, { error: 'super' }]);
      assert.ok(await s.store.accounts.byId(boss.id));
      assert.equal(await s.store.slots.count(boss.id), 1);
      assert.equal((await s.api('/v1/me', { cookie: boss.token })).status, 200);
      assert.equal(await auditCount(s), 0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('saves', () => {
  test('GET .../saves/:slot is the whole save, and the download is audited (without the body)', async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const r = await s.admin(`/accounts/${a.id}/saves/1`);
      assert.deepEqual([r.status, r.body], [200, {
        slot: 1, name: 'Save 1', test: false, at: 111, objective: 'Find the lantern', rec: { play: 60, pct: 5, rank: 0, ri: 0 }, body: '{"v":1,"hp":3}',
      }]);
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.accountId, row.detail], ['save-download', a.id, { slot: 1, name: 'Save 1', test: false, bytes: 14 }]);
      assert.ok(!JSON.stringify(row).includes('"hp"'));
      const t = await s.admin(`/accounts/${a.id}/saves/4`);
      assert.equal(t.body.test, true);
      // A missing save, and slots outside 1..10.
      const before = await auditCount(s);
      assert.deepEqual(await s.admin(`/accounts/${a.id}/saves/2`).then((x) => [x.status, x.body]), [404, { error: 'no_save' }]);
      for (const slot of ['0', '11', '01', '1.5', 'x', '-1']) {
        assert.deepEqual(await s.admin(`/accounts/${a.id}/saves/${slot}`).then((x) => [x.status, x.body]), [400, { error: 'bad_slot' }], slot);
      }
      assert.equal(await auditCount(s), before);
    } finally {
      await s.close();
    }
  });

  test('DELETE .../saves/:slot removes only that save; audited; 404 no_save after', async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const r = await s.admin(`/accounts/${a.id}/saves/4`, { method: 'DELETE' });
      assert.deepEqual([r.status, r.body], [200, { ok: true }]);
      assert.deepEqual((await s.store.slots.list(a.id)).map((x) => x.slot), [1]);
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.detail], ['save-delete', { slot: 4, name: 'Save 4', test: true, at: 222 }]);
      assert.deepEqual(await s.admin(`/accounts/${a.id}/saves/4`, { method: 'DELETE' }).then((x) => [x.status, x.body]), [404, { error: 'no_save' }]);
      assert.deepEqual(await s.admin(`/accounts/${a.id}/saves/abc`, { method: 'DELETE' }).then((x) => x.status), 400);
    } finally {
      await s.close();
    }
  });

  test('a super admin\'s saves can be downloaded and deleted', async () => {
    const s = await startAdmin();
    try {
      const boss = await s.signIn(SUPER);
      await s.store.slots.put(boss.id, 3, { at: 9, objective: 'o', body: 'B' }, { updatedAt: s.clock.t });
      assert.equal((await s.admin(`/accounts/${boss.id}/saves/3`)).body.body, 'B');
      assert.equal((await s.admin(`/accounts/${boss.id}/saves/3`, { method: 'DELETE' })).status, 200);
      assert.equal(await s.store.slots.count(boss.id), 0);
    } finally {
      await s.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('audit and settings', () => {
  test('GET /admin/v1/audit: newest first, 1-based pages, snake_case fields, the account\'s current email (null once deleted)', async () => {
    const s = await startAdmin();
    try {
      const a = await seedAccount(s);
      const b = await seedAccount(s);
      await s.admin(`/accounts/${a.id}`, { method: 'POST', body: { role: 'tester' } });
      s.clock.advance(10);
      await s.admin(`/accounts/${b.id}`, { method: 'POST', body: { role: 'tester' }, email: 'Other.Admin@Example.test' });
      s.clock.advance(10);
      await s.admin('/settings', { method: 'PUT', body: { testerTools: ['map'] } });
      s.clock.advance(10);
      await s.admin(`/accounts/${b.id}`, { method: 'DELETE' });

      const r = await s.admin('/audit');
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.total, r.body.page, r.body.per], [4, 1, 50]);
      assert.deepEqual(r.body.rows.map((x) => x.action), ['delete', 'settings', 'role', 'role']);
      assert.deepEqual(Object.keys(r.body.rows[0]).sort(), ['account_id', 'action', 'admin_email', 'at', 'detail', 'email']);
      assert.deepEqual(r.body.rows[3], {
        at: r.body.rows[3].at, admin_email: ADMIN, action: 'role', account_id: a.id, email: a.email, detail: { from: 'player', to: 'tester' },
      });
      assert.equal(typeof r.body.rows[3].at, 'number');
      assert.equal(r.body.rows[2].admin_email, 'other.admin@example.test'); // lower-cased by the guard
      assert.equal(r.body.rows[2].account_id, b.id);
      assert.equal(r.body.rows[2].email, null); // b is gone
      assert.deepEqual([r.body.rows[1].account_id, r.body.rows[1].email], [null, null]);
      const p2 = await s.admin('/audit?page=2&per=3');
      assert.deepEqual(p2.body.rows.map((x) => x.account_id), [a.id]);
      assert.deepEqual((await s.admin('/audit?page=3&per=3')).body.rows, []);
      assert.equal((await s.admin('/audit?page=0')).status, 400);
      assert.equal((await s.admin('/audit?per=9999')).body.per, 200);
    } finally {
      await s.close();
    }
  });

  test('settings: GET gives the default four until set; PUT validates against the six groups and is audited', async () => {
    const s = await startAdmin();
    try {
      assert.deepEqual((await s.admin('/settings')).body, { testerTools: ['start', 'give', 'map', 'teleport'] });
      for (const body of [{}, { testerTools: 'map' }, { testerTools: ['map', 'fly'] }, { testerTools: [null] }, { testerTools: ['map'], x: 1 }, '[]']) {
        assert.deepEqual(await s.admin('/settings', { method: 'PUT', body }).then((r) => [r.status, r.body]), [400, { error: 'bad_request' }], JSON.stringify(body));
      }
      assert.equal(await auditCount(s), 0);
      const r = await s.admin('/settings', { method: 'PUT', body: { testerTools: ['monsters', 'start', 'start'] } });
      assert.deepEqual([r.status, r.body], [200, { ok: true, testerTools: ['start', 'monsters'] }]);
      assert.deepEqual((await s.admin('/settings')).body, { testerTools: ['start', 'monsters'] });
      const row = await lastAudit(s);
      assert.deepEqual([row.action, row.accountId, row.detail], ['settings', null, { testerTools: { from: ['start', 'give', 'map', 'teleport'], to: ['start', 'monsters'] } }]);
      // Testers get the new set at once.
      const email = freshEmail();
      const t = await s.signIn(email);
      await s.admin(`/accounts/${t.id}`, { method: 'POST', body: { role: 'tester' } });
      assert.deepEqual((await s.api('/v1/me', { cookie: t.token })).body.tools, ['start', 'monsters']);
      await s.admin(`/accounts/${t.id}`, { method: 'POST', body: { tools: ['cheats'] } });
      assert.deepEqual((await s.api('/v1/me', { cookie: t.token })).body.tools, ['start', 'cheats', 'monsters']);
      // An empty set is allowed.
      assert.deepEqual((await s.admin('/settings', { method: 'PUT', body: { testerTools: [] } })).body, { ok: true, testerTools: [] });
      assert.deepEqual((await s.admin('/settings', { method: 'PUT', body: { testerTools: GROUPS } })).body.testerTools, GROUPS);
    } finally {
      await s.close();
    }
  });
});
