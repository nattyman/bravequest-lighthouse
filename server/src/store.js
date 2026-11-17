// Storage for the Lighthouse save service.
//
// Both stores implement the same small interface:
//
//   init()                                  create tables etc. (idempotent)
//   ping()                                  throws if the store is unreachable
//   getSave(id)                             -> { at, objective, body } | null
//   putSave(id, { at, objective, body }, { allowCreate = true })
//       -> { status: 'ok', at, created }    written (created = brand-new id)
//       -> { status: 'stale', at }          stored save is as new or newer; unchanged
//       -> { status: 'create_denied' }      id does not exist and allowCreate was false
//   addEvent({ name, build, platform, sid })
//   addFeedback({ text, build, platform, progress, contact })
//   putRecord(id, record)                   record as returned by validateRecord() in records.js
//       -> { status: 'ok', name, created }  written; name is the stored display name ('' = none)
//       -> { status: 'name_taken' }         another record holds that name (case-insensitive); unchanged
//       -> { status: 'no_save' }            there is no save for this id; nothing written
//   getRecord(id)                           -> { name, crew, build, play, deaths, pct, badges, rank, days,
//                                                act1, full, fullDeaths, splits, bosses, at } | null
//   board({ board, boss, crew, limit, youId })
//       -> { rows: [{ pos, name, value, rank, badges, at }], you }   you only when youId is given:
//          null (no record, or no value on this board) or { pos (null if not listed), value }
//   close()
//
// `id` is sha256(normalised sync key) in hex. The key itself never reaches the store.

import pg from 'pg';

// Board definitions shared by both stores. value(row) reads the board's number from a memory row;
// order is the tie-break chain after the value (asc unless noted); every board ends with
// "earliest record first", then id, so positions are stable and unique.
const BOARD_DEFS = {
  act1: { value: (r) => r.act1, desc: false, then: [] },
  full: { value: (r) => r.full, desc: false, then: [] },
  deaths: { value: (r) => (r.full === null ? null : r.fullDeaths), desc: false, then: [(r) => r.full] },
  pct: { value: (r) => r.pct, desc: true, then: [(r) => r.play] },
  boss: { value: (r, boss) => r.bosses[boss] ?? null, desc: false, then: [] },
};

function compareBy(def, boss) {
  return (a, b) => {
    const va = def.value(a, boss);
    const vb = def.value(b, boss);
    if (va !== vb) return def.desc ? vb - va : va - vb;
    for (const f of def.then) if (f(a) !== f(b)) return f(a) - f(b);
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

const minOf = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

function mergeBosses(stored, sent) {
  const out = { ...stored };
  for (const [id, t] of Object.entries(sent)) out[id] = out[id] === undefined ? t : Math.min(out[id], t);
  return out;
}

export function createMemoryStore() {
  const saves = new Map();
  const events = [];
  const feedback = [];
  const records = new Map();
  let seq = 0;

  return {
    kind: 'memory',
    // Exposed for tests only.
    _saves: saves,
    _events: events,
    _feedback: feedback,
    _records: records,

    async init() {},
    async ping() {},

    async getSave(id) {
      const row = saves.get(id);
      return row ? { at: row.at, objective: row.objective, body: row.body } : null;
    },

    async putSave(id, { at, objective, body }, { allowCreate = true } = {}) {
      const existing = saves.get(id);
      if (existing) {
        if (existing.at >= at) return { status: 'stale', at: existing.at };
        saves.set(id, { at, objective, body, updatedAt: Date.now() });
        return { status: 'ok', at, created: false };
      }
      if (!allowCreate) return { status: 'create_denied' };
      saves.set(id, { at, objective, body, updatedAt: Date.now() });
      return { status: 'ok', at, created: true };
    },

    async addEvent({ name, build, platform, sid }) {
      events.push({ createdAt: Date.now(), name, build, platform, sid });
    },

    async addFeedback({ text, build, platform, progress = '', contact = '' }) {
      feedback.push({ createdAt: Date.now(), text, build, platform, progress, contact });
    },

    async putRecord(id, rec) {
      if (!saves.has(id)) return { status: 'no_save' };
      const existing = records.get(id);
      if (rec.name !== undefined && rec.nameKey !== '') {
        for (const [otherId, other] of records) {
          if (otherId !== id && other.nameKey === rec.nameKey) return { status: 'name_taken' };
        }
      }
      const t = Date.now();
      const row = {
        id,
        seq: existing ? existing.seq : ++seq,
        createdAt: existing ? existing.createdAt : t,
        updatedAt: t,
        hidden: existing ? existing.hidden : false,
        name: rec.name !== undefined ? rec.name : existing ? existing.name : '',
        nameKey: rec.name !== undefined ? rec.nameKey : existing ? existing.nameKey : '',
        crew: rec.crew !== undefined ? rec.crew : existing ? existing.crew : '',
        build: rec.build,
        play: rec.play,
        deaths: rec.deaths,
        pct: rec.pct,
        badges: rec.badges,
        rank: rec.rank,
        days: rec.days,
        act1: minOf(existing ? existing.act1 : null, rec.act1),
        full: minOf(existing ? existing.full : null, rec.full),
        fullDeaths: minOf(existing ? existing.fullDeaths : null, rec.fullDeaths),
        splits: { ...rec.splits },
        bosses: mergeBosses(existing ? existing.bosses : {}, rec.bosses),
      };
      records.set(id, row);
      return { status: 'ok', name: row.name, created: !existing };
    },

    async getRecord(id) {
      const r = records.get(id);
      if (!r) return null;
      return {
        name: r.name, crew: r.crew, build: r.build, play: r.play, deaths: r.deaths, pct: r.pct,
        badges: r.badges, rank: r.rank, days: r.days, act1: r.act1, full: r.full, fullDeaths: r.fullDeaths,
        splits: { ...r.splits }, bosses: { ...r.bosses }, at: r.updatedAt,
      };
    },

    async board({ board, boss = null, crew = '', limit = 25, youId } = {}) {
      const def = BOARD_DEFS[board];
      const listed = [...records.values()]
        .filter((r) => r.nameKey !== '' && !r.hidden && (crew === '' || r.crew === crew))
        .filter((r) => def.value(r, boss) !== null && def.value(r, boss) !== undefined)
        .sort(compareBy(def, boss));
      const rows = listed.slice(0, limit).map((r, i) => ({
        pos: i + 1, name: r.name, value: def.value(r, boss), rank: r.rank, badges: r.badges, at: r.updatedAt,
      }));
      if (youId === undefined || youId === null) return { rows };
      const mine = records.get(youId);
      const value = mine ? def.value(mine, boss) : null;
      if (value === null || value === undefined) return { rows, you: null };
      const i = listed.indexOf(mine);
      return { rows, you: { pos: i < 0 ? null : i + 1, value } };
    },

    async close() {},
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS saves (
     id text PRIMARY KEY,
     at bigint NOT NULL,
     objective text NOT NULL DEFAULT '',
     body text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id bigserial PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT now(),
     name text NOT NULL,
     build text NOT NULL,
     platform text NOT NULL,
     sid text NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS events_name_created_at_idx ON events (name, created_at)`,
  `CREATE TABLE IF NOT EXISTS feedback (
     id bigserial PRIMARY KEY,
     created_at timestamptz NOT NULL DEFAULT now(),
     text text NOT NULL,
     build text NOT NULL,
     platform text NOT NULL,
     progress text NOT NULL DEFAULT '',
     contact text NOT NULL DEFAULT ''
   )`,
  // Player records for the boards. id is sha256 of the sync code, as for saves.
  // full_deaths: fewest deaths on a finished full run (null until one is finished).
  `CREATE TABLE IF NOT EXISTS records (
     id text PRIMARY KEY,
     name text NOT NULL DEFAULT '',
     name_key text NOT NULL DEFAULT '',
     crew text NOT NULL DEFAULT '',
     build text NOT NULL,
     play integer NOT NULL,
     deaths integer NOT NULL,
     pct smallint NOT NULL,
     badges smallint NOT NULL,
     rank smallint NOT NULL,
     days smallint NOT NULL,
     act1 integer,
     full_run integer,
     full_deaths integer,
     splits jsonb NOT NULL,
     bosses jsonb NOT NULL,
     hidden boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS records_name_key_idx ON records (name_key) WHERE name_key <> ''`,
  `CREATE INDEX IF NOT EXISTS records_crew_idx ON records (crew) WHERE crew <> ''`,
];

// SQL for each board: the value column, extra filter, and ordering (before the shared
// "created_at, id" tie-break). $B is replaced with the boss id parameter.
const PG_BOARDS = {
  act1: { value: 'act1', where: '', order: 'act1 ASC' },
  full: { value: 'full_run', where: '', order: 'full_run ASC' },
  deaths: { value: 'full_deaths', where: 'AND full_run IS NOT NULL', order: 'full_deaths ASC, full_run ASC' },
  pct: { value: 'pct::int', where: '', order: 'pct DESC, play ASC' },
  boss: { value: '(bosses ->> $B)::int', where: '', order: '(bosses ->> $B)::int ASC' },
};

const PUT_RECORD_SQL = `
  INSERT INTO records AS r
    (id, name, name_key, crew, build, play, deaths, pct, badges, rank, days,
     act1, full_run, full_deaths, splits, bosses)
  SELECT $1::text, COALESCE($2::text, ''), COALESCE($3::text, ''), COALESCE($4::text, ''), $5::text,
         $6::int, $7::int, $8::smallint, $9::smallint, $10::smallint, $11::smallint,
         $12::int, $13::int, $14::int, $15::jsonb, $16::jsonb
   WHERE EXISTS (SELECT 1 FROM saves WHERE id = $1::text)
  ON CONFLICT (id) DO UPDATE SET
    name = COALESCE($2::text, r.name),
    name_key = COALESCE($3::text, r.name_key),
    crew = COALESCE($4::text, r.crew),
    build = EXCLUDED.build,
    play = EXCLUDED.play,
    deaths = EXCLUDED.deaths,
    pct = EXCLUDED.pct,
    badges = EXCLUDED.badges,
    rank = EXCLUDED.rank,
    days = EXCLUDED.days,
    act1 = LEAST(r.act1, EXCLUDED.act1),
    full_run = LEAST(r.full_run, EXCLUDED.full_run),
    full_deaths = LEAST(r.full_deaths, EXCLUDED.full_deaths),
    splits = EXCLUDED.splits,
    bosses = COALESCE((
      SELECT jsonb_object_agg(k, m) FROM (
        SELECT k, MIN(v) AS m FROM (
          SELECT key AS k, value::int AS v FROM jsonb_each_text(r.bosses)
          UNION ALL
          SELECT key, value::int FROM jsonb_each_text(EXCLUDED.bosses)
        ) u GROUP BY k
      ) g), '{}'::jsonb),
    updated_at = now()
  RETURNING name, (xmax = 0) AS created`;

// Arbitrary constant: serialises schema creation if two instances start together
// (concurrent CREATE TABLE IF NOT EXISTS can otherwise fail with a duplicate-type error).
const SCHEMA_LOCK_KEY = 4127001;

export function createPgStore(databaseUrl) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  // An idle client dropping (database restart) must not crash the process.
  pool.on('error', (err) => {
    console.error(`pg pool error: ${err.code || ''} ${err.message}`);
  });

  return {
    kind: 'postgres',
    _pool: pool,

    async init() {
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
        try {
          for (const sql of SCHEMA) await client.query(sql);
        } finally {
          await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
        }
      } finally {
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async getSave(id) {
      const { rows } = await pool.query(
        'SELECT at, objective, body FROM saves WHERE id = $1',
        [id],
      );
      if (rows.length === 0) return null;
      // bigint comes back as a string; ms timestamps fit comfortably in a double.
      return { at: Number(rows[0].at), objective: rows[0].objective, body: rows[0].body };
    },

    async putSave(id, { at, objective, body }, { allowCreate = true } = {}) {
      let rows;
      if (allowCreate) {
        // Atomic compare-and-write. (xmax = 0) is true only for a freshly inserted row.
        ({ rows } = await pool.query(
          `INSERT INTO saves (id, at, objective, body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET at = EXCLUDED.at,
                 objective = EXCLUDED.objective,
                 body = EXCLUDED.body,
                 updated_at = now()
             WHERE saves.at < EXCLUDED.at
           RETURNING at, (xmax = 0) AS created`,
          [id, at, objective, body],
        ));
      } else {
        ({ rows } = await pool.query(
          `UPDATE saves
              SET at = $2, objective = $3, body = $4, updated_at = now()
            WHERE id = $1 AND at < $2
           RETURNING at, false AS created`,
          [id, at, objective, body],
        ));
      }
      if (rows.length > 0) {
        return { status: 'ok', at: Number(rows[0].at), created: rows[0].created === true };
      }
      const current = await pool.query('SELECT at FROM saves WHERE id = $1', [id]);
      if (current.rows.length === 0) {
        // Only reachable with allowCreate (row deleted in between) if someone removes rows
        // by hand; treat it the same way so the caller can retry.
        return { status: 'create_denied' };
      }
      return { status: 'stale', at: Number(current.rows[0].at) };
    },

    async addEvent({ name, build, platform, sid }) {
      await pool.query(
        'INSERT INTO events (name, build, platform, sid) VALUES ($1, $2, $3, $4)',
        [name, build, platform, sid],
      );
    },

    async addFeedback({ text, build, platform, progress = '', contact = '' }) {
      await pool.query(
        'INSERT INTO feedback (text, build, platform, progress, contact) VALUES ($1, $2, $3, $4, $5)',
        [text, build, platform, progress, contact],
      );
    },

    async putRecord(id, rec) {
      const keepName = rec.name === undefined;
      try {
        const { rows } = await pool.query(PUT_RECORD_SQL, [
          id,
          keepName ? null : rec.name,
          keepName ? null : rec.nameKey,
          rec.crew === undefined ? null : rec.crew,
          rec.build, rec.play, rec.deaths, rec.pct, rec.badges, rec.rank, rec.days,
          rec.act1, rec.full, rec.fullDeaths,
          JSON.stringify(rec.splits), JSON.stringify(rec.bosses),
        ]);
        if (rows.length === 0) return { status: 'no_save' };
        return { status: 'ok', name: rows[0].name, created: rows[0].created === true };
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'records_name_key_idx') return { status: 'name_taken' };
        throw err;
      }
    },

    async getRecord(id) {
      const { rows } = await pool.query(
        `SELECT name, crew, build, play, deaths, pct, badges, rank, days, act1, full_run, full_deaths,
                splits, bosses, (extract(epoch FROM updated_at) * 1000)::bigint AS at
           FROM records WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        name: r.name, crew: r.crew, build: r.build, play: r.play, deaths: r.deaths, pct: r.pct,
        badges: r.badges, rank: r.rank, days: r.days, act1: r.act1, full: r.full_run, fullDeaths: r.full_deaths,
        splits: r.splits, bosses: r.bosses, at: Number(r.at),
      };
    },

    async board({ board, boss = null, crew = '', limit = 25, youId } = {}) {
      const def = PG_BOARDS[board];
      if (!def) throw new Error('unknown board');
      const params = [crew, limit, youId ?? null];
      let value = def.value;
      let order = def.order;
      if (board === 'boss') {
        params.push(boss);
        value = value.replaceAll('$B', '$4::text');
        order = order.replaceAll('$B', '$4::text');
      }
      const { rows } = await pool.query(
        `WITH ranked AS (
           SELECT id, name, rank, badges, updated_at, ${value} AS value,
                  ROW_NUMBER() OVER (ORDER BY ${order}, created_at ASC, id ASC) AS pos
             FROM records
            WHERE name_key <> '' AND NOT hidden AND ($1::text = '' OR crew = $1::text)
              AND ${value} IS NOT NULL ${def.where}
         )
         SELECT id, name, value, rank, badges, pos, (extract(epoch FROM updated_at) * 1000)::bigint AS at
           FROM ranked WHERE pos <= $2::int OR id = $3::text ORDER BY pos`,
        params,
      );
      const toRow = (r) => ({
        pos: Number(r.pos), name: r.name, value: r.value, rank: r.rank, badges: r.badges, at: Number(r.at),
      });
      const out = { rows: rows.filter((r) => Number(r.pos) <= limit).map(toRow) };
      if (youId === undefined || youId === null) return out;
      const listedMine = rows.find((r) => r.id === youId);
      if (listedMine) {
        out.you = { pos: Number(listedMine.pos), value: listedMine.value };
        return out;
      }
      const mineParams = [youId];
      let mineValue = def.value;
      if (board === 'boss') {
        mineParams.push(boss);
        mineValue = mineValue.replaceAll('$B', '$2::text');
      }
      const mine = await pool.query(
        `SELECT ${mineValue} AS value FROM records WHERE id = $1::text ${def.where}`,
        mineParams,
      );
      const v = mine.rows[0]?.value;
      out.you = v === null || v === undefined ? null : { pos: null, value: v };
      return out;
    },

    async close() {
      await pool.end();
    },
  };
}
