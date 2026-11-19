// Storage for account save slots (the `account_saves` table). Spec: ACCOUNTS.md (sections 2 and 3).
//
// Mounted on the main store as store.slots (see store.js). Basic reads and writes only; the save-slot
// routes (and claim) build on these.
//
//   list(accountId) -> [{ slot, name, test, at, objective, rec, updated, bytes }]   used slots, by slot
//   get(accountId, slot) -> { slot, name, test, at, objective, rec, body, updated } | null
//   put(accountId, slot, { at, objective, body, rec?, name?, test? }, { updatedAt })
//       -> { at, test, created }
//       Upsert. name: given, else the stored one, else `Save <slot>`. test is sticky: stored OR given.
//       rec: given (object), else the stored one, else null. No "newer wins" check here.
//   rename(accountId, slot, name) -> boolean   (false: no such slot)
//   delete(accountId, slot) -> boolean
//   deleteAll(accountId) -> number
//   count(accountId) -> number
//
// `updated` is ms. `bytes` is the body's length in characters (what the admin shows as size).

import { isAccountId, TS } from './accounts.js';

export const SLOT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_saves (
     account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
     slot smallint NOT NULL CHECK (slot BETWEEN 1 AND 10),
     name text NOT NULL,
     test boolean NOT NULL DEFAULT false,
     at bigint NOT NULL,
     objective text NOT NULL DEFAULT '',
     rec jsonb,
     body text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (account_id, slot)
   )`,
];

export const defaultSlotName = (slot) => `Save ${slot}`;

export function memorySlotStore(mem) {
  const slotsOf = (id, create = false) => {
    let m = mem.accountSaves.get(id);
    if (!m && create) mem.accountSaves.set(id, (m = new Map()));
    return m;
  };
  const clone = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

  return {
    async list(accountId) {
      const m = slotsOf(accountId);
      if (!m) return [];
      return [...m.values()]
        .sort((a, b) => a.slot - b.slot)
        .map((r) => ({
          slot: r.slot, name: r.name, test: r.test, at: r.at, objective: r.objective, rec: clone(r.rec),
          updated: r.updated, bytes: r.body.length,
        }));
    },
    async get(accountId, slot) {
      const r = slotsOf(accountId)?.get(slot);
      return r ? { slot: r.slot, name: r.name, test: r.test, at: r.at, objective: r.objective, rec: clone(r.rec), body: r.body, updated: r.updated } : null;
    },
    async put(accountId, slot, { at, objective, body, rec, name, test }, { updatedAt } = {}) {
      const m = slotsOf(accountId, true);
      const old = m.get(slot);
      const row = {
        slot,
        name: name ?? old?.name ?? defaultSlotName(slot),
        test: Boolean(old?.test) || Boolean(test),
        at,
        objective,
        rec: rec !== undefined && rec !== null ? clone(rec) : old?.rec ?? null,
        body,
        updated: updatedAt ?? Date.now(),
      };
      m.set(slot, row);
      return { at, test: row.test, created: !old };
    },
    async rename(accountId, slot, name) {
      const r = slotsOf(accountId)?.get(slot);
      if (!r) return false;
      r.name = name;
      return true;
    },
    async delete(accountId, slot) {
      return slotsOf(accountId)?.delete(slot) ?? false;
    },
    async deleteAll(accountId) {
      const n = slotsOf(accountId)?.size ?? 0;
      mem.accountSaves.delete(accountId);
      return n;
    },
    async count(accountId) {
      return slotsOf(accountId)?.size ?? 0;
    },
  };
}

const UPDATED = `(extract(epoch FROM updated_at) * 1000)::bigint AS updated`;

export function pgSlotStore(pool) {
  const toRow = (r, withBody) => {
    const out = {
      slot: r.slot, name: r.name, test: r.test, at: Number(r.at), objective: r.objective, rec: r.rec ?? null,
    };
    if (withBody) out.body = r.body;
    out.updated = Number(r.updated);
    if (!withBody) out.bytes = Number(r.bytes);
    return out;
  };
  return {
    async list(accountId) {
      if (!isAccountId(accountId)) return [];
      const { rows } = await pool.query(
        `SELECT slot, name, test, at, objective, rec, ${UPDATED}, length(body) AS bytes
           FROM account_saves WHERE account_id = $1::uuid ORDER BY slot`,
        [accountId],
      );
      return rows.map((r) => toRow(r, false));
    },
    async get(accountId, slot) {
      if (!isAccountId(accountId)) return null;
      const { rows } = await pool.query(
        `SELECT slot, name, test, at, objective, rec, body, ${UPDATED}
           FROM account_saves WHERE account_id = $1::uuid AND slot = $2`,
        [accountId, slot],
      );
      return rows[0] ? toRow(rows[0], true) : null;
    },
    async put(accountId, slot, { at, objective, body, rec, name, test }, { updatedAt } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO account_saves AS s (account_id, slot, name, test, at, objective, rec, body, updated_at)
         VALUES ($1::uuid, $2, COALESCE($3::text, $9::text), $4, $5, $6, $7::jsonb, $8, ${TS(10)})
         ON CONFLICT (account_id, slot) DO UPDATE SET
           name = COALESCE($3::text, s.name),
           test = s.test OR EXCLUDED.test,
           at = EXCLUDED.at,
           objective = EXCLUDED.objective,
           rec = COALESCE($7::jsonb, s.rec),
           body = EXCLUDED.body,
           updated_at = EXCLUDED.updated_at
         RETURNING at, test, (xmax = 0) AS created`,
        [
          accountId, slot, name ?? null, Boolean(test), at, objective,
          rec === undefined || rec === null ? null : JSON.stringify(rec), body, `Save ${slot}`, updatedAt ?? Date.now(),
        ],
      );
      return { at: Number(rows[0].at), test: rows[0].test, created: rows[0].created === true };
    },
    async rename(accountId, slot, name) {
      if (!isAccountId(accountId)) return false;
      const r = await pool.query('UPDATE account_saves SET name = $3 WHERE account_id = $1::uuid AND slot = $2', [accountId, slot, name]);
      return r.rowCount > 0;
    },
    async delete(accountId, slot) {
      if (!isAccountId(accountId)) return false;
      const r = await pool.query('DELETE FROM account_saves WHERE account_id = $1::uuid AND slot = $2', [accountId, slot]);
      return r.rowCount > 0;
    },
    async deleteAll(accountId) {
      if (!isAccountId(accountId)) return 0;
      return (await pool.query('DELETE FROM account_saves WHERE account_id = $1::uuid', [accountId])).rowCount;
    },
    async count(accountId) {
      if (!isAccountId(accountId)) return 0;
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM account_saves WHERE account_id = $1::uuid', [accountId]);
      return rows[0].n;
    },
  };
}
