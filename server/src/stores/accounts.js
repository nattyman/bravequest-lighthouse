// Storage for accounts, sessions and sign-ins (the `accounts`, `sessions` and `sign_ins` tables).
// Spec: ACCOUNTS.md (section 2).
//
// Mounted on the main store as store.accounts, store.sessions and store.signIns (see store.js).
// Times are passed in by the caller as ms timestamps (the app's clock), so expiry rules can be tested
// with a fake clock on either store. Every method returns plain objects with camelCase fields:
//
//   account = { id, email, passwordHash (string|null), role, tools: [groups], displayName, nameKey,
//               status, createdAt, lastSeenAt }
//   session = { tokenHash, accountId, createdAt, renewedAt, expiresAt, lastUsedAt, note }
//   signIn  = { id, email, codeHash, tries, createdAt, expiresAt, usedAt }
//
// store.accounts
//   byId(id) -> account | null                 (a malformed id is null, not an error)
//   byEmail(email) -> account | null           (email already lower-cased and trimmed)
//   signIn(email, { at, role? }) -> account    find or create; role (e.g. 'admin' for a super admin) is set
//                                              when given; last_seen_at = at
//   setPassword(id, hash|null) -> boolean
//   setName(id, { name, key }) -> { status: 'ok' } | { status: 'name_taken' } | { status: 'no_account' }
//       name/key from cleanName() ('' clears). Unique across accounts AND records (guests' board names).
//       Also writes records.name/name_key of the account's record row ('a:' + id) when it exists.
//   update(id, { role?, tools?, status? }) -> account | null   (no checks: callers validate)
//   touch(id, at)                              last_seen_at = at
//   delete(id) -> boolean                      the account, its sessions, its account_saves rows and its
//                                              record row ('a:' + id), in one transaction
//   recordId(id) -> 'a:' + id                  the account's id in the records table
//
// store.sessions
//   create({ tokenHash, accountId, at, expiresAt, note })
//   get(tokenHash) -> session | null           expired sessions are returned too: the caller checks expiresAt
//   renew(tokenHash, { at, expiresAt })        renewed_at = last_used_at = at
//   touch(tokenHash, at)                       last_used_at = at
//   delete(tokenHash) -> boolean
//   deleteForAccount(accountId, { except? }) -> number   ends every session of the account (but `except`)
//   listForAccount(accountId) -> [session]     newest first
//   prune(at) -> number                        deletes sessions that expired before `at`
//
// store.signIns
//   create({ id, email, linkHash, codeHash, at, expiresAt })
//   takeTry(id, { at, maxTries }) -> signIn | null
//       Atomically counts one code try and returns the row (tries after counting), or null when the id is
//       unknown, used, expired or already out of tries. Count first, compare after: parallel guesses cannot
//       get more than maxTries comparisons.
//   use(id, at) -> email | null                marks it used unless it was already used or has expired
//   useLink(linkHash, at) -> email | null      the same, found by the link's hash
//   prune(at) -> number                        deletes rows that expired more than SIGN_IN.keepUsedMs ago
//   deleteForEmail(email) -> number

import { randomUUID } from 'node:crypto';
import { SIGN_IN } from '../accounts/limits.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isAccountId = (id) => typeof id === 'string' && UUID_RE.test(id);
export const recordIdForAccount = (id) => `a:${id}`;

export const ACCOUNT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email text NOT NULL UNIQUE,
     password_hash text,
     role text NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'tester', 'admin')),
     tools text[] NOT NULL DEFAULT '{}',
     display_name text NOT NULL DEFAULT '',
     name_key text NOT NULL DEFAULT '',
     status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
     created_at timestamptz NOT NULL DEFAULT now(),
     last_seen_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS accounts_name_key_idx ON accounts (name_key) WHERE name_key <> ''`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash text PRIMARY KEY,
     account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL,
     renewed_at timestamptz NOT NULL,
     expires_at timestamptz NOT NULL,
     last_used_at timestamptz NOT NULL,
     note text NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_account_id_idx ON sessions (account_id)`,
  `CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)`,
  `CREATE TABLE IF NOT EXISTS sign_ins (
     id text PRIMARY KEY,
     email text NOT NULL,
     link_hash text NOT NULL UNIQUE,
     code_hash text NOT NULL,
     tries integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL,
     expires_at timestamptz NOT NULL,
     used_at timestamptz
   )`,
  `CREATE INDEX IF NOT EXISTS sign_ins_expires_at_idx ON sign_ins (expires_at)`,
  `CREATE INDEX IF NOT EXISTS sign_ins_email_idx ON sign_ins (email)`,
];

const copyAccount = (a) => (a ? { ...a, tools: [...a.tools] } : null);

// ---------------------------------------------------------------------------
// Memory

/** `mem` is the memory store's shared state (see store.js): { records, accounts, sessions, signIns, accountSaves }. */
export function memoryAccountStores(mem) {
  const accounts = {
    recordId: recordIdForAccount,

    async byId(id) {
      return copyAccount(mem.accounts.get(id));
    },

    async byEmail(email) {
      for (const a of mem.accounts.values()) if (a.email === email) return copyAccount(a);
      return null;
    },

    async signIn(email, { at, role } = {}) {
      let a = null;
      for (const x of mem.accounts.values()) if (x.email === email) a = x;
      if (!a) {
        a = {
          id: randomUUID(), email, passwordHash: null, role: 'player', tools: [], displayName: '', nameKey: '',
          status: 'active', createdAt: at, lastSeenAt: at,
        };
        mem.accounts.set(a.id, a);
      }
      if (role) a.role = role;
      a.lastSeenAt = at;
      return copyAccount(a);
    },

    async setPassword(id, hash) {
      const a = mem.accounts.get(id);
      if (!a) return false;
      a.passwordHash = hash;
      return true;
    },

    async setName(id, { name, key }) {
      const a = mem.accounts.get(id);
      if (!a) return { status: 'no_account' };
      const rid = recordIdForAccount(id);
      if (key !== '') {
        for (const other of mem.accounts.values()) if (other.id !== id && other.nameKey === key) return { status: 'name_taken' };
        for (const [otherId, r] of mem.records) if (otherId !== rid && r.nameKey === key) return { status: 'name_taken' };
      }
      a.displayName = name;
      a.nameKey = key;
      const rec = mem.records.get(rid);
      if (rec) {
        rec.name = name;
        rec.nameKey = key;
      }
      return { status: 'ok' };
    },

    async update(id, { role, tools, status } = {}) {
      const a = mem.accounts.get(id);
      if (!a) return null;
      if (role !== undefined) a.role = role;
      if (tools !== undefined) a.tools = [...tools];
      if (status !== undefined) a.status = status;
      return copyAccount(a);
    },

    async touch(id, at) {
      const a = mem.accounts.get(id);
      if (a) a.lastSeenAt = at;
    },

    async delete(id) {
      if (!mem.accounts.has(id)) return false;
      mem.accounts.delete(id);
      for (const [h, s] of mem.sessions) if (s.accountId === id) mem.sessions.delete(h);
      mem.accountSaves.delete(id);
      mem.records.delete(recordIdForAccount(id));
      return true;
    },
  };

  const sessions = {
    async create({ tokenHash, accountId, at, expiresAt, note = '' }) {
      mem.sessions.set(tokenHash, {
        tokenHash, accountId, createdAt: at, renewedAt: at, expiresAt, lastUsedAt: at, note,
      });
    },
    async get(tokenHash) {
      const s = mem.sessions.get(tokenHash);
      return s ? { ...s } : null;
    },
    async renew(tokenHash, { at, expiresAt }) {
      const s = mem.sessions.get(tokenHash);
      if (s) Object.assign(s, { renewedAt: at, lastUsedAt: at, expiresAt });
    },
    async touch(tokenHash, at) {
      const s = mem.sessions.get(tokenHash);
      if (s) s.lastUsedAt = at;
    },
    async delete(tokenHash) {
      return mem.sessions.delete(tokenHash);
    },
    async deleteForAccount(accountId, { except } = {}) {
      let n = 0;
      for (const [h, s] of mem.sessions) {
        if (s.accountId === accountId && h !== except) {
          mem.sessions.delete(h);
          n++;
        }
      }
      return n;
    },
    async listForAccount(accountId) {
      return [...mem.sessions.values()]
        .filter((s) => s.accountId === accountId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((s) => ({ ...s }));
    },
    async prune(at) {
      let n = 0;
      for (const [h, s] of mem.sessions) if (s.expiresAt <= at) { mem.sessions.delete(h); n++; }
      return n;
    },
  };

  const live = (r, at) => r && r.usedAt === null && r.expiresAt > at;
  const signIns = {
    async create({ id, email, linkHash, codeHash, at, expiresAt }) {
      mem.signIns.set(id, { id, email, linkHash, codeHash, tries: 0, createdAt: at, expiresAt, usedAt: null });
    },
    async takeTry(id, { at, maxTries }) {
      const r = mem.signIns.get(id);
      if (!live(r, at) || r.tries >= maxTries) return null;
      r.tries += 1;
      const { linkHash, ...out } = r;
      return { ...out };
    },
    async use(id, at) {
      const r = mem.signIns.get(id);
      if (!live(r, at)) return null;
      r.usedAt = at;
      return r.email;
    },
    async useLink(linkHash, at) {
      for (const r of mem.signIns.values()) {
        if (r.linkHash === linkHash) {
          if (!live(r, at)) return null;
          r.usedAt = at;
          return r.email;
        }
      }
      return null;
    },
    async prune(at) {
      let n = 0;
      for (const [id, r] of mem.signIns) if (r.expiresAt + SIGN_IN.keepUsedMs <= at) { mem.signIns.delete(id); n++; }
      return n;
    },
    async deleteForEmail(email) {
      let n = 0;
      for (const [id, r] of mem.signIns) if (r.email === email) { mem.signIns.delete(id); n++; }
      return n;
    },
  };

  return { accounts, sessions, signIns };
}

// ---------------------------------------------------------------------------
// Postgres

const ms = (col) => `(extract(epoch FROM ${col}) * 1000)::bigint`;
export const TS = (n) => `to_timestamp($${n}::double precision / 1000)`;

const ACCOUNT_COLS = `id::text AS id, email, password_hash, role, tools, display_name, name_key, status,
  ${ms('created_at')} AS created_at, ${ms('last_seen_at')} AS last_seen_at`;

export const accountFromRow = (r) =>
  r
    ? {
        id: r.id, email: r.email, passwordHash: r.password_hash ?? null, role: r.role, tools: r.tools ?? [],
        displayName: r.display_name, nameKey: r.name_key, status: r.status,
        createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at),
      }
    : null;

const SESSION_COLS = `token_hash, account_id::text AS account_id, ${ms('created_at')} AS created_at,
  ${ms('renewed_at')} AS renewed_at, ${ms('expires_at')} AS expires_at, ${ms('last_used_at')} AS last_used_at, note`;

const sessionFromRow = (r) => ({
  tokenHash: r.token_hash, accountId: r.account_id, createdAt: Number(r.created_at), renewedAt: Number(r.renewed_at),
  expiresAt: Number(r.expires_at), lastUsedAt: Number(r.last_used_at), note: r.note,
});

/**
 * Serialises writers of one keeper name (lower-cased key) inside a transaction, across the accounts and
 * records tables, which have separate unique indexes. Use it before checking a name is free.
 */
export async function lockName(client, key) {
  await client.query(`SELECT pg_advisory_xact_lock(4127002, hashtext($1::text))`, [key]);
}

/** Runs fn(client) in a transaction on a pooled client. */
export async function inTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function pgAccountStores(pool) {
  const accounts = {
    recordId: recordIdForAccount,

    async byId(id) {
      if (!isAccountId(id)) return null;
      const { rows } = await pool.query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = $1::uuid`, [id]);
      return accountFromRow(rows[0]);
    },

    async byEmail(email) {
      const { rows } = await pool.query(`SELECT ${ACCOUNT_COLS} FROM accounts WHERE email = $1`, [email]);
      return accountFromRow(rows[0]);
    },

    async signIn(email, { at, role } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO accounts AS a (email, role, created_at, last_seen_at)
         VALUES ($1, COALESCE($2::text, 'player'), ${TS(3)}, ${TS(3)})
         ON CONFLICT (email) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                                           role = COALESCE($2::text, a.role)
         RETURNING ${ACCOUNT_COLS}`,
        [email, role ?? null, at],
      );
      return accountFromRow(rows[0]);
    },

    async setPassword(id, hash) {
      if (!isAccountId(id)) return false;
      const r = await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1::uuid', [id, hash]);
      return r.rowCount > 0;
    },

    async setName(id, { name, key }) {
      if (!isAccountId(id)) return { status: 'no_account' };
      const rid = recordIdForAccount(id);
      try {
        return await inTransaction(pool, async (c) => {
          if (key !== '') {
            await lockName(c, key);
            const taken = await c.query(
              `SELECT 1 FROM accounts WHERE name_key = $1 AND id <> $2::uuid
               UNION ALL SELECT 1 FROM records WHERE name_key = $1 AND id <> $3 LIMIT 1`,
              [key, id, rid],
            );
            if (taken.rows.length > 0) return { status: 'name_taken' };
          }
          const u = await c.query('UPDATE accounts SET display_name = $2, name_key = $3 WHERE id = $1::uuid', [id, name, key]);
          if (u.rowCount === 0) return { status: 'no_account' };
          await c.query('UPDATE records SET name = $2, name_key = $3 WHERE id = $1', [rid, name, key]);
          return { status: 'ok' };
        });
      } catch (err) {
        if (err.code === '23505') return { status: 'name_taken' };
        throw err;
      }
    },

    async update(id, { role, tools, status } = {}) {
      if (!isAccountId(id)) return null;
      const { rows } = await pool.query(
        `UPDATE accounts SET role = COALESCE($2::text, role), tools = COALESCE($3::text[], tools),
                             status = COALESCE($4::text, status)
          WHERE id = $1::uuid RETURNING ${ACCOUNT_COLS}`,
        [id, role ?? null, tools ?? null, status ?? null],
      );
      return accountFromRow(rows[0]);
    },

    async touch(id, at) {
      if (!isAccountId(id)) return;
      await pool.query(`UPDATE accounts SET last_seen_at = ${TS(2)} WHERE id = $1::uuid`, [id, at]);
    },

    async delete(id) {
      if (!isAccountId(id)) return false;
      return inTransaction(pool, async (c) => {
        await c.query('DELETE FROM sessions WHERE account_id = $1::uuid', [id]);
        await c.query('DELETE FROM account_saves WHERE account_id = $1::uuid', [id]);
        await c.query('DELETE FROM records WHERE id = $1', [recordIdForAccount(id)]);
        const r = await c.query('DELETE FROM accounts WHERE id = $1::uuid', [id]);
        return r.rowCount > 0;
      });
    },
  };

  const sessions = {
    async create({ tokenHash, accountId, at, expiresAt, note = '' }) {
      await pool.query(
        `INSERT INTO sessions (token_hash, account_id, created_at, renewed_at, expires_at, last_used_at, note)
         VALUES ($1, $2::uuid, ${TS(3)}, ${TS(3)}, ${TS(4)}, ${TS(3)}, $5)`,
        [tokenHash, accountId, at, expiresAt, note],
      );
    },
    async get(tokenHash) {
      const { rows } = await pool.query(`SELECT ${SESSION_COLS} FROM sessions WHERE token_hash = $1`, [tokenHash]);
      return rows[0] ? sessionFromRow(rows[0]) : null;
    },
    async renew(tokenHash, { at, expiresAt }) {
      await pool.query(
        `UPDATE sessions SET renewed_at = ${TS(2)}, last_used_at = ${TS(2)}, expires_at = ${TS(3)} WHERE token_hash = $1`,
        [tokenHash, at, expiresAt],
      );
    },
    async touch(tokenHash, at) {
      await pool.query(`UPDATE sessions SET last_used_at = ${TS(2)} WHERE token_hash = $1`, [tokenHash, at]);
    },
    async delete(tokenHash) {
      return (await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])).rowCount > 0;
    },
    async deleteForAccount(accountId, { except } = {}) {
      if (!isAccountId(accountId)) return 0;
      const r = await pool.query(
        'DELETE FROM sessions WHERE account_id = $1::uuid AND ($2::text IS NULL OR token_hash <> $2::text)',
        [accountId, except ?? null],
      );
      return r.rowCount;
    },
    async listForAccount(accountId) {
      if (!isAccountId(accountId)) return [];
      const { rows } = await pool.query(
        `SELECT ${SESSION_COLS} FROM sessions WHERE account_id = $1::uuid ORDER BY created_at DESC`,
        [accountId],
      );
      return rows.map(sessionFromRow);
    },
    async prune(at) {
      return (await pool.query(`DELETE FROM sessions WHERE expires_at <= ${TS(1)}`, [at])).rowCount;
    },
  };

  const signIns = {
    async create({ id, email, linkHash, codeHash, at, expiresAt }) {
      await pool.query(
        `INSERT INTO sign_ins (id, email, link_hash, code_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, ${TS(5)}, ${TS(6)})`,
        [id, email, linkHash, codeHash, at, expiresAt],
      );
    },
    async takeTry(id, { at, maxTries }) {
      const { rows } = await pool.query(
        `UPDATE sign_ins SET tries = tries + 1
          WHERE id = $1 AND used_at IS NULL AND expires_at > ${TS(2)} AND tries < $3
          RETURNING id, email, code_hash, tries, ${ms('created_at')} AS created_at, ${ms('expires_at')} AS expires_at`,
        [id, at, maxTries],
      );
      const r = rows[0];
      return r
        ? { id: r.id, email: r.email, codeHash: r.code_hash, tries: r.tries, createdAt: Number(r.created_at),
            expiresAt: Number(r.expires_at), usedAt: null }
        : null;
    },
    async use(id, at) {
      const { rows } = await pool.query(
        `UPDATE sign_ins SET used_at = ${TS(2)} WHERE id = $1 AND used_at IS NULL AND expires_at > ${TS(2)} RETURNING email`,
        [id, at],
      );
      return rows[0]?.email ?? null;
    },
    async useLink(linkHash, at) {
      const { rows } = await pool.query(
        `UPDATE sign_ins SET used_at = ${TS(2)} WHERE link_hash = $1 AND used_at IS NULL AND expires_at > ${TS(2)} RETURNING email`,
        [linkHash, at],
      );
      return rows[0]?.email ?? null;
    },
    async prune(at) {
      return (await pool.query(`DELETE FROM sign_ins WHERE expires_at <= ${TS(1)}`, [at - SIGN_IN.keepUsedMs])).rowCount;
    },
    async deleteForEmail(email) {
      return (await pool.query('DELETE FROM sign_ins WHERE email = $1', [email])).rowCount;
    },
  };

  return { accounts, sessions, signIns };
}
