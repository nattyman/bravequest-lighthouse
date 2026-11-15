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
//   close()
//
// `id` is sha256(normalised sync key) in hex. The key itself never reaches the store.

import pg from 'pg';

export function createMemoryStore() {
  const saves = new Map();
  const events = [];
  const feedback = [];

  return {
    kind: 'memory',
    // Exposed for tests only.
    _saves: saves,
    _events: events,
    _feedback: feedback,

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
];

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

    async close() {
      await pool.end();
    },
  };
}
