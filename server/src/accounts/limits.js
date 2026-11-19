// Every number the account features depend on, in one place. Spec: ACCOUNTS.md.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Sessions (the bq_s cookie). */
export const SESSION = Object.freeze({
  cookie: 'bq_s',
  tokenBytes: 32, // base64url, 43 characters
  lifetimeMs: 60 * DAY, // Max-Age, and how far each renewal pushes the expiry
  renewAfterMs: DAY, // an authenticated request this long after the last renewal renews again
  touchAfterMs: 5 * MINUTE, // last_used_at / last_seen_at are written at most this often
  freshMs: 15 * MINUTE, // "signed in recently": needed to set a first password or delete the account
  noteChars: 40, // the device label kept with a session
});

/** Sign-in by emailed link and six-digit code. */
export const SIGN_IN = Object.freeze({
  lifetimeMs: 15 * MINUTE,
  codeTries: 5, // wrong codes allowed per sign-in; after that the sign-in is dead
  idBytes: 16,
  tokenBytes: 32,
  keepUsedMs: DAY, // expired and used sign-ins are deleted this long after they expire
});

/** Passwords. */
export const PASSWORD = Object.freeze({
  minChars: 10,
  maxChars: 200,
  // scrypt cost: N * r * 128 bytes of memory per hash (16 MiB here).
  scrypt: Object.freeze({ N: 16384, r: 8, p: 1, keyLen: 32, saltBytes: 16 }),
  maxN: 1 << 20, // a stored hash asking for more than this is refused rather than run
  concurrent: 2, // hashes running at once; the rest wait
  queue: 16, // hashes allowed to wait; beyond that the request gets 429
  busyRetryAfterS: 2,
});

/**
 * Rate limits, fixed windows held in memory (per process, reset on restart), in the same form as
 * DEFAULT_LIMITS in app.js. createApp's config.accounts.limits can override any of them (tests).
 */
export const ACCOUNT_LIMITS = Object.freeze({
  startPerEmail: { max: 5, windowMs: HOUR }, // POST /v1/auth/start, per address (over the limit: 200, no email)
  startPerIp: { max: 20, windowMs: HOUR }, // POST /v1/auth/start, per client address (429)
  passwordPerEmailIp: { max: 10, windowMs: 15 * MINUTE }, // POST /v1/auth/password, per address + client
  passwordPerIp: { max: 30, windowMs: 15 * MINUTE }, // POST /v1/auth/password, per client
  // Not in the spec's list, added so sign-in ids and link tokens cannot be sprayed from one address:
  attemptsPerIp: { max: 60, windowMs: 15 * MINUTE }, // POST /v1/auth/code + /v1/auth/link, per client
  me: { max: 120, windowMs: MINUTE }, // GET/PUT/DELETE /v1/me and /v1/auth/signout, per client
});

/** The test panel's tool groups, in the order the panel shows them. */
export const TOOL_GROUPS = Object.freeze(['start', 'cheats', 'give', 'map', 'teleport', 'monsters']);
/** What every tester gets when settings.tester_tools has never been set. */
export const DEFAULT_TESTER_TOOLS = Object.freeze(['start', 'give', 'map', 'teleport']);
export const ROLES = Object.freeze(['player', 'tester', 'admin']);
export const STATUSES = Object.freeze(['active', 'disabled']);

/** Account save slots. */
export const SLOTS = Object.freeze({ max: 10, nameChars: 24 });

export const MAX_EMAIL_CHARS = 254;
/** The private admin API's key must be at least this long, or the admin API stays off. */
export const MIN_ADMIN_KEY_CHARS = 32;
export const MIN_SESSION_SECRET_CHARS = 32;
