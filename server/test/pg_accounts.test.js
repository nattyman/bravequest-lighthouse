// The account tables against a real Postgres: the store contract, the schema, and the upgrade of a database
// created by the service before accounts. Only runs when TEST_DATABASE_URL is set; skipped otherwise.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPgStore } from '../src/store.js';
import { runAccountStoreContract } from './_accounts_store_contract.js';
import { SCHEMA_BEFORE_ACCOUNTS } from './fixtures/schema-before-accounts.js';

const url = process.env.TEST_DATABASE_URL;

/** The same database with a different search_path, so a test can have a schema of its own. */
function withSearchPath(base, schema) {
  const u = new URL(base);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return u.toString();
}

if (!url) {
  test('postgres account tables (skipped: TEST_DATABASE_URL is not set)', { skip: true }, () => {});
} else {
  let store;
  before(async () => {
    store = createPgStore(url);
    await store.init();
  });
  after(async () => {
    await store.close();
  });

  runAccountStoreContract('postgres store (accounts)', () => store);

  test('postgres store: account tables match the spec', async () => {
    const { rows } = await store._pool.query(
      `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('accounts', 'sessions', 'sign_ins', 'account_saves', 'audit', 'settings')
        ORDER BY table_name, ordinal_position`,
    );
    const cols = (t) => rows.filter((r) => r.table_name === t).map((r) => `${r.column_name}:${r.data_type}:${r.is_nullable}`);
    assert.deepEqual(cols('accounts'), [
      'id:uuid:NO', 'email:text:NO', 'password_hash:text:YES', 'role:text:NO', 'tools:ARRAY:NO', 'display_name:text:NO',
      'name_key:text:NO', 'status:text:NO', 'created_at:timestamp with time zone:NO', 'last_seen_at:timestamp with time zone:NO',
    ]);
    assert.deepEqual(cols('sessions'), [
      'token_hash:text:NO', 'account_id:uuid:NO', 'created_at:timestamp with time zone:NO', 'renewed_at:timestamp with time zone:NO',
      'expires_at:timestamp with time zone:NO', 'last_used_at:timestamp with time zone:NO', 'note:text:NO',
    ]);
    assert.deepEqual(cols('sign_ins'), [
      'id:text:NO', 'email:text:NO', 'link_hash:text:NO', 'code_hash:text:NO', 'tries:integer:NO',
      'created_at:timestamp with time zone:NO', 'expires_at:timestamp with time zone:NO', 'used_at:timestamp with time zone:YES',
    ]);
    assert.deepEqual(cols('account_saves'), [
      'account_id:uuid:NO', 'slot:smallint:NO', 'name:text:NO', 'test:boolean:NO', 'at:bigint:NO', 'objective:text:NO',
      'rec:jsonb:YES', 'body:text:NO', 'updated_at:timestamp with time zone:NO',
    ]);
    assert.deepEqual(cols('audit'), [
      'id:bigint:NO', 'at:timestamp with time zone:NO', 'admin_email:text:NO', 'action:text:NO', 'account_id:uuid:YES', 'detail:jsonb:NO',
    ]);
    assert.deepEqual(cols('settings'), ['key:text:NO', 'value:jsonb:NO']);
    const idx = await store._pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'accounts'`,
    );
    const nameIdx = idx.rows.find((r) => r.indexname === 'accounts_name_key_idx');
    assert.ok(nameIdx && /UNIQUE/.test(nameIdx.indexdef) && /WHERE/.test(nameIdx.indexdef));
    // Slots outside 1..10 are refused by the table itself.
    const a = await store.accounts.signIn(`chk${randomBytes(4).toString('hex')}@example.test`, { at: Date.now() });
    await assert.rejects(store.slots.put(a.id, 11, { at: 1, objective: '', body: 'x' }, {}));
  });

  test('postgres: a database made by the service before accounts starts up with every row intact', async () => {
    const schema = `upgrade_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = withSearchPath(url, schema);
    const old = new pg.Pool({ connectionString: scopedUrl, max: 1 });
    let fresh;
    try {
      // 1. The old version's schema and some of its rows: a save, a named record, an event and a feedback.
      for (const sql of SCHEMA_BEFORE_ACCOUNTS) await old.query(sql);
      await old.query(`INSERT INTO saves (id, at, objective, body) VALUES ('s1', 1700000000000, 'Find Hesper', '{"hp":3}')`);
      await old.query(
        `INSERT INTO records (id, name, name_key, crew, build, play, deaths, pct, badges, rank, days, act1, full_run, full_deaths, splits, bosses)
         VALUES ('s1', 'Old Keeper', 'old keeper', 'CREW1', 'b41', 4000, 3, 55, 4, 2, 9, 1500, NULL, NULL, '{"ashore":10,"gloaming":1500}', '{"stag":40}')`,
      );
      await old.query(`INSERT INTO events (name, build, platform, sid) VALUES ('act1.start', 'b41', 'touch', 'abc12345')`);
      await old.query(`INSERT INTO feedback (text, build, platform) VALUES ('Lovely', 'b41', 'pad')`);
      const snapshot = async (pool) => {
        const out = {};
        for (const t of ['saves', 'records', 'events', 'feedback']) {
          out[t] = (await pool.query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
        }
        out.columns = (await pool.query(
          `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
            WHERE table_schema = $1 AND table_name IN ('saves', 'records', 'events', 'feedback')
            ORDER BY table_name, ordinal_position`, [schema],
        )).rows;
        out.indexes = (await pool.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1
             AND tablename IN ('saves', 'records', 'events', 'feedback') ORDER BY indexname`, [schema],
        )).rows;
        return out;
      };
      const before = await snapshot(old);
      assert.equal(before.saves.length, 1);

      // 2. The new code starts on it (twice, as a restart would).
      fresh = createPgStore(scopedUrl);
      await fresh.init();
      await fresh.init();
      const afterInit = await snapshot(old);
      assert.deepEqual(afterInit, before);

      // 3. The new tables are there, and the old rows still read through the store.
      const tables = (await old.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schema],
      )).rows.map((r) => r.table_name);
      assert.deepEqual(tables, ['account_saves', 'accounts', 'audit', 'events', 'feedback', 'records', 'saves', 'sessions', 'settings', 'sign_ins']);
      assert.deepEqual(await fresh.getSave('s1'), { at: 1700000000000, objective: 'Find Hesper', body: '{"hp":3}' });
      const r = await fresh.getRecord('s1');
      assert.deepEqual([r.name, r.crew, r.act1, r.bosses], ['Old Keeper', 'CREW1', 1500, { stag: 40 }]);
      // The old record's name still blocks an account from taking it.
      const a = await fresh.accounts.signIn('upgrade@example.test', { at: Date.now() });
      assert.deepEqual(await fresh.accounts.setName(a.id, { name: 'OLD KEEPER', key: 'old keeper' }), { status: 'name_taken' });
      await fresh.accounts.delete(a.id);
      assert.deepEqual(await snapshot(old), before);
    } finally {
      if (fresh) await fresh.close();
      await old.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
}
