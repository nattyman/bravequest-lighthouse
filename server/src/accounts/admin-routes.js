// The private admin API: /admin/v1/*. Spec: ACCOUNTS.md (section 4).
//
// adminGuard(ctx, req) runs before any admin route (createApp calls it) and answers for the whole prefix:
//   - no ADMIN_API_KEY (or shorter than 32 characters)          -> 404 not_found
//   - the request came through the public tunnel (cf-connecting-ip or cf-ray header), or carries an Origin
//     header (a browser)                                          -> 404 not_found
//   - X-Admin-Key missing or wrong (constant-time compare)       -> 401 {error:'admin_key'}
//   - X-Admin-Email missing or not an address                    -> 400 {error:'admin_email'}
// and on success returns { adminEmail } (lower-cased), passed to each route as info.adminEmail.
//
// The routes (all JSON; ids that are malformed or unknown are 404 {error:'not_found'}; dates are epoch ms):
//   GET    /admin/v1/accounts?q=&role=&status=&page=&per=   -> {total, page, per, rows:[{id, email, name, role,
//                                                              status, created, lastSeen, saves, super}]}
//   GET    /admin/v1/accounts/:id     -> {account, saves:[...with bytes], sessions:[{created, lastUsed, note}], record}
//   POST   /admin/v1/accounts/:id     {role?, tools?, status?, name?} -> {ok:true, account}   super admin: 409 super
//   POST   /admin/v1/accounts/:id/signout        -> {ok:true, ended}
//   POST   /admin/v1/accounts/:id/signin-email   -> {ok:true}   (503 accounts_off while accounts are off)
//   DELETE /admin/v1/accounts/:id                -> {ok:true}   super admin: 409 super
//   GET    /admin/v1/accounts/:id/saves/:slot    -> {slot, name, test, at, objective, rec, body}  | 404 no_save
//   DELETE /admin/v1/accounts/:id/saves/:slot    -> {ok:true}                                     | 404 no_save
//   GET    /admin/v1/audit?page=&per=            -> {total, page, per, rows:[{at, admin_email, action, account_id, email, detail}]}
//   GET    /admin/v1/settings                    -> {testerTools}
//   PUT    /admin/v1/settings {testerTools}      -> {ok:true, testerTools}
// Every change, and every download of a whole save, writes one audit row (never a save body, token or password).

import { readJsonBody, send } from '../http.js';
import { cleanName } from '../records.js';
import { MAX_PER_PAGE } from '../stores/admin.js';
import { createSignIn } from './auth-routes.js';
import { safeEqual } from './crypto.js';
import { DEFAULT_TESTER_TOOLS, MIN_ADMIN_KEY_CHARS, ROLES, STATUSES, TOOL_GROUPS } from './limits.js';

export const ADMIN_PREFIX = '/admin/v1';
export const isAdminPath = (path) => path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);

/** -> { adminEmail } | { status, error } */
export function adminGuard(ctx, req) {
  const key = ctx.config.admin?.apiKey;
  if (typeof key !== 'string' || key.length < MIN_ADMIN_KEY_CHARS) return { status: 404, error: 'not_found' };
  const h = req.headers;
  if (h['cf-connecting-ip'] !== undefined || h['cf-ray'] !== undefined || h.origin !== undefined) {
    return { status: 404, error: 'not_found' };
  }
  const given = typeof h['x-admin-key'] === 'string' ? h['x-admin-key'] : '';
  if (!safeEqual(given, key)) return { status: 401, error: 'admin_key' };
  const adminEmail = ctx.normaliseEmail(h['x-admin-email']);
  if (!adminEmail) return { status: 400, error: 'admin_email' };
  return { adminEmail };
}

const ID = '(?<id>[^/]+)';
const MAX_Q_CHARS = 100;
const SLOT_RE = /^(?:[1-9]|10)$/;

/** A 1-based page number and a page size (1..200, default 50) from the query; null when malformed. */
function paging(params) {
  const p = params.get('page');
  const n = params.get('per');
  const page = p === null || p === '' ? 1 : /^\d{1,7}$/.test(p) ? Number(p) : NaN;
  const per = n === null || n === '' ? 50 : /^\d{1,4}$/.test(n) ? Number(n) : NaN;
  if (!(page >= 1) || !(per >= 1)) return null;
  return { page, per: Math.min(per, MAX_PER_PAGE) };
}

/** Known tool groups, without repeats, in the panel's order; null unless an array of known groups. */
function cleanGroups(v) {
  if (!Array.isArray(v) || v.length > 50 || v.some((g) => typeof g !== 'string' || !TOOL_GROUPS.includes(g))) return null;
  return TOOL_GROUPS.filter((g) => v.includes(g));
}

export function adminRoutes(ctx) {
  const { store } = ctx;
  const notFound = (res) => send(res, 404, { error: 'not_found' });
  const bad = (res) => send(res, 400, { error: 'bad_request' });
  const audit = (info, action, accountId, detail) => ctx.audit({ adminEmail: info.adminEmail, action, accountId, detail });

  /** The account the admin view shows (dates as epoch ms). */
  const accountOut = (a) => ({
    id: a.id, email: a.email, name: a.displayName, role: a.role, tools: [...a.tools], status: a.status,
    hasPassword: Boolean(a.passwordHash), created: a.createdAt, lastSeen: a.lastSeenAt, super: ctx.isSuper(a),
  });

  // GET /admin/v1/accounts
  async function listAccounts(req, res, { query }) {
    const params = new URLSearchParams(query);
    const pg = paging(params);
    if (!pg) return bad(res);
    const role = params.get('role') || null;
    const status = params.get('status') || null;
    if ((role && !ROLES.includes(role)) || (status && !STATUSES.includes(status))) return bad(res);
    const q = (params.get('q') ?? '').trim().slice(0, MAX_Q_CHARS);
    const r = await store.admin.listAccounts({ q, role, status, ...pg });
    return send(res, 200, {
      total: r.total,
      page: pg.page,
      per: pg.per,
      rows: r.rows.map((a) => ({
        id: a.id, email: a.email, name: a.displayName, role: a.role, status: a.status,
        created: a.createdAt, lastSeen: a.lastSeenAt, saves: a.saves, super: ctx.isSuperEmail(a.email),
      })),
    });
  }

  // GET /admin/v1/accounts/:id
  async function getAccount(req, res, { params }) {
    const a = await store.accounts.byId(params.id);
    if (!a) return notFound(res);
    const [saves, sessions, record] = await Promise.all([
      store.slots.list(a.id),
      store.sessions.listForAccount(a.id),
      store.getRecord(store.accounts.recordId(a.id)),
    ]);
    const t = ctx.now();
    return send(res, 200, {
      account: accountOut(a),
      saves: saves.map((s) => ({
        slot: s.slot, name: s.name, test: s.test, at: s.at, objective: s.objective, rec: s.rec, updated: s.updated, bytes: s.bytes,
      })),
      // Live sessions only (an expired one is just waiting to be pruned). Never the token hash.
      sessions: sessions.filter((s) => s.expiresAt > t).map((s) => ({ created: s.createdAt, lastUsed: s.lastUsedAt, note: s.note })),
      record: record ?? null,
    });
  }

  // POST /admin/v1/accounts/:id {role?, tools?, status?, name?}: the admin sends one field at a time; several
  // are accepted, all are checked before anything is written, and each change is its own audit row.
  async function updateAccount(req, res, info) {
    const a = await store.accounts.byId(info.params.id);
    if (!a) return notFound(res);
    if (ctx.isSuper(a)) return send(res, 409, { error: 'super' });
    const body = await readJsonBody(req, res);
    if (!body) return;
    const FIELDS = ['role', 'tools', 'status', 'name'];
    const keys = Object.keys(body);
    if (keys.length === 0 || keys.some((k) => !FIELDS.includes(k))) return bad(res);

    const change = {};
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return bad(res);
      change.role = body.role;
    }
    if (body.tools !== undefined) {
      const tools = cleanGroups(body.tools);
      if (!tools) return bad(res);
      change.tools = tools;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return bad(res);
      change.status = body.status;
    }
    let name;
    if (body.name !== undefined) {
      name = cleanName(body.name); // the same rules as PUT /v1/me
      if (!name) return send(res, 400, { error: 'name_invalid' });
    }

    // The name first: it is the only change that can still be refused.
    if (name) {
      const r = await store.accounts.setName(a.id, name);
      if (r.status === 'name_taken') return send(res, 409, { error: 'name_taken' });
      if (r.status !== 'ok') return notFound(res);
      await audit(info, 'name', a.id, { from: a.displayName, to: name.name });
    }
    let fresh = a;
    if (Object.keys(change).length > 0) {
      fresh = await store.accounts.update(a.id, change);
      if (!fresh) return notFound(res);
      if (change.role !== undefined) await audit(info, 'role', a.id, { from: a.role, to: change.role });
      if (change.tools !== undefined) await audit(info, 'tools', a.id, { from: a.tools, to: change.tools });
      if (change.status !== undefined) {
        // Disabling ends every session at once (a disabled account's cookie is refused anyway).
        const ended = change.status === 'disabled' ? await store.sessions.deleteForAccount(a.id) : 0;
        await audit(info, change.status === 'disabled' ? 'disable' : 'enable', a.id,
          { from: a.status, to: change.status, ...(change.status === 'disabled' ? { sessionsEnded: ended } : {}) });
      }
    }
    fresh = (await store.accounts.byId(a.id)) ?? fresh;
    return send(res, 200, { ok: true, account: accountOut(fresh) });
  }

  // POST /admin/v1/accounts/:id/signout (allowed for a super admin)
  async function signOut(req, res, info) {
    const a = await store.accounts.byId(info.params.id);
    if (!a) return notFound(res);
    const ended = await store.sessions.deleteForAccount(a.id);
    await audit(info, 'signout', a.id, { sessionsEnded: ended });
    return send(res, 200, { ok: true, ended });
  }

  // POST /admin/v1/accounts/:id/signin-email: the normal sign-in email (allowed for a super admin)
  async function signInEmail(req, res, info) {
    const a = await store.accounts.byId(info.params.id);
    if (!a) return notFound(res);
    if (!ctx.enabled || !ctx.mailer) return send(res, 503, { error: 'accounts_off' });
    if (a.status !== 'active') return send(res, 409, { error: 'disabled' }); // the sign-in could only be refused
    const { message } = await createSignIn(ctx, a.email);
    try {
      await ctx.mailer.send({ to: a.email, ...message });
    } catch (err) {
      ctx.log(`mail failed (admin sign-in) ${err?.code || err?.name || 'Error'}`);
      await audit(info, 'signin-email', a.id, { sent: false });
      return send(res, 502, { error: 'mail_failed' });
    }
    await audit(info, 'signin-email', a.id, { sent: true });
    ctx.pruneSoon();
    return send(res, 200, { ok: true });
  }

  // DELETE /admin/v1/accounts/:id: the account, its saves, record and sessions (refused for a super admin)
  async function deleteAccount(req, res, info) {
    const a = await store.accounts.byId(info.params.id);
    if (!a) return notFound(res);
    if (ctx.isSuper(a)) return send(res, 409, { error: 'super' });
    const saves = await store.slots.count(a.id);
    const record = (await store.getRecord(store.accounts.recordId(a.id))) !== null;
    if (!(await store.accounts.delete(a.id))) return notFound(res);
    await store.signIns.deleteForEmail(a.email);
    // The account's address stays in the detail: the log's email column is empty once the account is gone.
    await audit(info, 'delete', a.id, { email: a.email, name: a.displayName, role: a.role, saves, record });
    return send(res, 200, { ok: true });
  }

  /** The account and slot of a save route, or an answer already sent (returns null then). */
  async function saveTarget(res, params) {
    const a = await store.accounts.byId(params.id);
    if (!a) {
      notFound(res);
      return null;
    }
    if (!SLOT_RE.test(params.slot)) {
      send(res, 400, { error: 'bad_slot' });
      return null;
    }
    return { a, slot: Number(params.slot) };
  }

  // GET /admin/v1/accounts/:id/saves/:slot: the whole save (audited: it is the player's data)
  async function getSave(req, res, info) {
    const t = await saveTarget(res, info.params);
    if (!t) return;
    const s = await store.slots.get(t.a.id, t.slot);
    if (!s) return send(res, 404, { error: 'no_save' });
    await audit(info, 'save-download', t.a.id, { slot: s.slot, name: s.name, test: s.test, bytes: s.body.length });
    return send(res, 200, { slot: s.slot, name: s.name, test: s.test, at: s.at, objective: s.objective, rec: s.rec, body: s.body });
  }

  // DELETE /admin/v1/accounts/:id/saves/:slot (allowed for a super admin)
  async function deleteSave(req, res, info) {
    const t = await saveTarget(res, info.params);
    if (!t) return;
    const s = await store.slots.get(t.a.id, t.slot);
    if (!s || !(await store.slots.delete(t.a.id, t.slot))) return send(res, 404, { error: 'no_save' });
    await audit(info, 'save-delete', t.a.id, { slot: s.slot, name: s.name, test: s.test, at: s.at });
    return send(res, 200, { ok: true });
  }

  // GET /admin/v1/audit
  async function listAudit(req, res, { query }) {
    const pg = paging(new URLSearchParams(query));
    if (!pg) return bad(res);
    const r = await store.audit.list(pg);
    return send(res, 200, {
      total: r.total,
      page: pg.page,
      per: pg.per,
      rows: r.rows.map((x) => ({
        at: x.at, admin_email: x.adminEmail, action: x.action, account_id: x.accountId, email: x.email, detail: x.detail,
      })),
    });
  }

  const testerTools = async () => {
    const stored = await store.settings.get('tester_tools');
    return Array.isArray(stored) ? cleanGroups(stored) ?? [...DEFAULT_TESTER_TOOLS] : [...DEFAULT_TESTER_TOOLS];
  };

  // GET /admin/v1/settings (also the admin's health probe)
  async function getSettings(req, res) {
    return send(res, 200, { testerTools: await testerTools() });
  }

  // PUT /admin/v1/settings {testerTools:[groups]}
  async function putSettings(req, res, info) {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const groups = cleanGroups(body.testerTools);
    if (!groups || Object.keys(body).some((k) => k !== 'testerTools')) return bad(res);
    const from = await testerTools();
    await store.settings.set('tester_tools', groups);
    await audit(info, 'settings', null, { testerTools: { from, to: groups } });
    return send(res, 200, { ok: true, testerTools: groups });
  }

  const acct = (rest = '') => new RegExp(`^/admin/v1/accounts/${ID}${rest}$`);
  return [
    { method: 'GET', path: '/admin/v1/accounts', run: listAccounts },
    { method: 'GET', match: acct(), run: getAccount },
    { method: 'POST', match: acct(), run: updateAccount },
    { method: 'DELETE', match: acct(), run: deleteAccount },
    { method: 'POST', match: acct('/signout'), run: signOut },
    { method: 'POST', match: acct('/signin-email'), run: signInEmail },
    { method: 'GET', match: acct('/saves/(?<slot>[^/]+)'), run: getSave },
    { method: 'DELETE', match: acct('/saves/(?<slot>[^/]+)'), run: deleteSave },
    { method: 'GET', path: '/admin/v1/audit', run: listAudit },
    { method: 'GET', path: '/admin/v1/settings', run: getSettings },
    { method: 'PUT', path: '/admin/v1/settings', run: putSettings },
  ];
}
