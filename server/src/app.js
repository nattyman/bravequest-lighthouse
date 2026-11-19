// HTTP handler for the Lighthouse save service.
//
// createApp({ store, config }) returns a plain (req, res) handler for node:http.
// Nothing here logs sync keys, save bodies or feedback text.

import { parseBoardQuery, validateRecord } from './records.js';
import {
  MAX_SAVE_BODY_BYTES, MAX_SMALL_BODY_BYTES, TOO_LARGE, clientIp, ipBucket, isOptStr, isStr, keyFromRequest,
  normaliseKey, parseJsonObject, readBody, saveIdForKey, validateSave,
} from './http.js';

export { normaliseKey, saveIdForKey };

const MINUTE = 60_000;
const HOUR = 3_600_000;

export const DEFAULT_LIMITS = Object.freeze({
  saves: { max: 120, windowMs: MINUTE }, // GET + PUT /v1/save combined
  events: { max: 120, windowMs: MINUTE },
  feedback: { max: 5, windowMs: HOUR },
  failedLookups: { max: 30, windowMs: HOUR }, // GET /v1/save answering 404
  newSaves: { max: 10, windowMs: HOUR }, // brand-new save ids
  boards: { max: 30, windowMs: MINUTE }, // GET /v1/board + GET /v1/record combined
});


const EVENT_NAME_RE = /^[a-z0-9_.:-]{1,48}$/;
const SID_RE = /^[a-z0-9]{8,24}$/;
const PLATFORMS = new Set(['touch', 'keyboard', 'pad', 'unknown']);

const ROUTES = {
  '/health': ['GET'],
  '/v1/save': ['GET', 'PUT'],
  '/v1/event': ['POST'],
  '/v1/feedback': ['POST'],
  '/v1/record': ['GET', 'PUT'],
  '/v1/board': ['GET'],
};


// ---------------------------------------------------------------------------
// CORS origins

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles ALLOWED_ORIGINS entries. Accepts a comma-separated string or an array.
 *   https://nattyman.github.io   exact origin
 *   https://*.itch.zone          `*` is exactly one subdomain label
 *   http://localhost:*           `*` is any port (the bare origin without a port also matches)
 * Returns { test(origin), invalid: [entries that were ignored] }.
 */
export function compileOrigins(input) {
  const entries = (Array.isArray(input) ? input : String(input ?? '').split(','))
    .map((e) => String(e).trim().toLowerCase().replace(/\/+$/, ''))
    .filter(Boolean);
  const exact = new Set();
  const patterns = [];
  const invalid = [];

  for (const entry of entries) {
    const stars = entry.split('*').length - 1;
    if (stars === 0) {
      if (/^https?:\/\/[^/\s]+$/.test(entry)) exact.add(entry);
      else invalid.push(entry);
      continue;
    }
    if (stars > 1) {
      invalid.push(entry);
      continue;
    }
    let m;
    if ((m = /^(https?:\/\/[a-z0-9.-]+):\*$/.exec(entry))) {
      patterns.push(new RegExp(`^${escapeRegExp(m[1])}(?::\\d{1,5})?$`));
    } else if ((m = /^(https?:\/\/)\*(\.[a-z0-9.-]+(?::\d{1,5})?)$/.exec(entry))) {
      patterns.push(
        new RegExp(`^${escapeRegExp(m[1])}[a-z0-9](?:[a-z0-9-]*[a-z0-9])?${escapeRegExp(m[2])}$`),
      );
    } else {
      invalid.push(entry);
    }
  }

  return {
    invalid,
    size: exact.size + patterns.length,
    test(origin) {
      if (typeof origin !== 'string' || origin.length > 300) return false;
      const o = origin.toLowerCase();
      return exact.has(o) || patterns.some((re) => re.test(o));
    },
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (fixed window, in memory, per key)

export function createLimiter({ max, windowMs }, now = Date.now, maxKeys = 100_000) {
  const buckets = new Map(); // key -> { count, resetAt }
  let lastPrune = now();

  function prune(t) {
    for (const [key, b] of buckets) if (b.resetAt <= t) buckets.delete(key);
    // Hard cap so a flood of distinct addresses cannot grow the map without bound:
    // drop the oldest entries (Map iterates in insertion order).
    if (buckets.size > maxKeys) {
      let excess = buckets.size - maxKeys;
      for (const key of buckets.keys()) {
        buckets.delete(key);
        if (--excess <= 0) break;
      }
    }
    lastPrune = t;
  }

  function live(key, t) {
    if (t - lastPrune >= Math.min(windowMs, MINUTE) || buckets.size > maxKeys) prune(t);
    const b = buckets.get(key);
    if (b && b.resetAt > t) return b;
    if (b) buckets.delete(key);
    return null;
  }

  const retryAfter = (b, t) => Math.max(1, Math.ceil((b.resetAt - t) / 1000));

  return {
    /** Counts one hit. { ok: false, retryAfter } when the window is already full. */
    take(key) {
      const t = now();
      let b = live(key, t);
      if (!b) {
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(key, b);
      }
      if (b.count >= max) return { ok: false, retryAfter: retryAfter(b, t) };
      b.count += 1;
      return { ok: true };
    },
    /** Like take() but does not count. */
    check(key) {
      const t = now();
      const b = live(key, t);
      if (b && b.count >= max) return { ok: false, retryAfter: retryAfter(b, t) };
      return { ok: true };
    },
    /** Gives back one hit taken in the current window. */
    refund(key) {
      const b = live(key, now());
      if (b && b.count > 0) b.count -= 1;
    },
    get size() {
      return buckets.size;
    },
    prune: () => prune(now()),
  };
}


function validateEvent(body) {
  if (!body) return null;
  if (typeof body.name !== 'string' || !EVENT_NAME_RE.test(body.name)) return null;
  if (!isStr(body.build, 40)) return null;
  if (!PLATFORMS.has(body.platform)) return null;
  if (typeof body.sid !== 'string' || !SID_RE.test(body.sid)) return null;
  return { name: body.name, build: body.build, platform: body.platform, sid: body.sid };
}

function validateFeedback(body) {
  if (!body || typeof body.text !== 'string') return null;
  const text = body.text.trim();
  if (text.length < 1 || !isStr(text, 4000)) return null;
  if (!isStr(body.build, 40)) return null;
  if (!PLATFORMS.has(body.platform)) return null;
  if (!isOptStr(body.progress, 120) || !isOptStr(body.contact, 200)) return null;
  return {
    text,
    build: body.build,
    platform: body.platform,
    progress: body.progress ?? '',
    contact: body.contact ?? '',
  };
}

// ---------------------------------------------------------------------------
// App

export function createApp({ store, config = {} }) {
  if (!store) throw new Error('createApp needs a store');
  const now = config.now ?? Date.now;
  const log = config.log ?? ((line) => console.log(line));
  const trustProxy = config.trustProxy ?? true;
  const origins = compileOrigins(config.allowedOrigins ?? []);
  const healthTimeoutMs = config.healthTimeoutMs ?? 3000;
  const maxSaveBodyBytes = config.maxSaveBodyBytes ?? MAX_SAVE_BODY_BYTES;

  const limits = {};
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    limits[name] = createLimiter({ ...DEFAULT_LIMITS[name], ...(config.limits?.[name] ?? {}) }, now);
  }

  function send(res, status, payload, extraHeaders) {
    if (res.headersSent) return;
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    if (payload === undefined) {
      res.end();
      return;
    }
    const text = JSON.stringify(payload);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
  }

  const limited = (res, verdict) =>
    send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(verdict.retryAfter) });

  const tooLarge = (res) => send(res, 413, { error: 'too_large' }, { Connection: 'close' });

  async function health(res) {
    let timer;
    try {
      await Promise.race([
        store.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('health check timed out')), healthTimeoutMs);
        }),
      ]);
      send(res, 200, { ok: true });
    } catch {
      send(res, 503, { ok: false });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getSave(req, res, ip) {
    let verdict = limits.saves.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    const key = keyFromRequest(req);
    if (!key) return send(res, 401, { error: 'bad_key' });
    verdict = limits.failedLookups.check(ip);
    if (!verdict.ok) return limited(res, verdict);

    const row = await store.getSave(saveIdForKey(key));
    if (!row) {
      limits.failedLookups.take(ip);
      return send(res, 404, { error: 'no_save' });
    }
    return send(res, 200, { v: 1, at: row.at, objective: row.objective, save: row.body });
  }

  async function putSave(req, res, ip) {
    const verdict = limits.saves.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    const key = keyFromRequest(req);
    if (!key) return send(res, 401, { error: 'bad_key' });

    const raw = await readBody(req, maxSaveBodyBytes);
    if (raw === TOO_LARGE) return tooLarge(res);
    const save = validateSave(parseJsonObject(raw));
    if (!save) return send(res, 400, { error: 'bad_request' });

    // Reserve a "new save id" slot before writing and hand it back if the write turned
    // out to be an update, so concurrent requests cannot overshoot the limit.
    const slot = limits.newSaves.take(ip);
    let result;
    try {
      result = await store.putSave(saveIdForKey(key), save, { allowCreate: slot.ok });
    } catch (err) {
      if (slot.ok) limits.newSaves.refund(ip);
      throw err;
    }
    if (slot.ok && !(result.status === 'ok' && result.created)) limits.newSaves.refund(ip);

    if (result.status === 'ok') return send(res, 200, { ok: true, at: result.at });
    if (result.status === 'stale') return send(res, 409, { error: 'stale', at: result.at });
    // create_denied: this address has used up its new save ids for the window.
    return limited(res, slot.ok ? { retryAfter: 1 } : slot);
  }

  async function postEvent(req, res, ip) {
    const verdict = limits.events.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    const raw = await readBody(req, MAX_SMALL_BODY_BYTES);
    if (raw === TOO_LARGE) return tooLarge(res);
    const event = validateEvent(parseJsonObject(raw));
    if (!event) return send(res, 400, { error: 'bad_request' });
    await store.addEvent(event);
    return send(res, 204);
  }

  async function postFeedback(req, res, ip) {
    let verdict = limits.feedback.check(ip);
    if (!verdict.ok) return limited(res, verdict);
    const raw = await readBody(req, MAX_SMALL_BODY_BYTES);
    if (raw === TOO_LARGE) return tooLarge(res);
    const feedback = validateFeedback(parseJsonObject(raw));
    if (!feedback) return send(res, 400, { error: 'bad_request' });
    // Only well-formed feedback uses up the allowance, so a typo does not cost a slot.
    verdict = limits.feedback.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    await store.addFeedback(feedback);
    return send(res, 204);
  }

  // PUT /v1/record shares the events budget (the game sends it alongside its progress pings).
  async function putRecord(req, res, ip) {
    const verdict = limits.events.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    const key = keyFromRequest(req);
    if (!key) return send(res, 401, { error: 'bad_key' });
    const raw = await readBody(req, MAX_SMALL_BODY_BYTES);
    if (raw === TOO_LARGE) return tooLarge(res);
    const checked = validateRecord(parseJsonObject(raw));
    if (checked.error) return send(res, 400, { error: checked.error });
    const result = await store.putRecord(saveIdForKey(key), checked.record);
    if (result.status === 'ok') return send(res, 200, { ok: true, name: result.name });
    if (result.status === 'name_taken') return send(res, 409, { error: 'name_taken' });
    return send(res, 404, { error: 'no_save' });
  }

  async function getRecord(req, res, ip) {
    let verdict = limits.boards.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    const key = keyFromRequest(req);
    if (!key) return send(res, 401, { error: 'bad_key' });
    // An address already locked out for guessing save codes is locked out here too.
    verdict = limits.failedLookups.check(ip);
    if (!verdict.ok) return limited(res, verdict);
    const row = await store.getRecord(saveIdForKey(key));
    if (!row) return send(res, 404, { error: 'no_record' });
    return send(res, 200, row);
  }

  async function getBoard(req, res, ip, query) {
    const verdict = limits.boards.take(ip);
    if (!verdict.ok) return limited(res, verdict);
    let youId;
    if (req.headers.authorization !== undefined) {
      const key = keyFromRequest(req);
      if (!key) return send(res, 401, { error: 'bad_key' });
      youId = saveIdForKey(key);
    }
    const q = parseBoardQuery(new URLSearchParams(query));
    if (!q) return send(res, 400, { error: 'bad_request' });
    const result = await store.board({ ...q, youId });
    const payload = { b: q.board === 'boss' ? `boss:${q.boss}` : q.board, crew: q.crew, rows: result.rows };
    if (youId !== undefined) payload.you = result.you ?? null;
    return send(res, 200, payload);
  }

  async function route(req, res, path, query) {
    const method = req.method;
    const allowed = ROUTES[path];
    const origin = req.headers.origin;

    if (origin !== undefined) {
      if (origins.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.setHeader('Access-Control-Expose-Headers', 'Retry-After'); // so the game can read how long to wait after a 429
      } else if (path !== '/health') {
        return send(res, 403, { error: 'origin_not_allowed' }, { Vary: 'Origin' });
      }
    }

    if (!allowed) return send(res, 404, { error: 'not_found' });
    if (method === 'OPTIONS') return send(res, 204);
    if (!allowed.includes(method)) {
      return send(res, 405, { error: 'method_not_allowed' }, { Allow: [...allowed, 'OPTIONS'].join(', ') });
    }

    if (path === '/health') return health(res);
    const ip = ipBucket(clientIp(req, trustProxy));
    if (path === '/v1/save') return method === 'GET' ? getSave(req, res, ip) : putSave(req, res, ip);
    if (path === '/v1/record') return method === 'GET' ? getRecord(req, res, ip) : putRecord(req, res, ip);
    if (path === '/v1/board') return getBoard(req, res, ip, query);
    if (path === '/v1/event') return postEvent(req, res, ip);
    return postFeedback(req, res, ip);
  }

  function handler(req, res) {
    const started = now();
    const rawUrl = String(req.url || '/');
    const q = rawUrl.indexOf('?');
    const rawPath = q < 0 ? rawUrl : rawUrl.slice(0, q);
    const rawQuery = q < 0 ? '' : rawUrl.slice(q + 1, q + 1 + 1000);
    res.on('finish', () => {
      // Path only (never the query string), trimmed and stripped of control characters.
      const shown = rawPath.slice(0, 120).replace(/[^\x21-\x7e]/g, '?');
      log(`${req.method} ${shown} ${res.statusCode} ${now() - started}ms`);
    });
    route(req, res, rawPath, rawQuery).catch((err) => {
      // req.destroyed is not a sign the client left: node destroys the request stream once its
      // body has been read. Check the socket instead.
      if (res.headersSent || res.destroyed || req.socket?.destroyed) {
        if (!res.writableEnded) res.destroy();
        return;
      }
      // Error class/code only: driver messages can echo values.
      log(`error ${req.method} ${rawPath.slice(0, 120).replace(/[^\x21-\x7e]/g, '?')} ${err?.code || err?.name || 'Error'}`);
      send(res, 500, { error: 'internal' });
    });
  }

  handler.limits = limits; // exposed for tests and diagnostics
  handler.origins = origins;
  return handler;
}
