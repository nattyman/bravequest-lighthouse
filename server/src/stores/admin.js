// Storage for the audit log and service settings (the `audit` and `settings` tables).
// Spec: ACCOUNTS.md (sections 2 and 4).
//
// Mounted on the main store as store.audit and store.settings (see store.js).
//
// store.audit
//   add({ at, adminEmail, action, accountId?, detail? })
//   list({ page = 1, per = 50 }) -> { total, rows: [{ at, adminEmail, action, accountId, email, detail }] }
//       newest first; email is the account's current address, or null once the account is gone
//
// store.settings
//   get(key) -> value | null      (value is any JSON value)
//   set(key, value)
//
// store.admin (the account queries only the private admin API needs)
//   listAccounts({ q, role, status, page = 1, per = 50 })
//       -> { total, rows: [{ id, email, displayName, role, status, createdAt, lastSeenAt, saves }] }
//       newest first (created, then id). q: case-insensitive substring of the email or the keeper name
//       (taken literally: no wildcards). role / status: exact match when given. saves = used slots.
//       page is 1-based; per is 1..200 (default 50).

import { TS, accountFromRow } from './accounts.js';

export const ADMIN_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audit (
     id bigserial PRIMARY KEY,
     at timestamptz NOT NULL DEFAULT now(),
     admin_email text NOT NULL,
     action text NOT NULL,
     account_id uuid,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC, id DESC)`,
  `CREATE TABLE IF NOT EXISTS settings (
     key text PRIMARY KEY,
     value jsonb NOT NULL
   )`,
];

export const MAX_PER_PAGE = 200;
const page = ({ page: p = 1, per = 50 } = {}) => {
  const n = Math.max(1, Math.min(MAX_PER_PAGE, Math.floor(Number(per)) || 50));
  const pg = Math.max(1, Math.floor(Number(p)) || 1);
  return { per: n, offset: (pg - 1) * n };
};

const listRow = (a, saves) => ({
  id: a.id, email: a.email, displayName: a.displayName, role: a.role, status: a.status,
  createdAt: a.createdAt, lastSeenAt: a.lastSeenAt, saves,
});
const cleanQuery = (q) => (typeof q === 'string' ? q.trim().toLowerCase() : '');

export function memoryAdminStores(mem) {
  let seq = 0;
  const audit = {
    async add({ at, adminEmail, action, accountId = null, detail = {} }) {
      mem.audit.push({ id: ++seq, at: at ?? Date.now(), adminEmail, action, accountId, detail: JSON.parse(JSON.stringify(detail ?? {})) });
    },
    async list(opts) {
      const { per, offset } = page(opts);
      const sorted = [...mem.audit].sort((a, b) => b.at - a.at || b.id - a.id);
      return {
        total: sorted.length,
        rows: sorted.slice(offset, offset + per).map((r) => ({
          at: r.at, adminEmail: r.adminEmail, action: r.action, accountId: r.accountId,
          email: (r.accountId && mem.accounts.get(r.accountId)?.email) || null, detail: r.detail,
        })),
      };
    },
  };
  const settings = {
    async get(key) {
      return mem.settings.has(key) ? JSON.parse(mem.settings.get(key)) : null;
    },
    async set(key, value) {
      mem.settings.set(key, JSON.stringify(value));
    },
  };
  const admin = {
    async listAccounts({ q, role, status, ...opts } = {}) {
      const { per, offset } = page(opts);
      const needle = cleanQuery(q);
      const all = [...mem.accounts.values()]
        .filter((a) => !needle || a.email.toLowerCase().includes(needle) || a.displayName.toLowerCase().includes(needle))
        .filter((a) => !role || a.role === role)
        .filter((a) => !status || a.status === status)
        .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return {
        total: all.length,
        rows: all.slice(offset, offset + per).map((a) => listRow(a, mem.accountSaves.get(a.id)?.size ?? 0)),
      };
    },
  };
  return { audit, settings, admin };
}

export function pgAdminStores(pool) {
  const audit = {
    async add({ at, adminEmail, action, accountId = null, detail = {} }) {
      await pool.query(
        `INSERT INTO audit (at, admin_email, action, account_id, detail) VALUES (${TS(1)}, $2, $3, $4::uuid, $5::jsonb)`,
        [at ?? Date.now(), adminEmail, action, accountId, JSON.stringify(detail ?? {})],
      );
    },
    async list(opts) {
      const { per, offset } = page(opts);
      const total = (await pool.query('SELECT count(*)::int AS n FROM audit')).rows[0].n;
      const { rows } = await pool.query(
        `SELECT (extract(epoch FROM u.at) * 1000)::bigint AS at, u.admin_email, u.action, u.account_id::text AS account_id,
                a.email, u.detail
           FROM audit u LEFT JOIN accounts a ON a.id = u.account_id
          ORDER BY u.at DESC, u.id DESC LIMIT $1 OFFSET $2`,
        [per, offset],
      );
      return {
        total,
        rows: rows.map((r) => ({
          at: Number(r.at), adminEmail: r.admin_email, action: r.action, accountId: r.account_id, email: r.email ?? null,
          detail: r.detail,
        })),
      };
    },
  };
  const settings = {
    async get(key) {
      const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return rows.length ? rows[0].value : null;
    },
    async set(key, value) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    },
  };
  const admin = {
    async listAccounts({ q, role, status, ...opts } = {}) {
      const { per, offset } = page(opts);
      const where = `($1::text = '' OR position($1 in lower(a.email)) > 0 OR position($1 in lower(a.display_name)) > 0)
                 AND ($2::text IS NULL OR a.role = $2) AND ($3::text IS NULL OR a.status = $3)`;
      const params = [cleanQuery(q), role || null, status || null];
      const total = (await pool.query(`SELECT count(*)::int AS n FROM accounts a WHERE ${where}`, params)).rows[0].n;
      const { rows } = await pool.query(
        `SELECT a.id::text AS id, a.email, a.password_hash, a.role, a.tools, a.display_name, a.name_key, a.status,
                (extract(epoch FROM a.created_at) * 1000)::bigint AS created_at,
                (extract(epoch FROM a.last_seen_at) * 1000)::bigint AS last_seen_at,
                (SELECT count(*)::int FROM account_saves s WHERE s.account_id = a.id) AS saves
           FROM accounts a WHERE ${where}
          ORDER BY a.created_at DESC, a.id DESC LIMIT $4 OFFSET $5`,
        [...params, per, offset],
      );
      return { total, rows: rows.map((r) => listRow(accountFromRow(r), r.saves)) };
    },
  };
  return { audit, settings, admin };
}
