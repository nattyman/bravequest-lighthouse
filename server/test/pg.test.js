// Runs the store contract, and a short HTTP round trip, against a real Postgres.
// Only runs when TEST_DATABASE_URL is set; skipped otherwise.
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/lighthouse_test npm test
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createPgStore } from '../src/store.js';
import { runStoreContract } from './_store_contract.js';
import { startServer, freshKey, getSave, putSave, post, validSave, validEvent, validFeedback } from './_helpers.js';

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  test('postgres store (skipped: TEST_DATABASE_URL is not set)', { skip: true }, () => {});
} else {
  let store;
  before(async () => {
    store = createPgStore(url);
    await store.init();
  });
  after(async () => {
    await store.close();
  });

  test('postgres store: init is idempotent and safe to run concurrently', async () => {
    await Promise.all([store.init(), store.init(), store.init()]);
  });

  test('postgres store: schema matches the spec', async () => {
    const { rows } = await store._pool.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('saves', 'events', 'feedback')
        ORDER BY table_name, ordinal_position`,
    );
    const cols = (t) => rows.filter((r) => r.table_name === t).map((r) => `${r.column_name}:${r.data_type}`);
    assert.deepEqual(cols('saves'), [
      'id:text', 'at:bigint', 'objective:text', 'body:text', 'updated_at:timestamp with time zone',
    ]);
    assert.deepEqual(cols('events'), [
      'id:bigint', 'created_at:timestamp with time zone', 'name:text', 'build:text', 'platform:text', 'sid:text',
    ]);
    assert.deepEqual(cols('feedback'), [
      'id:bigint', 'created_at:timestamp with time zone', 'text:text', 'build:text', 'platform:text',
      'progress:text', 'contact:text',
    ]);
    assert.ok(rows.every((r) => r.is_nullable === 'NO'));
    const idx = await store._pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'events'`,
    );
    assert.ok(idx.rows.some((r) => /\(name, created_at\)/.test(r.indexdef)));
  });

  test('postgres store: records schema matches the spec', async () => {
    const { rows } = await store._pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'records' ORDER BY ordinal_position`,
    );
    assert.deepEqual(rows.map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`), [
      'id:text:NO', 'name:text:NO', 'name_key:text:NO', 'crew:text:NO', 'build:text:NO',
      'play:integer:NO', 'deaths:integer:NO', 'pct:smallint:NO', 'badges:smallint:NO', 'rank:smallint:NO',
      'days:smallint:NO', 'act1:integer:YES', 'full_run:integer:YES', 'full_deaths:integer:YES',
      'splits:jsonb:NO', 'bosses:jsonb:NO', 'hidden:boolean:NO',
      'created_at:timestamp with time zone:NO', 'updated_at:timestamp with time zone:NO',
    ]);
    const idx = await store._pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'records'`,
    );
    const nameIdx = idx.rows.find((r) => r.indexname === 'records_name_key_idx');
    assert.ok(nameIdx && /UNIQUE/.test(nameIdx.indexdef) && /WHERE/.test(nameIdx.indexdef));
  });

  runStoreContract('postgres store', () => store, {
    events: async (sid) =>
      (await store._pool.query('SELECT name, build, platform, sid, created_at AS "createdAt" FROM events WHERE sid = $1', [sid])).rows,
    feedback: async (build) =>
      (await store._pool.query('SELECT text, build, platform, progress, contact, created_at AS "createdAt" FROM feedback WHERE build = $1', [build])).rows,
    hide: async (id) => { await store._pool.query('UPDATE records SET hidden = true WHERE id = $1', [id]); },
  });

  test('postgres store: updated_at moves on update', async () => {
    const id = 'updated-at-' + Date.now() + Math.random();
    await store.putSave(id, { at: 1, objective: '', body: 'a' });
    const first = (await store._pool.query('SELECT updated_at FROM saves WHERE id = $1', [id])).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 20));
    await store.putSave(id, { at: 2, objective: '', body: 'b' });
    const second = (await store._pool.query('SELECT updated_at FROM saves WHERE id = $1', [id])).rows[0].updated_at;
    assert.ok(second > first);
  });

  test('postgres over HTTP: health, 404, put, get, stale, event, feedback', async () => {
    const s = await startServer({ store });
    try {
      assert.equal((await fetch(`${s.url}/health`)).status, 200);
      const key = freshKey();
      assert.equal((await getSave(s.url, key)).status, 404);
      const put = await putSave(s.url, key, validSave({ at: 1700000000123 }));
      assert.equal(put.status, 200);
      assert.deepEqual(await put.json(), { ok: true, at: 1700000000123 });
      const got = await getSave(s.url, key.toLowerCase());
      assert.deepEqual(await got.json(), { v: 1, at: 1700000000123, objective: 'Light the lamp', save: '{"hp":3}' });
      const stale = await putSave(s.url, key, validSave({ at: 1700000000123, save: 'other' }));
      assert.equal(stale.status, 409);
      assert.deepEqual(await stale.json(), { error: 'stale', at: 1700000000123 });
      assert.equal((await post(s.url, '/v1/event', validEvent())).status, 204);
      assert.equal((await post(s.url, '/v1/feedback', validFeedback())).status, 204);
      // The raw key is never stored: the row id is its sha256.
      const ids = await store._pool.query('SELECT 1 FROM saves WHERE id = $1 OR body LIKE $2', [key, `%${key}%`]);
      assert.equal(ids.rows.length, 0);
      // Records and boards over HTTP.
      const name = 'Pg ' + Math.random().toString(36).slice(2, 10);
      const crew = 'PG' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const rec = { name, crew, build: 'b', play: 2000, deaths: 1, pct: 30, badges: 2, rank: 1, days: 1,
        splits: { ashore: 10, gloaming: 1500 }, bosses: { stag: 30 } };
      const put2 = await fetch(`${s.url}/v1/record`, { method: 'PUT', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(rec) });
      assert.equal(put2.status, 200);
      assert.deepEqual(await put2.json(), { ok: true, name });
      const mine = await (await fetch(`${s.url}/v1/record`, { headers: { Authorization: `Bearer ${key}` } })).json();
      assert.equal(mine.name, name);
      assert.equal(mine.act1, 1500);
      const board = await (await fetch(`${s.url}/v1/board?b=act1&crew=${crew}`, { headers: { Authorization: `Bearer ${key}` } })).json();
      assert.deepEqual(board.rows.map((r) => [r.pos, r.name, r.value]), [[1, name, 1500]]);
      assert.deepEqual(board.you, { pos: 1, value: 1500 });
      const ids2 = await store._pool.query('SELECT 1 FROM records WHERE id = $1', [key]);
      assert.equal(ids2.rows.length, 0);
    } finally {
      await s.close();
    }
  });

  test('health answers 503 when the database is unreachable', async () => {
    const dead = createPgStore('postgres://nobody:nothing@127.0.0.1:1/none');
    const s = await startServer({ store: dead });
    try {
      const res = await fetch(`${s.url}/health`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false });
    } finally {
      await s.close();
      await dead.close();
    }
  });
}
