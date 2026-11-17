// Player records and boards: ids, limits and validation for PUT /v1/record and GET /v1/board.
// Spec: RECORD.md (section 4).

import { isBlockedName } from './blocked-words.js';

/** Milestone ids, in the order the Record lists them. Play order varies in places (see AFTER). */
export const MILESTONES = Object.freeze([
  'ashore', 'plain-flame', 'stag', 'lantern', 'staff', 'lamp-cured',
  'gloaming', 'undertow', 'crane', 'answer', 'sailed', 'giant',
]);
/**
 * The order the story forces: each milestone cannot be reached before the ones listed for it.
 * Anything not listed is free (the staff can come before or after the plain flame fails; the
 * dungeons after Act 1 can be done in any order), so only these pairs are checked.
 */
export const AFTER = Object.freeze({
  'plain-flame': ['ashore'], staff: ['ashore'], stag: ['ashore'], lantern: ['stag'],
  'lamp-cured': ['lantern'], gloaming: ['lamp-cured'],
  undertow: ['gloaming'], crane: ['gloaming'], answer: ['gloaming'], sailed: ['gloaming'], giant: ['sailed'],
});
export const BOSSES = Object.freeze(['stag', 'gloaming', 'undertow', 'crane', 'answer', 'giant']);

/** The milestone that ends each timed board. */
export const ACT1_MILESTONE = 'gloaming';
export const FULL_MILESTONE = 'giant';

/** Fastest times the service believes (seconds of play). Anything quicker is refused. */
export const FLOORS = Object.freeze({ act1: 300, full: 1200, boss: 10 });

/** Upper bounds for the numbers in a record (inclusive; all must be integers >= 0). */
export const RANGES = Object.freeze({
  play: 50_000_000, // about 19 months of play, in seconds
  deaths: 1_000_000,
  pct: 100,
  badges: 1000,
  rank: 20,
  days: 10_000,
});

export const BOARDS = Object.freeze(['act1', 'full', 'deaths', 'pct']);
export const BOARD_LIMIT = Object.freeze({ default: 25, max: 100 });

const NAME_RE = /^[A-Za-z0-9 _'-]{3,16}$/;
const CREW_RE = /^[A-Z0-9]{4,12}$/;
const MAX_BUILD_CHARS = 40;

const isCount = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Cleans a display name: trims, turns any run of spacing into one space, curly apostrophe to '.
 * Returns { name, key } or null if the result breaks the rules (length, characters, blocked words).
 * '' is a valid name (it takes the player off the boards).
 */
export function cleanName(raw) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const name = raw.replace(/’/g, "'").replace(/\s+/g, ' ').trim();
  if (name === '') return { name: '', key: '' };
  if (!NAME_RE.test(name)) return null;
  if (!/[A-Za-z0-9]/.test(name)) return null;
  if (isBlockedName(name)) return null;
  return { name, key: name.toLowerCase() };
}

/** Normalises a crew code to upper case. '' is valid (no crew). Returns null when invalid. */
export function cleanCrew(raw) {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  const crew = raw.trim().toUpperCase();
  if (crew === '') return '';
  return CREW_RE.test(crew) ? crew : null;
}

/**
 * Validates a PUT /v1/record body.
 * Returns { error: 'bad_request' | 'name_invalid' } or { record } where record is what the store takes:
 *   { name: string|undefined (undefined = keep), nameKey, crew: string|undefined (undefined = keep),
 *     build, play, deaths, pct, badges, rank, days, act1, full, fullDeaths, splits, bosses }
 */
export function validateRecord(body) {
  const bad = { error: 'bad_request' };
  if (!isPlainObject(body)) return bad;
  if (typeof body.build !== 'string' || body.build.length > MAX_BUILD_CHARS || body.build.includes('\u0000')) return bad;
  for (const field of Object.keys(RANGES)) if (!isCount(body[field], RANGES[field])) return bad;

  // Splits: { milestoneId: seconds of play when it was reached | null (reached, time unknown) }.
  if (!isPlainObject(body.splits)) return bad;
  const splits = {};
  for (const [id, t] of Object.entries(body.splits)) {
    if (!MILESTONES.includes(id)) return bad;
    if (t === null) {
      splits[id] = null;
      continue;
    }
    if (!isCount(t, body.play)) return bad; // no milestone after the play time that is being reported
    splits[id] = t;
  }
  // A milestone cannot be timed before one the story puts ahead of it (through any untimed ones between).
  const floorOf = (id, seen = new Set()) => {
    let most = -1;
    for (const before of AFTER[id] || []) {
      if (seen.has(before)) continue;
      seen.add(before);
      most = Math.max(most, typeof splits[before] === 'number' ? splits[before] : floorOf(before, seen));
    }
    return most;
  };
  for (const id of MILESTONES) if (typeof splits[id] === 'number' && splits[id] < floorOf(id)) return bad;
  const act1 = typeof splits[ACT1_MILESTONE] === 'number' ? splits[ACT1_MILESTONE] : null;
  const full = typeof splits[FULL_MILESTONE] === 'number' ? splits[FULL_MILESTONE] : null;
  if (act1 !== null && act1 < FLOORS.act1) return bad;
  if (full !== null && full < FLOORS.full) return bad;

  // Bosses: { bossId: best winning fight in seconds }. null = no win yet (dropped).
  if (!isPlainObject(body.bosses)) return bad;
  const bosses = {};
  for (const [id, t] of Object.entries(body.bosses)) {
    if (!BOSSES.includes(id)) return bad;
    if (t === null) continue;
    if (!isCount(t, RANGES.play) || t < FLOORS.boss) return bad;
    bosses[id] = t;
  }

  let name;
  let nameKey;
  if (body.name !== undefined && body.name !== null) {
    const cleaned = cleanName(body.name);
    if (!cleaned) return { error: 'name_invalid' };
    name = cleaned.name;
    nameKey = cleaned.key;
  }
  let crew;
  if (body.crew !== undefined && body.crew !== null) {
    crew = cleanCrew(body.crew);
    if (crew === null) return bad;
  }

  return {
    record: {
      name,
      nameKey,
      crew,
      build: body.build,
      play: body.play,
      deaths: body.deaths,
      pct: body.pct,
      badges: body.badges,
      rank: body.rank,
      days: body.days,
      act1,
      full,
      // Deaths on a finished full run: only set when this upload has the final milestone time.
      fullDeaths: full !== null ? body.deaths : null,
      splits,
      bosses,
    },
  };
}

/**
 * Parses the GET /v1/board query. Returns null when invalid, else { board, boss, crew, limit }
 * (board is one of BOARDS or 'boss'; boss is the boss id for 'boss').
 */
export function parseBoardQuery(params) {
  const b = params.get('b');
  let board;
  let boss = null;
  if (b !== null && BOARDS.includes(b)) board = b;
  else if (b !== null && b.startsWith('boss:') && BOSSES.includes(b.slice(5))) {
    board = 'boss';
    boss = b.slice(5);
  } else return null;

  let crew = '';
  const rawCrew = params.get('crew');
  if (rawCrew !== null) {
    crew = cleanCrew(rawCrew);
    if (crew === null) return null;
  }

  let limit = BOARD_LIMIT.default;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) return null;
    limit = Number(rawLimit);
    if (limit < 1 || limit > BOARD_LIMIT.max) return null;
  }
  return { board, boss, crew, limit };
}
