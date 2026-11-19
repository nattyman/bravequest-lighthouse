// The Postgres schema exactly as the service created it before accounts (commit 87211e9, src/store.js),
// used to prove a live database from that version starts under the new code with every row intact.

export const SCHEMA_BEFORE_ACCOUNTS = [
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
