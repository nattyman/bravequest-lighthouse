// The behaviour every store must have for account save slots and claims (store.slots.put with ifNewer,
// store.slots.claim) and for account records (putRecord with needSave:false, names held by accounts).
// Used by slots_store.test.js (memory) and pg_slots.test.js (Postgres). Spec: ACCOUNTS.md (sections 2 and 3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cleanName } from '../src/records.js';

const hex = () => randomBytes(32).toString('hex');
const uniqueEmail = () => `s${randomBytes(6).toString('hex')}@example.test`;
/** A random keeper name that passes the name rules (a random one can hit a blocked word). */
const uniqueName = () => {
  for (;;) {
    const n = `S${randomBytes(5).toString('hex')}`.slice(0, 12);
    if (cleanName(n)) return n;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 1_800_000_000_000;

export const rec = (over = {}) => {
  const name = over.name;
  return {
    name, nameKey: name === undefined ? undefined : name.toLowerCase(), crew: undefined, build: 'b', play: 100, deaths: 0,
    pct: 1, badges: 0, rank: 0, days: 1, act1: null, full: null, fullDeaths: null, splits: {}, bosses: {}, ...over,
  };
};

/** Gives an account a name directly, without the uniqueness check (to stage a clash that the API never allows). */
async function forceAccountName(s, id, name) {
  if (s.kind === 'memory') {
    const a = s._mem.accounts.get(id);
    a.displayName = name;
    a.nameKey = name.toLowerCase();
  } else {
    await s._pool.query('UPDATE accounts SET display_name = $2, name_key = $3 WHERE id = $1::uuid', [id, name, name.toLowerCase()]);
  }
}

/** A guest with a save and (optionally) a record. -> guest id */
async function guest(s, { at = 500, record } = {}) {
  const id = hex();
  await s.putSave(id, { at, objective: 'Find the lamp', body: `guest-body-${id.slice(0, 6)}` });
  if (record) assert.equal((await s.putRecord(id, rec(record))).status, 'ok');
  return id;
}

/** @param getStore () => an initialised store */
export function runSlotStoreContract(label, getStore) {
  test(`${label}: slots.put with ifNewer: newer wins, as the guest putSave`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    assert.deepEqual(await s.slots.put(a.id, 2, { at: 100, objective: 'o', body: 'one' }, { updatedAt: T0, ifNewer: true }),
      { at: 100, test: false, created: true });
    // Same at, then older: nothing written, the stored at comes back.
    assert.deepEqual(await s.slots.put(a.id, 2, { at: 100, objective: 'x', body: 'two', test: true, name: 'N' }, { updatedAt: T0 + 1, ifNewer: true }),
      { stale: true, at: 100 });
    assert.deepEqual(await s.slots.put(a.id, 2, { at: 99, objective: 'x', body: 'two' }, { updatedAt: T0 + 1, ifNewer: true }),
      { stale: true, at: 100 });
    const g = await s.slots.get(a.id, 2);
    assert.deepEqual([g.body, g.objective, g.test, g.name, g.updated], ['one', 'o', false, 'Save 2', T0]);
    assert.deepEqual(await s.slots.put(a.id, 2, { at: 101, objective: 'p', body: 'three', test: true }, { updatedAt: T0 + 2, ifNewer: true }),
      { at: 101, test: true, created: false });
    // Without ifNewer the write always happens (the admin and older callers).
    assert.deepEqual(await s.slots.put(a.id, 2, { at: 5, objective: 'q', body: 'four' }, { updatedAt: T0 + 3 }),
      { at: 5, test: true, created: false });
    assert.equal((await s.slots.get(a.id, 2)).body, 'four');
  });

  test(`${label}: claim moves the guest save into the first free slot and retires the guest`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    await s.slots.put(a.id, 1, { at: 1, objective: '', body: 'mine' }, { updatedAt: T0 });
    const gname = uniqueName();
    const g = await guest(s, { at: 777, record: { name: gname, crew: 'CREW1', act1: 900, bosses: { stag: 50 } } });
    const r = await s.slots.claim(a.id, g, { at: T0 + 10 });
    assert.deepEqual(r, { status: 'ok', slot: 2, name: gname });
    assert.deepEqual(await s.slots.get(a.id, 2), {
      slot: 2, name: 'Save 2', test: false, at: 777, objective: 'Find the lamp', rec: null, body: `guest-body-${g.slice(0, 6)}`, updated: T0 + 10,
    });
    assert.equal(await s.getSave(g), null);
    assert.equal(await s.getRecord(g), null);
    // The account had no record and no name: both come from the guest's.
    const acct = await s.accounts.byId(a.id);
    assert.deepEqual([acct.displayName, acct.nameKey], [gname, gname.toLowerCase()]);
    const ar = await s.getRecord(s.accounts.recordId(a.id));
    assert.deepEqual([ar.name, ar.crew, ar.act1, ar.bosses], [gname, 'CREW1', 900, { stag: 50 }]);
    // The same code again: there is nothing left under it.
    assert.deepEqual(await s.slots.claim(a.id, g, { at: T0 + 11 }), { status: 'no_save' });
  });

  test(`${label}: claim into a chosen slot; slot_taken, full, no_save, no_account`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const g = await guest(s);
    assert.deepEqual(await s.slots.claim(a.id, g, { slot: 7, at: T0 }), { status: 'ok', slot: 7, name: '' });
    const g2 = await guest(s);
    assert.deepEqual(await s.slots.claim(a.id, g2, { slot: 7, at: T0 }), { status: 'slot_taken' });
    assert.ok(await s.getSave(g2));
    for (let n = 1; n <= 10; n++) if (n !== 7) await s.slots.put(a.id, n, { at: 1, objective: '', body: 'x' }, { updatedAt: T0 });
    assert.deepEqual(await s.slots.claim(a.id, g2, { at: T0 }), { status: 'full' });
    assert.ok(await s.getSave(g2));
    assert.deepEqual(await s.slots.claim(a.id, hex(), { at: T0 }), { status: 'no_save' });
    assert.deepEqual(await s.slots.claim('00000000-0000-4000-8000-000000000000', g2, { at: T0 }), { status: 'no_account' });
    assert.deepEqual(await s.slots.claim('nope', g2, { at: T0 }), { status: 'no_account' });
    assert.equal((await s.slots.get(a.id, 7)).test, false);
  });

  test(`${label}: claim merges records: bests only improve, the latest upload wins the rest`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const aname = uniqueName();
    assert.deepEqual(await s.accounts.setName(a.id, { name: aname, key: aname.toLowerCase() }), { status: 'ok' });
    const rid = s.accounts.recordId(a.id);
    assert.equal((await s.putRecord(rid, rec({
      play: 5000, pct: 40, badges: 3, act1: 800, full: 3000, fullDeaths: 9, bosses: { stag: 60, crane: 70 }, splits: { ashore: 5 },
    }), { needSave: false })).status, 'ok');
    await sleep(15);
    const gname = uniqueName();
    const g = await guest(s, { record: {
      name: gname, crew: 'GUESTS', play: 4000, pct: 30, badges: 1, act1: 700, full: 3500, fullDeaths: 4,
      bosses: { stag: 80, giant: 90 }, splits: { ashore: 7, stag: 9 },
    } });
    assert.deepEqual(await s.slots.claim(a.id, g, { at: T0 }), { status: 'ok', slot: 1, name: aname });
    const m = await s.getRecord(rid);
    assert.deepEqual(
      { name: m.name, crew: m.crew, act1: m.act1, full: m.full, fullDeaths: m.fullDeaths, bosses: m.bosses, play: m.play, pct: m.pct, badges: m.badges, splits: m.splits },
      { name: aname, crew: 'GUESTS', act1: 700, full: 3000, fullDeaths: 4, bosses: { stag: 60, crane: 70, giant: 90 }, play: 4000, pct: 30, badges: 1, splits: { ashore: 7, stag: 9 } },
    );
    // The account kept its own name; the guest's is free again.
    assert.equal((await s.accounts.byId(a.id)).displayName, aname);
    const b = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    assert.deepEqual(await s.accounts.setName(b.id, { name: gname, key: gname.toLowerCase() }), { status: 'ok' });

    // The other way round: the account's record was uploaded last, so its latest fields stay; its crew stays.
    await s.putRecord(rid, rec({ play: 9000, pct: 60, crew: 'MINE1' }), { needSave: false });
    const g2 = await guest(s, { record: { play: 1, pct: 99, act1: 650 } });
    await sleep(15);
    await s.putRecord(rid, rec({ play: 9100, pct: 61 }), { needSave: false });
    assert.equal((await s.slots.claim(a.id, g2, { at: T0 })).status, 'ok');
    const m2 = await s.getRecord(rid);
    assert.deepEqual([m2.play, m2.pct, m2.crew, m2.act1], [9100, 61, 'MINE1', 650]);
  });

  test(`${label}: claim carries the name only when the account has none and nobody else holds it`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const other = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const gname = uniqueName();
    const g = await guest(s, { record: { name: gname } });
    await forceAccountName(s, other.id, gname); // a clash the API never allows
    assert.deepEqual(await s.slots.claim(a.id, g, { at: T0 }), { status: 'ok', slot: 1, name: '' });
    assert.equal((await s.accounts.byId(a.id)).displayName, '');
    assert.equal((await s.getRecord(s.accounts.recordId(a.id))).name, '');
    // A guest with no record: the account's name and record are untouched.
    const aname = uniqueName();
    await s.accounts.setName(a.id, { name: aname, key: aname.toLowerCase() });
    assert.deepEqual(await s.slots.claim(a.id, await guest(s), { at: T0 }), { status: 'ok', slot: 2, name: aname });
    assert.equal((await s.getRecord(s.accounts.recordId(a.id))).name, aname);
  });

  test(`${label}: parallel claims: one code is claimed once; one account's claims get different slots`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const b = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const g = await guest(s, { record: { name: uniqueName() } });
    const both = await Promise.all([s.slots.claim(a.id, g, { at: T0 }), s.slots.claim(b.id, g, { at: T0 })]);
    assert.deepEqual(both.map((r) => r.status).sort(), ['no_save', 'ok']);
    assert.equal((await s.slots.count(a.id)) + (await s.slots.count(b.id)), 1);
    const c = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const three = await Promise.all([1, 2, 3].map(async () => s.slots.claim(c.id, await guest(s), { at: T0 })));
    assert.deepEqual(three.map((r) => r.slot).sort(), [1, 2, 3]);
  });

  test(`${label}: a claim that fails part-way changes nothing`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const gname = uniqueName();
    const g = await guest(s, { at: 321, record: { name: gname, act1: 600 } });
    const guestRec = await s.getRecord(g);
    await assert.rejects(
      s.slots.claim(a.id, g, { at: T0, beforeCommit: () => { throw new Error('boom'); } }),
      /boom/,
    );
    assert.deepEqual(await s.getSave(g), { at: 321, objective: 'Find the lamp', body: `guest-body-${g.slice(0, 6)}` });
    assert.deepEqual(await s.getRecord(g), guestRec);
    assert.equal(await s.slots.count(a.id), 0);
    assert.equal(await s.getRecord(s.accounts.recordId(a.id)), null);
    assert.equal((await s.accounts.byId(a.id)).displayName, '');
    // And it works afterwards.
    assert.deepEqual(await s.slots.claim(a.id, g, { at: T0 }), { status: 'ok', slot: 1, name: gname });
    // Deleting the account then leaves nothing of either behind.
    assert.equal(await s.accounts.delete(a.id), true);
    assert.equal(await s.slots.count(a.id), 0);
    assert.equal(await s.getRecord(s.accounts.recordId(a.id)), null);
    assert.equal(await s.getSave(g), null);
    assert.equal(await s.getRecord(g), null);
    const b = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    assert.deepEqual(await s.accounts.setName(b.id, { name: gname, key: gname.toLowerCase() }), { status: 'ok' });
  });

  test(`${label}: putRecord: needSave:false for an account record; a name an account holds is taken`, async () => {
    const s = getStore();
    const a = await s.accounts.signIn(uniqueEmail(), { at: T0 });
    const rid = s.accounts.recordId(a.id);
    assert.deepEqual(await s.putRecord(rid, rec()), { status: 'no_save' });
    assert.equal((await s.putRecord(rid, rec(), { needSave: false })).status, 'ok');
    const n = uniqueName();
    await s.accounts.setName(a.id, { name: n, key: n.toLowerCase() });
    const g = await guest(s);
    assert.deepEqual(await s.putRecord(g, rec({ name: n.toUpperCase() })), { status: 'name_taken' });
    // The account's own record may carry it.
    assert.equal((await s.putRecord(rid, rec({ name: n }), { needSave: false })).status, 'ok');
  });
}
