// The behaviour every store must have for the account tables. Used by accounts_store.test.js (memory) and
// pg_accounts.test.js (Postgres). Spec: ACCOUNTS.md (section 2).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

const hex = () => randomBytes(32).toString('hex');
const uniqueEmail = () => `k${randomBytes(6).toString('hex')}@example.test`;
const uniqueName = () => `K${randomBytes(5).toString('hex')}`.slice(0, 12);
const rec = (name) => ({
  name, nameKey: name === undefined ? undefined : name.toLowerCase(), crew: undefined, build: 'b', play: 100, deaths: 0,
  pct: 1, badges: 0, rank: 0, days: 1, act1: null, full: null, fullDeaths: null, splits: {}, bosses: {},
});

/** @param getStore () => an initialised store */
export function runAccountStoreContract(label, getStore) {
  const T0 = 1_800_000_000_000;

  test(`${label}: accounts.signIn creates once, then finds; role is set when given`, async () => {
    const s = getStore();
    const email = uniqueEmail();
    assert.equal(await s.accounts.byEmail(email), null);
    const a = await s.accounts.signIn(email, { at: T0 });
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      { email: a.email, role: a.role, tools: a.tools, displayName: a.displayName, nameKey: a.nameKey, status: a.status,
        passwordHash: a.passwordHash, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt },
      { email, role: 'player', tools: [], displayName: '', nameKey: '', status: 'active', passwordHash: null, createdAt: T0, lastSeenAt: T0 },
    );
    const again = await s.accounts.signIn(email, { at: T0 + 5 });
    assert.equal(again.id, a.id);
    assert.equal(again.createdAt, T0);
    assert.equal(again.lastSeenAt, T0 + 5);
    assert.equal((await s.accounts.signIn(email, { at: T0 + 6, role: 'admin' })).role, 'admin');
    assert.equal((await s.accounts.byId(a.id)).role, 'admin');
    assert.equal((await s.accounts.signIn(email, { at: T0 + 7 })).role, 'admin'); // no role given: kept
    assert.equal(await s.accounts.byId('not-a-uuid'), null);
    assert.equal(await s.accounts.byId('00000000-0000-4000-8000-000000000000'), null);
  });

  test(`${label}: accounts.update, setPassword, touch`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const u = await s.accounts.update(a.id, { role: 'tester', tools: ['cheats', 'monsters'], status: 'disabled' });
    assert.deepEqual([u.role, u.tools, u.status], ['tester', ['cheats', 'monsters'], 'disabled']);
    const u2 = await s.accounts.update(a.id, { status: 'active' });
    assert.deepEqual([u2.role, u2.tools, u2.status], ['tester', ['cheats', 'monsters'], 'active']);
    assert.equal(await s.accounts.setPassword(a.id, 'scrypt$x'), true);
    assert.equal((await s.accounts.byId(a.id)).passwordHash, 'scrypt$x');
    await s.accounts.touch(a.id, T0 + 99);
    assert.equal((await s.accounts.byId(a.id)).lastSeenAt, T0 + 99);
    assert.equal(await s.accounts.update('00000000-0000-4000-8000-000000000000', { role: 'admin' }), null);
  });

  test(`${label}: keeper names are unique across accounts and guest records, ignoring case`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const b = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const n = uniqueName();
    assert.deepEqual(await s.accounts.setName(a.id, { name: n, key: n.toLowerCase() }), { status: 'ok' });
    assert.equal((await s.accounts.byId(a.id)).displayName, n);
    assert.deepEqual(await s.accounts.setName(b.id, { name: n.toUpperCase(), key: n.toLowerCase() }), { status: 'name_taken' });
    // A guest's board name blocks it too.
    const guest = hex();
    const g = uniqueName();
    await s.putSave(guest, { at: 1, objective: '', body: 'x' });
    assert.equal((await s.putRecord(guest, rec(g))).status, 'ok');
    assert.deepEqual(await s.accounts.setName(b.id, { name: g, key: g.toLowerCase() }), { status: 'name_taken' });
    // Setting your own name again is fine; '' clears and frees it.
    assert.deepEqual(await s.accounts.setName(a.id, { name: n, key: n.toLowerCase() }), { status: 'ok' });
    assert.deepEqual(await s.accounts.setName(a.id, { name: '', key: '' }), { status: 'ok' });
    assert.deepEqual(await s.accounts.setName(b.id, { name: n, key: n.toLowerCase() }), { status: 'ok' });
    // Two accounts may both have no name.
    assert.deepEqual(await s.accounts.setName(a.id, { name: '', key: '' }), { status: 'ok' });
  });

  test(`${label}: setName keeps the account's record row ('a:' + id) in step`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const rid = s.accounts.recordId(a.id);
    assert.equal(rid, `a:${a.id}`);
    // The account record row as the record routes will write it (here through the guest path, which needs a save row).
    await s.putSave(rid, { at: 1, objective: '', body: 'x' });
    await s.putRecord(rid, rec(undefined));
    const n = uniqueName();
    assert.deepEqual(await s.accounts.setName(a.id, { name: n, key: n.toLowerCase() }), { status: 'ok' });
    assert.equal((await s.getRecord(rid)).name, n);
    assert.deepEqual(await s.accounts.setName(a.id, { name: '', key: '' }), { status: 'ok' });
    assert.equal((await s.getRecord(rid)).name, '');
  });

  test(`${label}: accounts.delete removes the account, its sessions, slots and record row`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const other = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const rid = s.accounts.recordId(a.id);
    await s.putSave(rid, { at: 1, objective: '', body: 'x' });
    await s.putRecord(rid, rec(uniqueName()));
    const h1 = hex();
    const h2 = hex();
    await s.sessions.create({ tokenHash: h1, accountId: a.id, at: T0, expiresAt: T0 + 1000, note: '' });
    await s.sessions.create({ tokenHash: h2, accountId: other.id, at: T0, expiresAt: T0 + 1000, note: '' });
    await s.slots.put(a.id, 1, { at: 5, objective: 'o', body: 'b' }, { updatedAt: T0 });
    await s.slots.put(other.id, 1, { at: 5, objective: 'o', body: 'b' }, { updatedAt: T0 });
    assert.equal(await s.accounts.delete(a.id), true);
    assert.equal(await s.accounts.byId(a.id), null);
    assert.equal(await s.sessions.get(h1), null);
    assert.equal(await s.slots.count(a.id), 0);
    assert.equal(await s.getRecord(rid), null);
    // Nothing of the other account was touched.
    assert.ok(await s.sessions.get(h2));
    assert.equal(await s.slots.count(other.id), 1);
    assert.equal(await s.accounts.delete(a.id), false);
  });

  test(`${label}: sessions create, get, renew, touch, list, delete, deleteForAccount(except), prune`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const [h1, h2, h3] = [hex(), hex(), hex()];
    await s.sessions.create({ tokenHash: h1, accountId: a.id, at: T0, expiresAt: T0 + 1000, note: 'Chrome on Android' });
    await s.sessions.create({ tokenHash: h2, accountId: a.id, at: T0 + 1, expiresAt: T0 + 2000, note: '' });
    await s.sessions.create({ tokenHash: h3, accountId: a.id, at: T0 + 2, expiresAt: T0 + 3000, note: '' });
    assert.deepEqual(await s.sessions.get(h1), {
      tokenHash: h1, accountId: a.id, createdAt: T0, renewedAt: T0, expiresAt: T0 + 1000, lastUsedAt: T0, note: 'Chrome on Android',
    });
    await s.sessions.renew(h1, { at: T0 + 10, expiresAt: T0 + 5000 });
    const r = await s.sessions.get(h1);
    assert.deepEqual([r.renewedAt, r.lastUsedAt, r.expiresAt, r.createdAt], [T0 + 10, T0 + 10, T0 + 5000, T0]);
    await s.sessions.touch(h1, T0 + 20);
    assert.equal((await s.sessions.get(h1)).lastUsedAt, T0 + 20);
    assert.deepEqual((await s.sessions.listForAccount(a.id)).map((x) => x.tokenHash), [h3, h2, h1]);
    assert.equal(await s.sessions.deleteForAccount(a.id, { except: h1 }), 2);
    assert.deepEqual((await s.sessions.listForAccount(a.id)).map((x) => x.tokenHash), [h1]);
    assert.equal(await s.sessions.delete(h1), true);
    assert.equal(await s.sessions.delete(h1), false);
    const old = hex();
    await s.sessions.create({ tokenHash: old, accountId: a.id, at: T0, expiresAt: T0 + 10, note: '' });
    const keep = hex();
    await s.sessions.create({ tokenHash: keep, accountId: a.id, at: T0, expiresAt: T0 + 10_000_000, note: '' });
    assert.ok((await s.sessions.prune(T0 + 11)) >= 1);
    assert.equal(await s.sessions.get(old), null);
    assert.ok(await s.sessions.get(keep));
  });

  test(`${label}: sign-ins: tries are counted before comparing, five at most, even in parallel`, async () => {
    const s = getStore();
    const id = randomBytes(16).toString('base64url');
    await s.signIns.create({ id, email: 'x@example.test', linkHash: hex(), codeHash: 'c', at: T0, expiresAt: T0 + 900_000 });
    const results = await Promise.all(Array.from({ length: 12 }, () => s.signIns.takeTry(id, { at: T0 + 1, maxTries: 5 })));
    const got = results.filter(Boolean);
    assert.equal(got.length, 5);
    assert.deepEqual(got.map((r) => r.tries).sort(), [1, 2, 3, 4, 5]);
    assert.equal(got[0].email, 'x@example.test');
    assert.equal(got[0].codeHash, 'c');
    assert.equal(await s.signIns.takeTry(id, { at: T0 + 2, maxTries: 5 }), null);
    assert.equal(await s.signIns.takeTry('unknown-id-xyz', { at: T0, maxTries: 5 }), null);
  });

  test(`${label}: sign-ins: use and useLink work once, and not after expiry; either spends both`, async () => {
    const s = getStore();
    const mk = async () => {
      const id = randomBytes(16).toString('base64url');
      const linkHash = hex();
      await s.signIns.create({ id, email: 'y@example.test', linkHash, codeHash: 'c', at: T0, expiresAt: T0 + 1000 });
      return { id, linkHash };
    };
    const a = await mk();
    assert.equal(await s.signIns.use(a.id, T0 + 1), 'y@example.test');
    assert.equal(await s.signIns.use(a.id, T0 + 2), null);
    assert.equal(await s.signIns.useLink(a.linkHash, T0 + 2), null);
    assert.equal(await s.signIns.takeTry(a.id, { at: T0 + 2, maxTries: 5 }), null);
    const b = await mk();
    assert.equal(await s.signIns.useLink(b.linkHash, T0 + 1), 'y@example.test');
    assert.equal(await s.signIns.useLink(b.linkHash, T0 + 1), null);
    assert.equal(await s.signIns.use(b.id, T0 + 1), null);
    const c = await mk();
    assert.equal(await s.signIns.use(c.id, T0 + 1000), null); // expired at exactly expiresAt
    assert.equal(await s.signIns.useLink(c.linkHash, T0 + 1000), null);
    // Parallel uses: exactly one wins.
    const d = await mk();
    const wins = await Promise.all([s.signIns.use(d.id, T0 + 1), s.signIns.useLink(d.linkHash, T0 + 1), s.signIns.use(d.id, T0 + 1)]);
    assert.equal(wins.filter(Boolean).length, 1);
  });

  test(`${label}: sign-ins: deleteForEmail and prune`, async () => {
    const s = getStore();
    const email = uniqueEmail();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = randomBytes(16).toString('base64url');
      ids.push(id);
      await s.signIns.create({ id, email, linkHash: hex(), codeHash: 'c', at: T0, expiresAt: T0 + 1000 });
    }
    assert.equal(await s.signIns.deleteForEmail(email), 3);
    assert.equal(await s.signIns.use(ids[0], T0 + 1), null);
    const id = randomBytes(16).toString('base64url');
    await s.signIns.create({ id, email, linkHash: hex(), codeHash: 'c', at: T0, expiresAt: T0 + 1000 });
    assert.equal(await s.signIns.prune(T0 + 1000 + 3_600_000), 0); // kept a day after expiry
    assert.ok((await s.signIns.prune(T0 + 1000 + 86_400_000)) >= 1);
  });

  test(`${label}: slots put/get/list/rename/delete; test is sticky; default name; rec kept`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    assert.deepEqual(await s.slots.list(a.id), []);
    assert.equal(await s.slots.get(a.id, 1), null);
    assert.deepEqual(await s.slots.put(a.id, 3, { at: 10, objective: 'o', body: 'body-3', rec: { play: 5, pct: 1, rank: 0, ri: 2 } }, { updatedAt: T0 }),
      { at: 10, test: false, created: true });
    assert.deepEqual(await s.slots.get(a.id, 3), {
      slot: 3, name: 'Save 3', test: false, at: 10, objective: 'o', rec: { play: 5, pct: 1, rank: 0, ri: 2 }, body: 'body-3', updated: T0,
    });
    assert.deepEqual(await s.slots.put(a.id, 3, { at: 11, objective: 'p', body: 'b2', test: true }, { updatedAt: T0 + 1 }),
      { at: 11, test: true, created: false });
    assert.deepEqual(await s.slots.put(a.id, 3, { at: 12, objective: 'q', body: 'b3', test: false, name: 'Mine' }, { updatedAt: T0 + 2 }),
      { at: 12, test: true, created: false });
    const g = await s.slots.get(a.id, 3);
    assert.deepEqual([g.name, g.test, g.rec, g.body], ['Mine', true, { play: 5, pct: 1, rank: 0, ri: 2 }, 'b3']);
    await s.slots.put(a.id, 1, { at: 1, objective: '', body: 'xyz' }, { updatedAt: T0 });
    assert.deepEqual(await s.slots.list(a.id), [
      { slot: 1, name: 'Save 1', test: false, at: 1, objective: '', rec: null, updated: T0, bytes: 3 },
      { slot: 3, name: 'Mine', test: true, at: 12, objective: 'q', rec: { play: 5, pct: 1, rank: 0, ri: 2 }, updated: T0 + 2, bytes: 2 },
    ]);
    assert.equal(await s.slots.count(a.id), 2);
    assert.equal(await s.slots.rename(a.id, 1, 'First'), true);
    assert.equal(await s.slots.rename(a.id, 7, 'None'), false);
    assert.equal((await s.slots.get(a.id, 1)).name, 'First');
    assert.equal(await s.slots.delete(a.id, 3), true);
    assert.equal(await s.slots.delete(a.id, 3), false);
    // A deleted slot starts again with test false.
    await s.slots.put(a.id, 3, { at: 20, objective: '', body: 'n' }, { updatedAt: T0 });
    assert.equal((await s.slots.get(a.id, 3)).test, false);
    assert.equal(await s.slots.deleteAll(a.id), 2);
    assert.equal(await s.slots.count(a.id), 0);
  });

  test(`${label}: audit add/list (newest first, with the account's email) and settings get/set`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const action = `test-${randomBytes(4).toString('hex')}`;
    const far = 4_000_000_000_000 + Date.now() * 2; // later than any earlier run's rows in a shared database
    await s.audit.add({ at: far, adminEmail: 'boss@example.test', action, accountId: a.id, detail: { role: 'tester' } });
    await s.audit.add({ at: far + 1, adminEmail: 'boss@example.test', action, accountId: null });
    const page = await s.audit.list({ page: 1, per: 2 });
    assert.ok(page.total >= 2);
    assert.deepEqual(page.rows, [
      { at: far + 1, adminEmail: 'boss@example.test', action, accountId: null, email: null, detail: {} },
      { at: far, adminEmail: 'boss@example.test', action, accountId: a.id, email: a.email, detail: { role: 'tester' } },
    ]);
    const key = `k-${randomBytes(4).toString('hex')}`;
    assert.equal(await s.settings.get(key), null);
    await s.settings.set(key, ['start', 'map']);
    assert.deepEqual(await s.settings.get(key), ['start', 'map']);
    await s.settings.set(key, { x: 1 });
    assert.deepEqual(await s.settings.get(key), { x: 1 });
  });
  test(`${label}: admin.listAccounts: q on email or keeper name (any case, literal), role, status, paging, newest first, saves`, async () => {
    const s = getStore();
    const tag = `z${randomBytes(4).toString('hex')}`; // keeps this run's rows apart in a shared database
    const mk = async (i, at) => s.accounts.signIn(`${tag}-${i}@example.test`, { at });
    const a = await mk(1, T0 + 1);
    const b = await mk(2, T0 + 3);
    const c = await mk(3, T0 + 2);
    const named = await s.accounts.signIn(`other${randomBytes(4).toString('hex')}@example.test`, { at: T0 + 4 });
    const n = `Q${randomBytes(5).toString("hex")}`.slice(0, 12);
    assert.equal((await s.accounts.setName(named.id, { name: n, key: n.toLowerCase() })).status, 'ok');
    await s.accounts.update(b.id, { role: 'tester' });
    await s.accounts.update(c.id, { status: 'disabled' });
    await s.slots.put(a.id, 1, { at: 1, objective: '', body: 'x' }, { updatedAt: T0 });
    await s.slots.put(a.id, 4, { at: 1, objective: '', body: 'y' }, { updatedAt: T0 });

    const all = await s.admin.listAccounts({ q: tag.toUpperCase() });
    assert.equal(all.total, 3);
    assert.deepEqual(all.rows.map((r) => r.id), [b.id, c.id, a.id]);
    assert.deepEqual(all.rows[2], {
      id: a.id, email: a.email, displayName: '', role: 'player', status: 'active', createdAt: T0 + 1, lastSeenAt: T0 + 1, saves: 2,
    });
    assert.equal(all.rows[0].saves, 0);
    // The keeper name matches too, ignoring case; % and _ are literal.
    assert.deepEqual((await s.admin.listAccounts({ q: n.slice(1).toLowerCase() })).rows.map((r) => r.id), [named.id]);
    assert.equal((await s.admin.listAccounts({ q: `${tag}%` })).total, 0);
    assert.equal((await s.admin.listAccounts({ q: `${tag}_1` })).total, 0);
    assert.deepEqual((await s.admin.listAccounts({ q: tag, role: 'tester' })).rows.map((r) => r.id), [b.id]);
    assert.deepEqual((await s.admin.listAccounts({ q: tag, status: 'disabled' })).rows.map((r) => r.id), [c.id]);
    assert.deepEqual((await s.admin.listAccounts({ q: tag, role: 'player', status: 'active' })).rows.map((r) => r.id), [a.id]);
    const p2 = await s.admin.listAccounts({ q: tag, page: 2, per: 2 });
    assert.deepEqual([p2.total, p2.rows.map((r) => r.id)], [3, [a.id]]);
    assert.deepEqual((await s.admin.listAccounts({ q: tag, page: 9, per: 2 })).rows, []);
    const everyone = await s.admin.listAccounts({ per: 500 });
    assert.ok(everyone.total >= 4 && everyone.rows.length <= 200);
  });
}
