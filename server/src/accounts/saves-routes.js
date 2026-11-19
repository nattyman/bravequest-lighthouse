// Account save slots: /v1/saves, /v1/saves/:slot, /v1/saves/:slot/rename, /v1/saves/claim.
// Spec: ACCOUNTS.md (section 3, "Save slots").
//
// savesRoutes(ctx) -> [{ method, path | match, run(req, res, { ip, params }) }]. Mounted by createApp under the
// accounts switch (503 accounts_off), which also handles CORS with credentials and 404/405.
// Account only: guests (a Bearer sync code) and signed-out callers get 401 signed_out. Writes need the
// cookie request check (X-BQ-Client: 1 + an exactly-listed Origin), done by ctx.resolveOwner.
// ctx.guest = { limits, maxSaveBodyBytes } is set by createApp: the guest routes' limiters and save size.

import {
  MAX_SAVE_BODY_BYTES, isStr, normaliseKey, readJsonBody, saveIdForKey, send, sendLimited, validateSave,
} from '../http.js';
import { SLOTS } from './limits.js';

const SLOT_RE = /^(?:[1-9]|10)$/;
const REC_KEYS = ['play', 'pct', 'rank', 'ri'];
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** '1'..'10' -> number, else null. */
export const parseSlot = (raw) => (typeof raw === 'string' && SLOT_RE.test(raw) ? Number(raw) : null);

/** A slot name: trimmed, 1..24 characters, no control characters. -> string | null */
export function cleanSlotName(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > SLOTS.nameChars || CONTROL_RE.test(name)) return null;
  return name;
}

/**
 * The save's small summary for the slot list: { play?, pct?, rank?, ri? }, each a finite number, a short
 * string or null. Other keys are dropped. -> object | null (invalid)
 */
export function cleanRec(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of REC_KEYS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (v === null || (typeof v === 'number' && Number.isFinite(v)) || isStr(v, SLOTS.recChars)) out[k] = v;
    else return null;
  }
  return out;
}

export function savesRoutes(ctx) {
  const { store, limits, now } = ctx;
  const maxBytes = () => ctx.guest?.maxSaveBodyBytes ?? MAX_SAVE_BODY_BYTES;

  /** Rate limit, then the signed-in owner; null when an answer was already sent. */
  async function account(req, res, ip) {
    const verdict = limits.slots.take(ip);
    if (!verdict.ok) {
      sendLimited(res, verdict);
      return null;
    }
    const r = await ctx.resolveOwner(req, res);
    if (r.error && r.error !== 'bad_key') {
      send(res, r.status, { error: r.error });
      return null;
    }
    if (!r.owner || r.owner.kind !== 'account') {
      send(res, 401, { error: 'signed_out' });
      return null;
    }
    return r.owner;
  }

  function slotOf(res, params) {
    const slot = parseSlot(params.slot);
    if (slot === null) send(res, 400, { error: 'bad_slot' });
    return slot;
  }

  // GET /v1/saves -> {max, slots:[{slot, name, test, at, objective, rec, updated}]}
  async function list(req, res, { ip }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const rows = await store.slots.list(owner.id);
    return send(res, 200, {
      max: SLOTS.max,
      slots: rows.map((r) => ({ slot: r.slot, name: r.name, test: r.test, at: r.at, objective: r.objective, rec: r.rec, updated: r.updated })),
    });
  }

  // GET /v1/saves/:slot -> {slot, name, test, at, objective, rec, body, updated} | 404 no_save
  async function getOne(req, res, { ip, params }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const slot = slotOf(res, params);
    if (slot === null) return;
    const row = await store.slots.get(owner.id, slot);
    if (!row) return send(res, 404, { error: 'no_save' });
    return send(res, 200, {
      slot: row.slot, name: row.name, test: row.test, at: row.at, objective: row.objective, rec: row.rec, body: row.body,
      updated: row.updated,
    });
  }

  // PUT /v1/saves/:slot {v?, at, objective, save | body, rec?, name?, test?} -> {ok, at, test} | 409 {stale, at}
  async function put(req, res, { ip, params }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const slot = slotOf(res, params);
    if (slot === null) return;
    const body = await readJsonBody(req, res, { limit: maxBytes() });
    if (!body) return;
    // The guest /v1/save body ({v:1, at, objective, save}); `body` is accepted for `save`, and `v` may be left out.
    const save = validateSave({ ...body, v: body.v ?? 1, save: body.save ?? body.body });
    if (!save) return send(res, 400, { error: 'bad_request' });
    let name;
    if (body.name !== undefined && body.name !== null) {
      name = cleanSlotName(body.name);
      if (name === null) return send(res, 400, { error: 'bad_request' });
    }
    let rec;
    if (body.rec !== undefined && body.rec !== null) {
      rec = cleanRec(body.rec);
      if (rec === null) return send(res, 400, { error: 'bad_request' });
    }
    if (body.test !== undefined && body.test !== null && typeof body.test !== 'boolean') {
      return send(res, 400, { error: 'bad_request' });
    }
    const r = await store.slots.put(
      owner.id, slot, { ...save, rec, name, test: body.test === true }, { updatedAt: now(), ifNewer: true },
    );
    if (r.stale) return send(res, 409, { error: 'stale', at: r.at });
    return send(res, 200, { ok: true, at: r.at, test: r.test });
  }

  // POST /v1/saves/:slot/rename {name} -> {ok:true} | 404 no_save
  async function rename(req, res, { ip, params }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const slot = slotOf(res, params);
    if (slot === null) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const name = cleanSlotName(body.name);
    if (name === null) return send(res, 400, { error: 'bad_request' });
    if (!(await store.slots.rename(owner.id, slot, name))) return send(res, 404, { error: 'no_save' });
    return send(res, 200, { ok: true });
  }

  // DELETE /v1/saves/:slot -> {ok:true} (also when the slot was already empty)
  async function remove(req, res, { ip, params }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const slot = slotOf(res, params);
    if (slot === null) return;
    await store.slots.delete(owner.id, slot);
    return send(res, 200, { ok: true });
  }

  // POST /v1/saves/claim {code, slot?} -> {ok:true, slot, name}
  async function claim(req, res, { ip }) {
    const owner = await account(req, res, ip);
    if (!owner) return;
    const failed = ctx.guest?.limits?.failedLookups ?? null;
    let verdict = failed ? failed.check(ip) : { ok: true };
    if (!verdict.ok) return sendLimited(res, verdict);
    verdict = limits.claimsPerAccount.take(owner.id);
    if (!verdict.ok) return sendLimited(res, verdict);
    verdict = limits.claimsPerIp.take(ip);
    if (!verdict.ok) return sendLimited(res, verdict);
    const body = await readJsonBody(req, res);
    if (!body) return;
    let slot = null;
    if (body.slot !== undefined && body.slot !== null) {
      slot = Number.isInteger(body.slot) && body.slot >= 1 && body.slot <= SLOTS.max ? body.slot : null;
      if (slot === null) return send(res, 400, { error: 'bad_slot' });
    }
    const key = normaliseKey(body.code);
    if (!key) return send(res, 401, { error: 'bad_key' });
    const r = await store.slots.claim(owner.id, saveIdForKey(key), { slot, at: now() });
    if (r.status === 'ok') return send(res, 200, { ok: true, slot: r.slot, name: r.name });
    if (r.status === 'no_save') {
      if (failed) failed.take(ip);
      return send(res, 404, { error: 'no_save' });
    }
    if (r.status === 'full' || r.status === 'slot_taken') return send(res, 409, { error: r.status });
    return send(res, 401, { error: 'signed_out' }); // no_account: deleted meanwhile
  }

  const SLOT_PATH = /^\/v1\/saves\/(?!claim$)(?<slot>[^/]+)$/;
  return [
    { method: 'GET', path: '/v1/saves', run: list },
    { method: 'POST', path: '/v1/saves/claim', run: claim },
    { method: 'GET', match: SLOT_PATH, run: getOne },
    { method: 'PUT', match: SLOT_PATH, run: put },
    { method: 'DELETE', match: SLOT_PATH, run: remove },
    { method: 'POST', match: /^\/v1\/saves\/(?<slot>[^/]+)\/rename$/, run: rename },
  ];
}
