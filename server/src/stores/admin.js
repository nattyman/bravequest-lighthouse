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

import { TS } from './accounts.js';

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

const page = ({ page: p = 1, per = 50 } = {}) => {
  const n = Math.max(1, Math.min(200, Math.floor(Number(per)) || 50));
  const pg = Math.max(1, Math.floor(Number(p)) || 1);
  return { per: n, offset: (pg - 1) * n };
};

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
  return { audit, settings };
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
  return { audit, settings };
}
