// The private admin API against a real Postgres: the routes' queries end to end (list with saves counts and
// search, one account with its record, field changes, disable, delete, saves, audit with the email join,
// settings). Only runs when TEST_DATABASE_URL is set; skipped otherwise. Spec: ACCOUNTS.md (section 4).
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createPgStore } from '../src/store.js';
import { SUPER, startAccounts } from './_accounts.js';

const url = process.env.TEST_DATABASE_URL;
const KEY = 'pg-admin-key-0123456789abcdef-0123456789';

if (!url) {
  test('postgres admin API (skipped: TEST_DATABASE_URL is not set)', { skip: true }, () => {});
} else {
  let store;
  let s;
  before(async () => {
    store = createPgStore(url);
    await store.init();
    s = await startAccounts({ store, accounts: { admin: { apiKey: KEY } } });
  });
  after(async () => {
    await s?.close();
    await store?.close();
  });

  const admin = async (path, { method = 'GET', body } = {}) => {
    const headers = { Accept: 'application/json', 'X-Admin-Key': KEY, 'X-Admin-Email': 'lead@example.test' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${s.url}/admin/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  test('postgres: the admin API end to end', async () => {
    const tag = `pg${randomBytes(4).toString('hex')}`;
    const email = `${tag}@example.test`;
    const me = await s.signIn(email);
    const id = me.id;
    await store.slots.put(id, 2, { at: 5, objective: 'Lamp', body: '{"v":1,"x":"é"}', rec: { play: 9, pct: 1, rank: 0 } }, { updatedAt: s.clock.t });
    const rid = store.accounts.recordId(id);
    await store.putSave(rid, { at: 1, objective: '', body: 'x' });
    await store.putRecord(rid, {
      name: undefined, nameKey: undefined, crew: undefined, build: 'b1', play: 100, deaths: 0, pct: 1, badges: 0, rank: 0, days: 1,
      act1: null, full: null, fullDeaths: null, splits: {}, bosses: {},
    });

    const list = await admin(`/accounts?q=${tag.toUpperCase()}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.deepEqual({ ...list.body.rows[0], created: 0, lastSeen: 0 }, {
      id, email, name: '', role: 'player', status: 'active', created: 0, lastSeen: 0, saves: 1, super: false,
    });
    assert.equal(list.body.rows[0].created, s.clock.t);

    const one = await admin(`/accounts/${id}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.saves[0].bytes, 15);
    assert.equal(one.body.sessions.length, 1);
    assert.equal(one.body.record.build, 'b1');
    assert.equal((await admin('/accounts/not-a-uuid')).status, 404);
    assert.equal((await admin('/accounts/00000000-0000-4000-8000-000000000000')).status, 404);

    const name = `N${randomBytes(4).toString('hex')}`;
    assert.equal((await admin(`/accounts/${id}`, { method: 'POST', body: { name } })).body.account.name, name);
    assert.equal((await store.getRecord(rid)).name, name);
    assert.deepEqual((await admin(`/accounts?q=${name.toLowerCase()}`)).body.rows.map((r) => r.id), [id]);
    assert.deepEqual((await admin(`/accounts/${id}`, { method: 'POST', body: { tools: ['monsters', 'start'] } })).body.account.tools, ['start', 'monsters']);
    assert.equal((await admin(`/accounts/${id}`, { method: 'POST', body: { role: 'tester' } })).body.account.role, 'tester');
    assert.equal((await admin(`/accounts?q=${tag}&role=tester&status=active`)).body.total, 1);
    const off = await admin(`/accounts/${id}`, { method: 'POST', body: { status: 'disabled' } });
    assert.equal(off.body.account.status, 'disabled');
    assert.equal((await s.api('/v1/me', { cookie: me.token })).status, 401);

    const save = await admin(`/accounts/${id}/saves/2`);
    assert.deepEqual(save.body, { slot: 2, name: 'Save 2', test: false, at: 5, objective: 'Lamp', rec: { play: 9, pct: 1, rank: 0 }, body: '{"v":1,"x":"é"}' });
    assert.deepEqual((await admin(`/accounts/${id}/saves/3`)).body, { error: 'no_save' });

    const boss = await s.signIn(SUPER);
    assert.deepEqual(await admin(`/accounts/${boss.id}`, { method: 'POST', body: { role: 'player' } }), { status: 409, body: { error: 'super' } });
    assert.deepEqual(await admin(`/accounts/${boss.id}`, { method: 'DELETE' }), { status: 409, body: { error: 'super' } });

    const audit = await admin('/audit?per=200');
    const mine = audit.body.rows.filter((r) => r.account_id === id);
    assert.deepEqual(mine.map((r) => r.action), ['save-download', 'disable', 'role', 'tools', 'name']);
    assert.ok(mine.every((r) => r.email === email && r.admin_email === 'lead@example.test' && typeof r.at === 'number'));

    assert.deepEqual((await admin(`/accounts/${id}`, { method: 'DELETE' })).body, { ok: true });
    assert.equal(await store.accounts.byId(id), null);
    assert.equal(await store.getRecord(rid), null);
    assert.equal(await store.slots.count(id), 0);
    const after = (await admin('/audit?per=200')).body.rows.filter((r) => r.account_id === id);
    assert.equal(after[0].action, 'delete');
    assert.ok(after.every((r) => r.email === null)); // the join finds no account now

    const before = (await admin('/settings')).body.testerTools;
    assert.deepEqual((await admin('/settings', { method: 'PUT', body: { testerTools: ['map'] } })).body, { ok: true, testerTools: ['map'] });
    assert.deepEqual((await admin('/settings')).body, { testerTools: ['map'] });
    await admin('/settings', { method: 'PUT', body: { testerTools: before } });
  });
}
