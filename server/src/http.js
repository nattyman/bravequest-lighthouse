// Request helpers shared by every route module: sync keys, client address, request bodies.
// Moved out of app.js unchanged so the account, save-slot and admin route modules can use them.

import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';

const MINUTE = 60_000;
const KEY_RE = /^[0-9A-HJKMNP-TV-Z]{12,32}$/;
// ---------------------------------------------------------------------------
// Sync keys

/** Upper-case, strip dashes and spaces; returns null unless the result is a valid key. */
export function normaliseKey(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.toUpperCase().replace(/[-\s]/g, '');
  return KEY_RE.test(key) ? key : null;
}

export function saveIdForKey(normalisedKey) {
  return createHash('sha256').update(normalisedKey).digest('hex');
}

export function keyFromRequest(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? normaliseKey(match[1]) : null;
}

// ---------------------------------------------------------------------------
// Client address

/** Rate-limit bucket for an address: IPv4 as is, IPv6 collapsed to its /64. */
export function ipBucket(ip) {
  let s = String(ip || 'unknown').trim().slice(0, 64).toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (!isIPv6(s)) return s;
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = s.includes('::')
    ? [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Request bodies

export const TOO_LARGE = Symbol('too_large');

/** Reads up to `limit` bytes. Resolves to a Buffer, or TOO_LARGE as soon as the limit is passed. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      resolve(TOO_LARGE);
      return;
    }
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering. The caller answers 413 with `Connection: close`; node then
        // discards whatever is still in flight and closes the socket.
        cleanup();
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('client closed the connection'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

export function parseJsonObject(buf) {
  if (!buf || buf.length === 0) return null;
  try {
    const value = JSON.parse(buf.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Body sizes and save validation

export const MAX_SAVE_BODY_BYTES = 300 * 1024;
export const MAX_SMALL_BODY_BYTES = 32 * 1024; // events, feedback and records
export const MAX_SAVE_CHARS = 245_760;
export const MAX_OBJECTIVE_CHARS = 120;

export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

// Postgres text columns cannot hold NUL, so reject it up front (400 rather than a 500).
export const isStr = (v, maxLen) => typeof v === 'string' && v.length <= maxLen && !v.includes('\u0000');
export const isOptStr = (v, maxLen) => v === undefined || v === null || isStr(v, maxLen);

/** Validates a PUT /v1/save body: { v:1, at, objective, save } -> { at, objective, body } | null. */
export function validateSave(body) {
  if (!body || body.v !== 1) return null;
  if (!Number.isSafeInteger(body.at) || body.at <= 0) return null;
  // A save stamped far in the future would block every honest later save (they would all be 'stale') until the
  // clock caught up, so a wildly wrong device clock, or someone holding the code, cannot park one there.
  if (body.at > Date.now() + MAX_FUTURE_MS) return null;
  if (typeof body.objective !== 'string' || body.objective.includes('\u0000')) return null;
  if (!isStr(body.save, MAX_SAVE_CHARS) || body.save.length < 1) return null;
  return {
    at: body.at,
    objective: body.objective.slice(0, MAX_OBJECTIVE_CHARS),
    body: body.save,
  };
}


// ---------------------------------------------------------------------------
// Answers (the same as createApp's own send in app.js)

/** Sends a JSON answer with Cache-Control: no-store. payload undefined = empty body. */
export function send(res, status, payload, extraHeaders) {
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

/** 429 with Retry-After (seconds) from a limiter verdict { retryAfter }. */
export const sendLimited = (res, verdict) =>
  send(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(verdict.retryAfter) });

export const sendTooLarge = (res) => send(res, 413, { error: 'too_large' }, { Connection: 'close' });

/**
 * Reads a small JSON object body. Answers 413 / 400 itself and returns null in that case, else the object.
 * An empty body is {} when allowEmpty is set.
 */
export async function readJsonBody(req, res, { limit = MAX_SMALL_BODY_BYTES, allowEmpty = false } = {}) {
  const raw = await readBody(req, limit);
  if (raw === TOO_LARGE) {
    sendTooLarge(res);
    return null;
  }
  if (allowEmpty && raw.length === 0) return {};
  const body = parseJsonObject(raw);
  if (!body) {
    send(res, 400, { error: 'bad_request' });
    return null;
  }
  return body;
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
