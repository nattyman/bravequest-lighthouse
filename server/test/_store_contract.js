// The behaviour every store must have. Used by store.test.js (memory) and pg.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

const newId = () => randomBytes(32).toString('hex');

/**
 * @param label   name shown in test output
 * @param getStore   () => store (already initialised)
 * @param inspect   { events(sid) -> rows, feedback(build) -> rows } for reading back what was written,
 *                  and hide(id) to mark a record hidden (moderation is done outside the service)
 */
export function runStoreContract(label, getStore, inspect) {
  test(`${label}: ping resolves`, async () => {
    await getStore().ping();
  });

  test(`${label}: getSave returns null for an unknown id`, async () => {
    assert.equal(await getStore().getSave(newId()), null);
  });

  test(`${label}: put creates, get returns it`, async () => {
    const store = getStore();
    const id = newId();
    const r = await store.putSave(id, { at: 1700000000000, objective: 'Find Hesper', body: 'payload-1' });
    assert.deepEqual(r, { status: 'ok', at: 1700000000000, created: true });
    assert.deepEqual(await store.getSave(id), { at: 1700000000000, objective: 'Find Hesper', body: 'payload-1' });
  });

  test(`${label}: newer put replaces and is not "created"`, async () => {
    const store = getStore();
    const id = newId();
    await store.putSave(id, { at: 10, objective: 'a', body: 'one' });
    const r = await store.putSave(id, { at: 11, objective: 'b', body: 'two' });
    assert.deepEqual(r, { status: 'ok', at: 11, created: false });
    assert.deepEqual(await store.getSave(id), { at: 11, objective: 'b', body: 'two' });
  });

  test(`${label}: equal or older put is stale and changes nothing`, async () => {
    const store = getStore();
    const id = newId();
    await store.putSave(id, { at: 50, objective: 'keep', body: 'kept' });
    assert.deepEqual(await store.putSave(id, { at: 50, objective: 'x', body: 'same-at' }), { status: 'stale', at: 50 });
    assert.deepEqual(await store.putSave(id, { at: 49, objective: 'x', body: 'older' }), { status: 'stale', at: 50 });
    assert.deepEqual(await store.getSave(id), { at: 50, objective: 'keep', body: 'kept' });
  });

  test(`${label}: allowCreate=false refuses new ids but still updates and reports stale`, async () => {
    const store = getStore();
    const id = newId();
    assert.deepEqual(await store.putSave(id, { at: 5, objective: '', body: 'x' }, { allowCreate: false }), {
      status: 'create_denied',
    });
    assert.equal(await store.getSave(id), null);
    await store.putSave(id, { at: 5, objective: '', body: 'x' });
    assert.deepEqual(await store.putSave(id, { at: 6, objective: 'o', body: 'y' }, { allowCreate: false }), {
      status: 'ok',
      at: 6,
      created: false,
    });
    assert.deepEqual(await store.putSave(id, { at: 6, objective: 'o', body: 'z' }, { allowCreate: false }), {
      status: 'stale',
      at: 6,
    });
    assert.deepEqual(await store.getSave(id), { at: 6, objective: 'o', body: 'y' });
  });

  test(`${label}: concurrent puts leave the newest save`, async () => {
    const store = getStore();
    const id = newId();
    const ats = Array.from({ length: 20 }, (_, i) => i + 1);
    const results = await Promise.all(
      ats.map((at) => store.putSave(id, { at, objective: `o${at}`, body: `b${at}` })),
    );
    assert.equal(results.filter((r) => r.status === 'ok' && r.created).length, 1);
    assert.deepEqual(await store.getSave(id), { at: 20, objective: 'o20', body: 'b20' });
  });

  test(`${label}: a large unicode save body round-trips`, async () => {
    const store = getStore();
    const id = newId();
    const body = 'é🗼'.repeat(40000) + 'x'.repeat(125760);
    await store.putSave(id, { at: 1, objective: 'Ünïcode ✨', body });
    const row = await store.getSave(id);
    assert.equal(row.body, body);
    assert.equal(row.objective, 'Ünïcode ✨');
  });

  test(`${label}: addEvent stores name, build, platform, sid and a timestamp`, async () => {
    const store = getStore();
    const sid = randomBytes(8).toString('hex');
    await store.addEvent({ name: 'cave.enter', build: 'b1', platform: 'pad', sid });
    const rows = await inspect.events(sid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'cave.enter');
    assert.equal(rows[0].build, 'b1');
    assert.equal(rows[0].platform, 'pad');
    assert.equal(rows[0].sid, sid);
    assert.ok(rows[0].createdAt);
  });

  test(`${label}: addFeedback stores the fields, optional ones default to ''`, async () => {
    const store = getStore();
    const build = 'fb-' + randomBytes(6).toString('hex');
    await store.addFeedback({ text: 'first', build, platform: 'touch' });
    await store.addFeedback({ text: 'second', build, platform: 'keyboard', progress: 'act 1', contact: 'someone' });
    const rows = await inspect.feedback(build);
    assert.equal(rows.length, 2);
    const first = rows.find((r) => r.text === 'first');
    const second = rows.find((r) => r.text === 'second');
    assert.equal(first.progress, '');
    assert.equal(first.contact, '');
    assert.equal(first.platform, 'touch');
    assert.equal(second.progress, 'act 1');
    assert.equal(second.contact, 'someone');
    assert.ok(second.createdAt);
  });

  // ---- records and boards -------------------------------------------------------------------
  // Each test uses its own crew code, so boards read back only that test's rows even when the
  // database already holds rows from earlier runs.

  const crewCode = () => 'T' + randomBytes(5).toString('hex').toUpperCase();
  const uniqueName = () => 'K' + randomBytes(6).toString('hex');
  const rec = (over = {}) => ({
    name: undefined, nameKey: undefined, crew: undefined,
    build: 'b1', play: 4000, deaths: 2, pct: 40, badges: 5, rank: 1, days: 2,
    act1: null, full: null, fullDeaths: null, splits: { ashore: 30 }, bosses: {},
    ...over,
  });
  const named = (name, over = {}) => rec({ name, nameKey: name.toLowerCase(), ...over });
  /** A new id with a save behind it (records need a save). */
  async function savedId(store) {
    const id = newId();
    await store.putSave(id, { at: 1, objective: '', body: 'x' });
    return id;
  }

  test(`${label}: putRecord needs a save for the id`, async () => {
    const store = getStore();
    const id = newId();
    assert.deepEqual(await store.putRecord(id, rec()), { status: 'no_save' });
    assert.equal(await store.getRecord(id), null);
  });

  test(`${label}: putRecord creates, getRecord reads it back, a second put updates`, async () => {
    const store = getStore();
    const id = await savedId(store);
    const name = uniqueName();
    const crew = crewCode();
    const r = await store.putRecord(id, named(name, {
      crew, act1: 900, splits: { ashore: 30, gloaming: 900 }, bosses: { stag: 40 },
    }));
    assert.deepEqual(r, { status: 'ok', name, created: true });
    const got = await store.getRecord(id);
    assert.equal(typeof got.at, 'number');
    delete got.at;
    assert.deepEqual(got, {
      name, crew, build: 'b1', play: 4000, deaths: 2, pct: 40, badges: 5, rank: 1, days: 2,
      act1: 900, full: null, fullDeaths: null, splits: { ashore: 30, gloaming: 900 }, bosses: { stag: 40 },
    });
    const again = await store.putRecord(id, rec({ build: 'b2', play: 5000, pct: 41 }));
    assert.deepEqual(again, { status: 'ok', name, created: false });
    const after = await store.getRecord(id);
    assert.equal(after.build, 'b2');
    assert.equal(after.play, 5000);
    assert.equal(after.pct, 41);
    assert.equal(after.crew, crew); // omitted crew keeps the stored one
  });

  test(`${label}: name omitted keeps it, '' clears it, a change frees the old name`, async () => {
    const store = getStore();
    const a = await savedId(store);
    const b = await savedId(store);
    const first = uniqueName();
    const second = uniqueName();
    await store.putRecord(a, named(first));
    assert.equal((await store.putRecord(a, rec())).name, first);
    assert.equal((await store.putRecord(a, named(second))).name, second);
    // first is free again
    assert.deepEqual(await store.putRecord(b, named(first)), { status: 'ok', name: first, created: true });
    assert.equal((await store.putRecord(a, rec({ name: '', nameKey: '' }))).name, '');
    assert.equal((await store.getRecord(a)).name, '');
    // Two records can both have no name.
    assert.equal((await store.putRecord(b, rec({ name: '', nameKey: '' }))).status, 'ok');
  });

  test(`${label}: names are unique case-insensitively; a 409 writes nothing`, async () => {
    const store = getStore();
    const a = await savedId(store);
    const b = await savedId(store);
    const name = uniqueName();
    await store.putRecord(a, named(name));
    const upper = name.toUpperCase();
    assert.deepEqual(await store.putRecord(b, named(upper, { play: 9999 })), { status: 'name_taken' });
    assert.equal(await store.getRecord(b), null);
    // The owner may re-send its own name, in any case.
    assert.deepEqual(await store.putRecord(a, named(upper)), { status: 'ok', name: upper, created: false });
    // A taken name on an update leaves the stored record unchanged.
    await store.putRecord(b, named(uniqueName(), { play: 100 }));
    assert.deepEqual(await store.putRecord(b, named(name, { play: 200 })), { status: 'name_taken' });
    assert.equal((await store.getRecord(b)).play, 100);
  });

  test(`${label}: concurrent claims of one name: exactly one wins`, async () => {
    const store = getStore();
    const ids = await Promise.all(Array.from({ length: 8 }, () => savedId(store)));
    const name = uniqueName();
    const results = await Promise.all(ids.map((id) => store.putRecord(id, named(name))));
    assert.equal(results.filter((r) => r.status === 'ok').length, 1);
    assert.equal(results.filter((r) => r.status === 'name_taken').length, 7);
  });

  test(`${label}: concurrent puts for one id create it once`, async () => {
    const store = getStore();
    const id = await savedId(store);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.putRecord(id, rec({ act1: 1000 - i, splits: { gloaming: 1000 - i } }))),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal((await store.getRecord(id)).act1, 991);
  });

  test(`${label}: best times only improve; latest values replace the rest`, async () => {
    const store = getStore();
    const id = await savedId(store);
    await store.putRecord(id, rec({
      act1: 900, full: 5000, fullDeaths: 4, deaths: 4, splits: { gloaming: 900, giant: 5000 },
      bosses: { stag: 50, gloaming: 80 },
    }));
    // Slower everything, and a new boss.
    await store.putRecord(id, rec({
      act1: 1000, full: 6000, fullDeaths: 9, deaths: 9, splits: { gloaming: 1000, giant: 6000 },
      bosses: { stag: 70, gloaming: 60, crane: 99 },
    }));
    let got = await store.getRecord(id);
    assert.equal(got.act1, 900);
    assert.equal(got.full, 5000);
    assert.equal(got.fullDeaths, 4);
    assert.equal(got.deaths, 9);
    assert.deepEqual(got.splits, { gloaming: 1000, giant: 6000 });
    assert.deepEqual(got.bosses, { stag: 50, gloaming: 60, crane: 99 });
    // A new run that has not finished yet keeps the bests.
    await store.putRecord(id, rec({ deaths: 0, splits: { ashore: 20 }, bosses: {} }));
    got = await store.getRecord(id);
    assert.equal(got.act1, 900);
    assert.equal(got.full, 5000);
    assert.equal(got.fullDeaths, 4);
    assert.deepEqual(got.bosses, { stag: 50, gloaming: 60, crane: 99 });
    // Faster ones replace.
    await store.putRecord(id, rec({ act1: 800, full: 4000, fullDeaths: 1, splits: { gloaming: 800, giant: 4000 }, bosses: { stag: 20 } }));
    got = await store.getRecord(id);
    assert.equal(got.act1, 800);
    assert.equal(got.full, 4000);
    assert.equal(got.fullDeaths, 1);
    assert.equal(got.bosses.stag, 20);
  });

  test(`${label}: crew '' leaves the crew`, async () => {
    const store = getStore();
    const id = await savedId(store);
    const crew = crewCode();
    await store.putRecord(id, rec({ crew }));
    assert.equal((await store.getRecord(id)).crew, crew);
    await store.putRecord(id, rec({ crew: '' }));
    assert.equal((await store.getRecord(id)).crew, '');
  });

  /** Puts named records in one crew, in order. Returns their ids. */
  async function seed(store, crew, list) {
    const ids = [];
    for (const over of list) {
      const id = await savedId(store);
      const { name = uniqueName(), ...rest } = over;
      await store.putRecord(id, name === '' ? rec({ name: '', nameKey: '', crew, ...rest }) : named(name, { crew, ...rest }));
      ids.push(id);
    }
    return ids;
  }
  const brief = (rows) => rows.map((r) => [r.pos, r.name, r.value]);

  test(`${label}: act1 and full boards: fastest first, ties go to the earlier record`, async () => {
    const store = getStore();
    const crew = crewCode();
    await seed(store, crew, [
      { name: 'Aaa1' + crew, act1: 900 },
      { name: 'Bbb2' + crew, act1: 700, full: 3000 },
      { name: 'Ccc3' + crew, act1: 900, full: 2500 },
      { name: 'Ddd4' + crew }, // no act1: not on the board
    ]);
    const act1 = await store.board({ board: 'act1', crew, limit: 25 });
    assert.deepEqual(brief(act1.rows), [[1, 'Bbb2' + crew, 700], [2, 'Aaa1' + crew, 900], [3, 'Ccc3' + crew, 900]]);
    assert.equal(act1.you, undefined);
    const row = act1.rows[0];
    assert.deepEqual(Object.keys(row).sort(), ['at', 'badges', 'name', 'pos', 'rank', 'value']);
    assert.equal(row.rank, 1);
    assert.equal(row.badges, 5);
    assert.equal(typeof row.at, 'number');
    const full = await store.board({ board: 'full', crew, limit: 25 });
    assert.deepEqual(brief(full.rows), [[1, 'Ccc3' + crew, 2500], [2, 'Bbb2' + crew, 3000]]);
  });

  test(`${label}: deaths board: finished runs only, fewest first, then fastest`, async () => {
    const store = getStore();
    const crew = crewCode();
    await seed(store, crew, [
      { name: 'Ee1' + crew, full: 4000, fullDeaths: 3 },
      { name: 'Ff2' + crew, full: 3000, fullDeaths: 3 },
      { name: 'Gg3' + crew, full: 9000, fullDeaths: 0 },
      { name: 'Hh4' + crew, deaths: 0 }, // never finished
    ]);
    const b = await store.board({ board: 'deaths', crew, limit: 25 });
    assert.deepEqual(brief(b.rows), [[1, 'Gg3' + crew, 0], [2, 'Ff2' + crew, 3], [3, 'Ee1' + crew, 3]]);
  });

  test(`${label}: pct board: highest first, then least play`, async () => {
    const store = getStore();
    const crew = crewCode();
    await seed(store, crew, [
      { name: 'Ii1' + crew, pct: 50, play: 9000 },
      { name: 'Jj2' + crew, pct: 80, play: 9000 },
      { name: 'Kk3' + crew, pct: 50, play: 7000 },
      { name: 'Ll4' + crew, pct: 0, play: 10 },
    ]);
    const b = await store.board({ board: 'pct', crew, limit: 25 });
    assert.deepEqual(brief(b.rows), [[1, 'Jj2' + crew, 80], [2, 'Kk3' + crew, 50], [3, 'Ii1' + crew, 50], [4, 'Ll4' + crew, 0]]);
  });

  test(`${label}: boss boards read each boss's best`, async () => {
    const store = getStore();
    const crew = crewCode();
    await seed(store, crew, [
      { name: 'Mm1' + crew, bosses: { stag: 60, crane: 200 } },
      { name: 'Nn2' + crew, bosses: { stag: 45 } },
      { name: 'Oo3' + crew, bosses: { crane: 150 } },
    ]);
    assert.deepEqual(brief((await store.board({ board: 'boss', boss: 'stag', crew, limit: 25 })).rows),
      [[1, 'Nn2' + crew, 45], [2, 'Mm1' + crew, 60]]);
    assert.deepEqual(brief((await store.board({ board: 'boss', boss: 'crane', crew, limit: 25 })).rows),
      [[1, 'Oo3' + crew, 150], [2, 'Mm1' + crew, 200]]);
    assert.deepEqual((await store.board({ board: 'boss', boss: 'giant', crew, limit: 25 })).rows, []);
  });

  test(`${label}: hidden and nameless rows are never listed and do not take a position`, async () => {
    const store = getStore();
    const crew = crewCode();
    const [hiddenId, , namelessId] = await seed(store, crew, [
      { name: 'Pp1' + crew, act1: 400 },
      { name: 'Qq2' + crew, act1: 600 },
      { name: '', act1: 500 },
    ]);
    await inspect.hide(hiddenId);
    const b = await store.board({ board: 'act1', crew, limit: 25, youId: namelessId });
    assert.deepEqual(brief(b.rows), [[1, 'Qq2' + crew, 600]]);
    // The nameless caller sees its own value but has no position.
    assert.deepEqual(b.you, { pos: null, value: 500 });
    const h = await store.board({ board: 'act1', crew, limit: 25, youId: hiddenId });
    assert.deepEqual(h.you, { pos: null, value: 400 });
  });

  test(`${label}: crew filter and limit; "you" is found outside the limit`, async () => {
    const store = getStore();
    const crew = crewCode();
    const other = crewCode();
    const ids = await seed(store, crew, Array.from({ length: 6 }, (_, i) => ({ act1: 1000 + i * 10 })));
    const [outsider] = await seed(store, other, [{ act1: 301 }]);
    const b = await store.board({ board: 'act1', crew, limit: 3, youId: ids[5] });
    assert.deepEqual(b.rows.map((r) => [r.pos, r.value]), [[1, 1000], [2, 1010], [3, 1020]]);
    assert.deepEqual(b.you, { pos: 6, value: 1050 });
    const inside = await store.board({ board: 'act1', crew, limit: 3, youId: ids[1] });
    assert.deepEqual(inside.you, { pos: 2, value: 1010 });
    // Someone outside the crew asking about this crew's board: value, no position.
    const out = await store.board({ board: 'act1', crew, limit: 3, youId: outsider });
    assert.deepEqual(out.you, { pos: null, value: 301 });
    assert.deepEqual((await store.board({ board: 'act1', crew: other, limit: 25 })).rows.map((r) => r.value), [301]);
    // No value on that board, or no record at all: null.
    assert.equal((await store.board({ board: 'full', crew, limit: 3, youId: ids[0] })).you, null);
    assert.equal((await store.board({ board: 'act1', crew, limit: 3, youId: newId() })).you, null);
  });

  test(`${label}: the all-players board includes every crew`, async () => {
    const store = getStore();
    const crew = crewCode();
    const [id] = await seed(store, crew, [{ pct: 100, play: 1 }]);
    const b = await store.board({ board: 'pct', crew: '', limit: 100, youId: id });
    assert.ok(b.you.pos >= 1);
    assert.ok(b.rows.length >= 1);
  });
}
