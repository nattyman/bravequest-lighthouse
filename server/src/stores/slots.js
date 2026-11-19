// Storage for account save slots (the `account_saves` table). Spec: ACCOUNTS.md (sections 2 and 3).
//
// Mounted on the main store as store.slots (see store.js). Basic reads and writes only; the save-slot
// routes (and claim) build on these.
//
//   list(accountId) -> [{ slot, name, test, at, objective, rec, updated, bytes }]   used slots, by slot
//   get(accountId, slot) -> { slot, name, test, at, objective, rec, body, updated } | null
//   put(accountId, slot, { at, objective, body, rec?, name?, test? }, { updatedAt, ifNewer? })
//       -> { at, test, created }
//       Upsert. name: given, else the stored one, else `Save <slot>`. test is sticky: stored OR given.
//       rec: given (object), else the stored one, else null.
//       ifNewer: true -> newer wins, atomically (as the guest putSave): when the slot holds a save whose `at`
//       is as new or newer, nothing is written and the answer is { stale: true, at: <stored at> }.
//       Without it (the admin, tests) the write always happens.
//   rename(accountId, slot, name) -> boolean   (false: no such slot)
//   delete(accountId, slot) -> boolean
//   deleteAll(accountId) -> number
//   count(accountId) -> number
//   claim(accountId, guestId, { slot?, at, beforeCommit? })
//       Moves a guest's save (the `saves` row `guestId`) into a slot and retires the guest, all or nothing
//       (one transaction in Postgres; no await between the checks and the writes in memory):
//       - the save goes into `slot`, or the first free slot when slot is null/undefined; name `Save <n>`,
//         test false, rec null, updated = at;
//       - the guest's record row (`records` id guestId), if any, is merged into the account's ('a:' + id):
//         bests keep the lower value (act1, full, fullDeaths, each boss), build/play/deaths/pct/badges/rank/
//         days/splits come from whichever row was uploaded last, crew is the account's unless it has none,
//         hidden if either was, created = the earlier of the two; created from the guest's when the account
//         has no record row;
//       - the guest's keeper name moves to the account (display_name, name_key, and the record's name) only
//         when the account has none and nobody else holds it (under lockName in Postgres); otherwise the
//         account keeps its own name (also written to the merged record);
//       - the guest's `saves` and `records` rows are deleted.
//       beforeCommit (tests only) runs after every write and before the commit; if it throws, nothing changes.
//       -> { status: 'ok', slot, name }        name: the account's keeper name afterwards ('' = none)
//       -> { status: 'no_save' }               no save stored under guestId
//       -> { status: 'full' }                  no slot given and all ten are used
//       -> { status: 'slot_taken' }            the slot given is used
//       -> { status: 'no_account' }
//
// `updated` is ms. `bytes` is the body's length in characters (what the admin shows as size).

import { inTransaction, isAccountId, lockName, recordIdForAccount, TS } from './accounts.js';
import { SLOTS } from '../accounts/limits.js';

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

const minOf = (a, b) => (a === null || a === undefined ? b ?? null : b === null || b === undefined ? a : Math.min(a, b));

/** The first slot (1..SLOTS.max) not in `used`, or null. */
export function firstFreeSlot(used) {
  const set = new Set(used);
  for (let n = 1; n <= SLOTS.max; n++) if (!set.has(n)) return n;
  return null;
}

/**
 * Merges a guest's record into an account's (both in the memory store's row shape; `acct` may be null).
 * Returns the merged fields except id/name/nameKey/seq, which the caller sets.
 */
export function mergeRecordRows(acct, guest) {
  if (!acct) {
    return {
      createdAt: guest.createdAt, updatedAt: guest.updatedAt, hidden: guest.hidden, crew: guest.crew,
      build: guest.build, play: guest.play, deaths: guest.deaths, pct: guest.pct, badges: guest.badges,
      rank: guest.rank, days: guest.days, act1: guest.act1, full: guest.full, fullDeaths: guest.fullDeaths,
      splits: { ...guest.splits }, bosses: { ...guest.bosses },
    };
  }
  const latest = guest.updatedAt > acct.updatedAt ? guest : acct;
  const bosses = { ...acct.bosses };
  for (const [id, t] of Object.entries(guest.bosses)) bosses[id] = bosses[id] === undefined ? t : Math.min(bosses[id], t);
  return {
    createdAt: Math.min(acct.createdAt, guest.createdAt),
    updatedAt: Math.max(acct.updatedAt, guest.updatedAt),
    hidden: Boolean(acct.hidden || guest.hidden),
    crew: acct.crew !== '' ? acct.crew : guest.crew,
    build: latest.build, play: latest.play, deaths: latest.deaths, pct: latest.pct, badges: latest.badges,
    rank: latest.rank, days: latest.days, splits: { ...latest.splits },
    act1: minOf(acct.act1, guest.act1), full: minOf(acct.full, guest.full), fullDeaths: minOf(acct.fullDeaths, guest.fullDeaths),
    bosses,
  };
}

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
    async put(accountId, slot, { at, objective, body, rec, name, test }, { updatedAt, ifNewer = false } = {}) {
      const m = slotsOf(accountId, true);
      const old = m.get(slot);
      if (ifNewer && old && old.at >= at) return { stale: true, at: old.at };
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
    async claim(accountId, guestId, { slot, at, beforeCommit } = {}) {
      // Every check and the whole new state are worked out first; the writes come last, with no await between.
      const account = mem.accounts.get(accountId);
      if (!account) return { status: 'no_account' };
      const save = mem.saves.get(guestId);
      if (!save) return { status: 'no_save' };
      const used = [...(slotsOf(accountId)?.keys() ?? [])];
      let target = slot ?? null;
      if (target === null) {
        target = firstFreeSlot(used);
        if (target === null) return { status: 'full' };
      } else if (used.includes(target)) return { status: 'slot_taken' };

      const rid = recordIdForAccount(accountId);
      const guestRec = mem.records.get(guestId) ?? null;
      const acctRec = mem.records.get(rid) ?? null;
      let name = account.displayName;
      let nameKey = account.nameKey;
      if (nameKey === '' && guestRec && guestRec.nameKey !== '') {
        const k = guestRec.nameKey;
        const clash = [...mem.accounts.values()].some((a) => a.id !== accountId && a.nameKey === k) ||
          [...mem.records].some(([id, r]) => id !== guestId && id !== rid && r.nameKey === k);
        if (!clash) {
          name = guestRec.name;
          nameKey = k;
        }
      }
      let merged = null;
      if (guestRec) {
        merged = {
          ...mergeRecordRows(acctRec, guestRec), id: rid, name, nameKey,
          seq: acctRec ? Math.min(acctRec.seq, guestRec.seq) : guestRec.seq,
        };
      }
      const row = {
        slot: target, name: defaultSlotName(target), test: false, at: save.at, objective: save.objective, rec: null,
        body: save.body, updated: at ?? Date.now(),
      };
      if (beforeCommit) beforeCommit();

      slotsOf(accountId, true).set(target, row);
      mem.saves.delete(guestId);
      mem.records.delete(guestId);
      if (merged) mem.records.set(rid, merged);
      account.displayName = name;
      account.nameKey = nameKey;
      const own = mem.records.get(rid);
      if (own) {
        own.name = name;
        own.nameKey = nameKey;
      }
      return { status: 'ok', slot: target, name };
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
    async put(accountId, slot, { at, objective, body, rec, name, test }, { updatedAt, ifNewer = false } = {}) {
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
         ${ifNewer ? 'WHERE s.at < EXCLUDED.at' : ''}
         RETURNING at, test, (xmax = 0) AS created`,
        [
          accountId, slot, name ?? null, Boolean(test), at, objective,
          rec === undefined || rec === null ? null : JSON.stringify(rec), body, `Save ${slot}`, updatedAt ?? Date.now(),
        ],
      );
      if (rows.length === 0) {
        // Only with ifNewer: the stored save is as new or newer.
        const cur = await pool.query('SELECT at FROM account_saves WHERE account_id = $1::uuid AND slot = $2', [accountId, slot]);
        return { stale: true, at: cur.rows[0] ? Number(cur.rows[0].at) : 0 };
      }
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
    async claim(accountId, guestId, { slot, at, beforeCommit } = {}) {
      if (!isAccountId(accountId)) return { status: 'no_account' };
      const rid = recordIdForAccount(accountId);
      try {
        return await inTransaction(pool, async (c) => {
          // The name lock comes first (as in accounts.setName), then the rows, so the two cannot deadlock.
          const peek = await c.query('SELECT name_key FROM records WHERE id = $1', [guestId]);
          const lockedKey = peek.rows[0]?.name_key ?? '';
          if (lockedKey !== '') await lockName(c, lockedKey);
          const acc = await c.query('SELECT display_name, name_key FROM accounts WHERE id = $1::uuid FOR UPDATE', [accountId]);
          if (acc.rows.length === 0) return { status: 'no_account' };
          const save = await c.query('SELECT at, objective, body FROM saves WHERE id = $1 FOR UPDATE', [guestId]);
          if (save.rows.length === 0) return { status: 'no_save' };
          const used = (await c.query('SELECT slot FROM account_saves WHERE account_id = $1::uuid', [accountId])).rows.map((r) => r.slot);
          let target = slot ?? null;
          if (target === null) {
            target = firstFreeSlot(used);
            if (target === null) return { status: 'full' };
          } else if (used.includes(target)) return { status: 'slot_taken' };

          const recs = await c.query(`SELECT ${REC_COLS} FROM records WHERE id = $1 OR id = $2 FOR UPDATE`, [guestId, rid]);
          const guestRec = recFromRow(recs.rows.find((r) => r.id === guestId));
          const acctRec = recFromRow(recs.rows.find((r) => r.id === rid));

          const s = save.rows[0];
          // A plain INSERT: a slot filled meanwhile by a PUT is a unique violation, answered as slot_taken.
          await c.query(
            `INSERT INTO account_saves (account_id, slot, name, test, at, objective, rec, body, updated_at)
             VALUES ($1::uuid, $2, $3, false, $4, $5, NULL, $6, ${TS(7)})`,
            [accountId, target, defaultSlotName(target), s.at, s.objective, s.body, at ?? Date.now()],
          );
          await c.query('DELETE FROM saves WHERE id = $1', [guestId]);
          await c.query('DELETE FROM records WHERE id = $1', [guestId]);

          let name = acc.rows[0].display_name;
          let nameKey = acc.rows[0].name_key;
          if (nameKey === '' && guestRec && guestRec.nameKey !== '' && guestRec.nameKey === lockedKey) {
            const taken = await c.query(
              `SELECT 1 FROM accounts WHERE name_key = $1 AND id <> $2::uuid
               UNION ALL SELECT 1 FROM records WHERE name_key = $1 AND id <> $3 LIMIT 1`,
              [lockedKey, accountId, rid],
            );
            if (taken.rows.length === 0) {
              name = guestRec.name;
              nameKey = lockedKey;
              await c.query('UPDATE accounts SET display_name = $2, name_key = $3 WHERE id = $1::uuid', [accountId, name, nameKey]);
            }
          }
          if (guestRec) {
            const m = mergeRecordRows(acctRec, guestRec);
            await c.query(
              `INSERT INTO records AS r (id, name, name_key, crew, build, play, deaths, pct, badges, rank, days,
                                         act1, full_run, full_deaths, splits, bosses, hidden, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::jsonb, $17,
                       ${TS(18)}, ${TS(19)})
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name, name_key = EXCLUDED.name_key, crew = EXCLUDED.crew, build = EXCLUDED.build,
                 play = EXCLUDED.play, deaths = EXCLUDED.deaths, pct = EXCLUDED.pct, badges = EXCLUDED.badges,
                 rank = EXCLUDED.rank, days = EXCLUDED.days, act1 = EXCLUDED.act1, full_run = EXCLUDED.full_run,
                 full_deaths = EXCLUDED.full_deaths, splits = EXCLUDED.splits, bosses = EXCLUDED.bosses,
                 hidden = EXCLUDED.hidden, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
              [
                rid, name, nameKey, m.crew, m.build, m.play, m.deaths, m.pct, m.badges, m.rank, m.days,
                m.act1, m.full, m.fullDeaths, JSON.stringify(m.splits), JSON.stringify(m.bosses), m.hidden,
                m.createdAt, m.updatedAt,
              ],
            );
          } else {
            await c.query('UPDATE records SET name = $2, name_key = $3 WHERE id = $1', [rid, name, nameKey]);
          }
          if (beforeCommit) await beforeCommit();
          return { status: 'ok', slot: target, name };
        });
      } catch (err) {
        if (err.code === '23505' && err.constraint === 'account_saves_pkey') return { status: 'slot_taken' };
        throw err;
      }
    },
  };
}

const REC_COLS = `id, name, name_key, crew, build, play, deaths, pct, badges, rank, days, act1, full_run, full_deaths,
  splits, bosses, hidden, (extract(epoch FROM created_at) * 1000)::bigint AS created_at,
  (extract(epoch FROM updated_at) * 1000)::bigint AS updated_at`;

/** A `records` row in the memory store's shape (what mergeRecordRows takes), or null. */
function recFromRow(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, nameKey: r.name_key, crew: r.crew, build: r.build, play: r.play, deaths: r.deaths,
    pct: r.pct, badges: r.badges, rank: r.rank, days: r.days, act1: r.act1, full: r.full_run, fullDeaths: r.full_deaths,
    splits: r.splits, bosses: r.bosses, hidden: r.hidden, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}
