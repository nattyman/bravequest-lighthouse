// Tokens, hashes and passwords for accounts. Node built-ins only. Spec: ACCOUNTS.md (sections 1 and 3).

import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { PASSWORD } from './limits.js';

export const randomToken = (bytes) => randomBytes(bytes).toString('base64url');
export const sha256Hex = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hmacHex = (secret, s) => createHmac('sha256', secret).update(String(s)).digest('hex');
/** Six digits, leading zeros kept. */
export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

/** Constant-time comparison of two strings (false when the lengths differ). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // spend comparable time
    return false;
  }
  return timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Passwords: scrypt$N$r$p$salt$hash (salt and hash base64url)

/** Thrown (as err.code === 'busy') when too many hashes are already waiting. */
export class BusyError extends Error {
  constructor() {
    super('password hashing is busy');
    this.code = 'busy';
  }
}

/**
 * A small semaphore: at most `concurrent` scrypt runs at once and at most `queue` waiting, so a burst of
 * password requests cannot hold more than (concurrent * 128 * N * r) bytes of memory.
 */
export function createHasher({ concurrent = PASSWORD.concurrent, queue = PASSWORD.queue, params = PASSWORD.scrypt } = {}) {
  let active = 0;
  const waiting = [];

  function run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          const next = waiting.shift();
          if (next) next();
        });
      };
      if (active < concurrent) go();
      else if (waiting.length < queue) waiting.push(go);
      else reject(new BusyError());
    });
  }

  const derive = (password, salt, { N, r, p, keyLen }) =>
    new Promise((resolve, reject) => {
      scrypt(String(password).normalize('NFC'), salt, keyLen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });

  // A fixed hash to check against when there is no stored one, so "no such account" costs the same time.
  let dummy = null;

  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiting.length;
    },

    /** -> 'scrypt$N$r$p$salt$hash' */
    hash(password) {
      return run(async () => {
        const salt = randomBytes(params.saltBytes);
        const key = await derive(password, salt, params);
        return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
      });
    },

    /** true when `password` matches `stored`. With no stored hash it still does the work and answers false. */
    verify(password, stored) {
      return run(async () => {
        if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) {
          if (!dummy) {
            const salt = randomBytes(params.saltBytes);
            dummy = `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64url')}$${(await derive('x', salt, params)).toString('base64url')}`;
          }
          await verifyOne(password, dummy);
          return false;
        }
        return verifyOne(password, stored);
      });
    },
  };

  async function verifyOne(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const N = Number(n);
    const R = Number(r);
    const P = Number(p);
    if (![N, R, P].every(Number.isSafeInteger) || N < 2 || N > PASSWORD.maxN || (N & (N - 1)) !== 0 || R < 1 || R > 32 || P < 1 || P > 16) {
      return false;
    }
    const expected = Buffer.from(hashB64, 'base64url');
    if (expected.length < 16 || expected.length > 128) return false;
    const key = await derive(password, Buffer.from(saltB64, 'base64url'), { N, r: R, p: P, keyLen: expected.length });
    return timingSafeEqual(key, expected);
  }
}

// ---------------------------------------------------------------------------
// Password rules

// A short list of common passwords that meet the length rule. Compared lower-cased.
const COMMON = new Set([
  '1234567890', '12345678910', '0123456789', '0987654321', '1111111111', '0000000000', '1234512345',
  '123456789a', 'a123456789', '1q2w3e4r5t', '1qaz2wsx3edc', 'qwertyuiop', 'qwertyuiop1', 'asdfghjkl1',
  'zxcvbnm123', 'password12', 'password123', 'password1234', 'password!1', 'passw0rd123', 'iloveyou12',
  'iloveyou123', 'letmein123', 'welcome123', 'welcome1234', 'football12', 'football123', 'baseball12',
  'basketball', 'superman12', 'starwars12', 'princess12', 'sunshine12', 'qwerty1234', 'qwerty12345',
  'abc1234567', 'abcdefghij', 'abcd123456', 'trustno1234', 'changeme123', 'administrator', 'admin12345',
  'lighthouse', 'lighthouse1', 'lighthouse123', 'bravequest', 'bravequest1', 'bravequest123',
]);

/** null when the new password is acceptable, else 'weak_password'. */
export function checkNewPassword(pw) {
  if (typeof pw !== 'string') return 'weak_password';
  if (pw.length < PASSWORD.minChars || pw.length > PASSWORD.maxChars || pw.includes('\u0000')) return 'weak_password';
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) return 'weak_password';
  if (/^(.)\1+$/.test(pw)) return 'weak_password'; // one character repeated
  return null;
}
