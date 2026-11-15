// The behaviour every store must have. Used by store.test.js (memory) and pg.test.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

const newId = () => randomBytes(32).toString('hex');

/**
 * @param label   name shown in test output
 * @param getStore   () => store (already initialised)
 * @param inspect   { events(sid) -> rows, feedback(build) -> rows } for reading back what was written
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
}
