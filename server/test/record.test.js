// PUT /v1/record, GET /v1/record and GET /v1/board over HTTP (in-memory store).
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { cleanName, cleanCrew, FLOORS } from '../src/records.js';
import { isBlockedName, normalisedForms } from '../src/blocked-words.js';
import { auth, freshKey, post, putSave, startServer, validEvent, validSave } from './_helpers.js';

const ip = (n) => ({ 'X-Forwarded-For': `10.9.0.${n}` });

const validRecord = (over = {}) => ({
  build: 'b42', play: 4000, deaths: 3, pct: 25, badges: 4, rank: 1, days: 2,
  splits: { ashore: 20, 'plain-flame': 200, stag: 600 }, bosses: { stag: 95 },
  ...over,
});

function putRecord(url, key, body, headers = {}) {
  return fetch(`${url}/v1/record`, {
    method: 'PUT',
    headers: { ...(key ? auth(key) : {}), 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const getRecord = (url, key, headers = {}) => fetch(`${url}/v1/record`, { headers: { ...(key ? auth(key) : {}), ...headers } });
const getBoard = (url, query, key, headers = {}) =>
  fetch(`${url}/v1/board?${query}`, { headers: { ...(key ? auth(key) : {}), ...headers } });

/** A fresh key with a save behind it. */
async function player(s, headers = {}) {
  const key = freshKey();
  const res = await putSave(s.url, key, validSave(), headers);
  assert.equal(res.status, 200);
  return key;
}

let nameCounter = 0;
const uname = (prefix = 'Keeper') => `${prefix}${++nameCounter}`;

describe('records: keys, saves and the basic round trip', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('missing or malformed key is 401 bad_key on PUT and GET', async () => {
    for (const key of [null, 'SHORT', 'IIII-IIII-IIII']) {
      const put = await putRecord(s.url, key, validRecord());
      assert.equal(put.status, 401);
      assert.deepEqual(await put.json(), { error: 'bad_key' });
      const get = await getRecord(s.url, key);
      assert.equal(get.status, 401);
    }
  });

  test('the key is checked before the body', async () => {
    assert.equal((await putRecord(s.url, null, 'not json')).status, 401);
  });

  test('a record for a code with no save is 404 no_save and stores nothing', async () => {
    const res = await putRecord(s.url, freshKey(), validRecord({ name: uname() }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'no_save' });
    assert.equal(s.store._records.size, 0);
  });

  test('PUT 200 {ok, name}; GET returns the record; GET for a code without one is 404 no_record', async () => {
    const key = await player(s);
    const miss = await getRecord(s.url, key);
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { error: 'no_record' });

    const name = uname();
    const res = await putRecord(s.url, key, validRecord({ name, crew: 'abcd12', splits: { ashore: 20, gloaming: 900 } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, name });
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const got = await getRecord(s.url, key.toLowerCase());
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(typeof body.at, 'number');
    delete body.at;
    assert.deepEqual(body, {
      name, crew: 'ABCD12', build: 'b42', play: 4000, deaths: 3, pct: 25, badges: 4, rank: 1, days: 2,
      act1: 900, full: null, fullDeaths: null, splits: { ashore: 20, gloaming: 900 }, bosses: { stag: 95 },
    });
    // Stored under sha256 of the normalised key, never the key.
    const id = createHash('sha256').update(key.replace(/-/g, '')).digest('hex');
    assert.ok(s.store._records.has(id));
  });

  test('text/plain bodies are accepted (no preflight needed)', async () => {
    const key = await player(s);
    assert.equal((await putRecord(s.url, key, validRecord(), { 'Content-Type': 'text/plain' })).status, 200);
  });

  test('a body over 32 KB is 413', async () => {
    const key = await player(s);
    const res = await putRecord(s.url, key, validRecord({ pad: 'x'.repeat(33 * 1024) }));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too_large' });
  });

  test('wrong methods are 405', async () => {
    for (const [method, path] of [['DELETE', '/v1/record'], ['POST', '/v1/record'], ['POST', '/v1/board'], ['PUT', '/v1/board']]) {
      const res = await fetch(`${s.url}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
    }
    assert.equal((await fetch(`${s.url}/v1/board`, { method: 'DELETE' })).headers.get('allow'), 'GET, OPTIONS');
    assert.equal((await fetch(`${s.url}/v1/record`, { method: 'DELETE' })).headers.get('allow'), 'GET, PUT, OPTIONS');
  });
});

describe('records: names', () => {
  let s;
  before(async () => { s = await startServer({ config: { limits: { events: { max: 10_000 } } } }); });
  after(() => s.close());

  test('cleanName trims, squeezes spaces, keeps case, and keys on lower case', () => {
    assert.deepEqual(cleanName('  Sea   Wolf  '), { name: 'Sea Wolf', key: 'sea wolf' });
    assert.deepEqual(cleanName('Sea\tWolf'), { name: 'Sea Wolf', key: 'sea wolf' });
    assert.deepEqual(cleanName('O’Brien'), { name: "O'Brien", key: "o'brien" });
    assert.deepEqual(cleanName("a_b-c'd 9"), { name: "a_b-c'd 9", key: "a_b-c'd 9" });
    assert.deepEqual(cleanName('   '), { name: '', key: '' });
    assert.deepEqual(cleanName(''), { name: '', key: '' });
  });

  test('length is 3 to 16 after cleaning', () => {
    assert.equal(cleanName('ab'), null);
    assert.equal(cleanName('  ab  '), null);
    assert.equal(cleanName('a  b').name, 'a b');
    assert.equal(cleanName('abc').name, 'abc');
    assert.equal(cleanName('a'.repeat(16)).name, 'a'.repeat(16));
    assert.equal(cleanName('a'.repeat(17)), null);
    assert.equal(cleanName(' ' + 'a'.repeat(16) + ' ').name, 'a'.repeat(16));
  });

  test('only letters, digits, space, _ - \' and at least one letter or digit', () => {
    for (const bad of ['Bob!', 'Bøb', 'B.o.b', 'bob@x', 'b🗼b', '<b>x', "---", "_ '", 'tab\u0000x', 'Zoë']) {
      assert.equal(cleanName(bad), null, bad);
    }
    assert.equal(cleanName(123), null);
  });

  test('blocked words match through case, spacing and digit swaps', () => {
    for (const bad of ['Fuck', 'F u c k', 'f_u-c_k', 'FUUUCK', 'sh1t', '5H1T', 'b1tch', 'B!tch', 'Nazi99', 'xXshitXx', 'a55hole']) {
      assert.ok(isBlockedName(bad), bad);
    }
    for (const ok of ['Cassandra', 'Hesper', 'Keeper of Light', 'Glass House', 'Rowan', 'Ashore']) {
      assert.ok(!isBlockedName(ok), ok);
    }
    assert.ok(normalisedForms('B1g 5hip').includes('bigship'));
    // Known false positives of squeezing repeated letters (accepted: the player picks another name).
    assert.ok(isBlockedName('Shiitake'));
  });

  test('bad names are 400 name_invalid and store nothing', async () => {
    const key = await player(s);
    for (const name of ['ab', 'a'.repeat(17), 'Bob!', 'F u c k', 5, true, {}]) {
      const res = await putRecord(s.url, key, validRecord({ name }));
      assert.equal(res.status, 400, JSON.stringify(name));
      assert.deepEqual(await res.json(), { error: 'name_invalid' });
    }
    assert.equal(s.store._records.size, 0);
  });

  test('the stored name is the cleaned one', async () => {
    const key = await player(s);
    const res = await putRecord(s.url, key, validRecord({ name: '  Tide   Turner ' }));
    assert.deepEqual(await res.json(), { ok: true, name: 'Tide Turner' });
  });

  test('names are unique case-insensitively: 409 name_taken, nothing written', async () => {
    const a = await player(s);
    const b = await player(s);
    assert.equal((await putRecord(s.url, a, validRecord({ name: 'Moth Queen' }))).status, 200);
    for (const name of ['moth queen', 'MOTH QUEEN', '  Moth   Queen ']) {
      const res = await putRecord(s.url, b, validRecord({ name, play: 777 }));
      assert.equal(res.status, 409, name);
      assert.deepEqual(await res.json(), { error: 'name_taken' });
    }
    assert.equal((await getRecord(s.url, b)).status, 404);
    // The owner can re-send it, or change its case.
    assert.deepEqual(await (await putRecord(s.url, a, validRecord({ name: 'MOTH queen' }))).json(), { ok: true, name: 'MOTH queen' });
  });

  test('omitting name (or null) keeps it; "" takes the player off the boards and frees the name', async () => {
    const a = await player(s);
    const b = await player(s);
    const name = uname('Lamp');
    await putRecord(s.url, a, validRecord({ name, splits: { gloaming: 800 } }));
    assert.deepEqual(await (await putRecord(s.url, a, validRecord({ splits: { gloaming: 800 } }))).json(), { ok: true, name });
    assert.deepEqual(await (await putRecord(s.url, a, validRecord({ name: null, splits: { gloaming: 800 } }))).json(), { ok: true, name });
    const crew = 'NAMES1';
    await putRecord(s.url, a, validRecord({ crew, splits: { gloaming: 800 } }));
    let board = await (await getBoard(s.url, `b=act1&crew=${crew}`)).json();
    assert.deepEqual(board.rows.map((r) => r.name), [name]);

    assert.deepEqual(await (await putRecord(s.url, a, validRecord({ name: '', splits: { gloaming: 800 } }))).json(), { ok: true, name: '' });
    board = await (await getBoard(s.url, `b=act1&crew=${crew}`, a)).json();
    assert.deepEqual(board.rows, []);
    assert.deepEqual(board.you, { pos: null, value: 800 });
    // Someone else may now take the name.
    assert.equal((await putRecord(s.url, b, validRecord({ name }))).status, 200);
  });
});

describe('records: crew codes', () => {
  let s;
  before(async () => { s = await startServer({ config: { limits: { events: { max: 10_000 } } } }); });
  after(() => s.close());

  test('cleanCrew', () => {
    assert.equal(cleanCrew(' abcd '), 'ABCD');
    assert.equal(cleanCrew('a1b2c3d4e5f6'), 'A1B2C3D4E5F6');
    assert.equal(cleanCrew(''), '');
    for (const bad of ['abc', 'a1b2c3d4e5f6g', 'ab-cd', 'ab cd', 'ÄBCD', 5]) assert.equal(cleanCrew(bad), null, String(bad));
  });

  test('bad crew is 400 bad_request; "" leaves the crew; omitted keeps it', async () => {
    const key = await player(s);
    for (const crew of ['abc', 'x'.repeat(13), 'ab-cd', 7]) {
      const res = await putRecord(s.url, key, validRecord({ crew }));
      assert.equal(res.status, 400, String(crew));
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    await putRecord(s.url, key, validRecord({ crew: 'shore7' }));
    assert.equal((await (await getRecord(s.url, key)).json()).crew, 'SHORE7');
    await putRecord(s.url, key, validRecord());
    assert.equal((await (await getRecord(s.url, key)).json()).crew, 'SHORE7');
    await putRecord(s.url, key, validRecord({ crew: '' }));
    assert.equal((await (await getRecord(s.url, key)).json()).crew, '');
  });
});

describe('records: validation', () => {
  let s;
  before(async () => { s = await startServer({ config: { limits: { events: { max: 10_000 } } } }); });
  after(() => s.close());

  test('bad bodies are 400 bad_request and store nothing', async () => {
    const key = await player(s);
    const bad = [
      '', 'not json', '[]', 'null', '{}',
      validRecord({ build: undefined }), validRecord({ build: 5 }), validRecord({ build: 'b'.repeat(41) }),
      validRecord({ build: 'nul\u0000' }),
      validRecord({ play: -1 }), validRecord({ play: 1.5 }), validRecord({ play: '100' }), validRecord({ play: 50_000_001 }),
      validRecord({ deaths: -1 }), validRecord({ deaths: undefined }),
      validRecord({ pct: 101 }), validRecord({ pct: -1 }),
      validRecord({ badges: 1001 }), validRecord({ rank: 21 }), validRecord({ days: 10_001 }), validRecord({ days: null }),
      validRecord({ splits: undefined }), validRecord({ splits: [] }), validRecord({ splits: null }),
      validRecord({ splits: { nowhere: 10 } }), validRecord({ splits: { ashore: -1 } }), validRecord({ splits: { ashore: 1.5 } }),
      validRecord({ splits: { ashore: '10' } }),
      validRecord({ splits: { ashore: 4001 } }), // after the reported play time
      validRecord({ bosses: undefined }), validRecord({ bosses: [] }),
      validRecord({ bosses: { lantern: 50 } }), validRecord({ bosses: { stag: '50' } }), validRecord({ bosses: { stag: 50.5 } }),
    ];
    for (const body of bad) {
      const res = await putRecord(s.url, key, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 100));
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    assert.equal(s.store._records.size, 0);
  });

  test('every milestone and boss id is accepted; extra fields are ignored', async () => {
    const key = await player(s);
    const splits = {};
    ['ashore', 'plain-flame', 'stag', 'lantern', 'staff', 'lamp-cured', 'gloaming', 'undertow', 'crane', 'answer', 'sailed', 'giant']
      .forEach((id, i) => { splits[id] = 300 + i * 100; });
    const bosses = { stag: 10, gloaming: 20, undertow: 30, crane: 40, answer: 50, giant: 60 };
    const res = await putRecord(s.url, key, validRecord({ splits, bosses, extra: 'ignored', act1: 1, full: 1 }));
    assert.equal(res.status, 200);
    const got = await (await getRecord(s.url, key)).json();
    assert.equal(got.act1, 900);
    assert.equal(got.full, 1400);
    assert.deepEqual(got.bosses, bosses);
    assert.equal(got.extra, undefined);
  });

  test('a split cannot come before a milestone the story puts ahead of it; null (time unknown) is skipped', async () => {
    const key = await player(s);
    const dec = await putRecord(s.url, key, validRecord({ splits: { ashore: 100, 'plain-flame': 99 } }));
    assert.equal(dec.status, 400);
    // Order of the object keys does not matter, only story order.
    assert.equal((await putRecord(s.url, key, validRecord({ splits: { stag: 600, ashore: 20 } }))).status, 200);
    assert.equal((await putRecord(s.url, key, validRecord({ splits: { stag: 20, ashore: 600 } }))).status, 400);
    // Equal is fine.
    assert.equal((await putRecord(s.url, key, validRecord({ splits: { ashore: 50, 'plain-flame': 50 } }))).status, 200);
    // Restored milestones have no time; they neither break the order nor set a best.
    const res = await putRecord(s.url, key, validRecord({ splits: { ashore: null, stag: 900, lantern: null, 'lamp-cured': 100 } }));
    assert.equal(res.status, 400); // the lamp (100) cannot be cured before the Stag (900), even with the lantern untimed
    const other = await player(s);
    // Where the story leaves the order open, either order is accepted.
    assert.equal((await putRecord(s.url, other, validRecord({ splits: { ashore: 10, staff: 100, 'plain-flame': 300, stag: 900 } }))).status, 200);
    assert.equal((await putRecord(s.url, other, validRecord({ splits: { ashore: 10, 'plain-flame': 100, staff: 300, stag: 200 } }))).status, 200);
    const late = { ashore: 10, stag: 200, lantern: 250, 'lamp-cured': 300, gloaming: 400 };
    assert.equal((await putRecord(s.url, other, validRecord({ splits: { ...late, answer: 500, crane: 600, undertow: 700 } }))).status, 200);
    assert.equal((await putRecord(s.url, other, validRecord({ splits: { ...late, answer: 399 } }))).status, 400);
    assert.equal((await putRecord(s.url, key, validRecord({ splits: { ashore: null, stag: 100, lantern: null, gloaming: null } }))).status, 200);
    const got = await (await getRecord(s.url, key)).json();
    assert.deepEqual(got.splits, { ashore: null, stag: 100, lantern: null, gloaming: null });
    assert.equal(got.act1, null);
  });

  test(`floors: act1 >= ${FLOORS.act1}s, full >= ${FLOORS.full}s, boss >= ${FLOORS.boss}s`, async () => {
    const key = await player(s);
    const cases = [
      [{ splits: { gloaming: FLOORS.act1 - 1 } }, 400],
      [{ splits: { gloaming: FLOORS.act1 } }, 200],
      [{ splits: { gloaming: 400, giant: FLOORS.full - 1 } }, 400],
      [{ splits: { gloaming: 400, giant: FLOORS.full } }, 200],
      [{ bosses: { crane: FLOORS.boss - 1 } }, 400],
      [{ bosses: { crane: FLOORS.boss } }, 200],
      [{ bosses: { crane: null } }, 200],
    ];
    for (const [over, status] of cases) {
      const res = await putRecord(s.url, key, validRecord(over));
      assert.equal(res.status, status, JSON.stringify(over));
      if (status === 400) assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    const got = await (await getRecord(s.url, key)).json();
    assert.equal(got.act1, FLOORS.act1);
    assert.equal(got.full, FLOORS.full);
    assert.equal(got.bosses.crane, FLOORS.boss);
  });

  test('best times only improve; slower uploads keep the stored best', async () => {
    const key = await player(s);
    await putRecord(s.url, key, validRecord({ deaths: 5, splits: { gloaming: 1000, giant: 3000 }, bosses: { stag: 50 } }));
    await putRecord(s.url, key, validRecord({ deaths: 9, splits: { gloaming: 2000, giant: 3900 }, bosses: { stag: 90, giant: 70 } }));
    let got = await (await getRecord(s.url, key)).json();
    assert.equal(got.act1, 1000);
    assert.equal(got.full, 3000);
    assert.equal(got.fullDeaths, 5);
    assert.equal(got.deaths, 9);
    assert.deepEqual(got.bosses, { stag: 50, giant: 70 });
    await putRecord(s.url, key, validRecord({ deaths: 1, splits: { gloaming: 900, giant: 2900 }, bosses: { stag: 40 } }));
    got = await (await getRecord(s.url, key)).json();
    assert.equal(got.act1, 900);
    assert.equal(got.full, 2900);
    assert.equal(got.fullDeaths, 1);
    assert.deepEqual(got.bosses, { stag: 40, giant: 70 });
  });
});

describe('boards', () => {
  let s;
  const crew = 'BOARD1';
  const keys = {};
  before(async () => {
    s = await startServer({ config: { limits: { events: { max: 10_000 }, boards: { max: 10_000 } } } });
    // Inserted in this order, so ties go to the earlier one.
    const people = [
      ['Alder', { pct: 60, play: 9000, deaths: 2, splits: { gloaming: 1000, giant: 5000 }, bosses: { stag: 40, giant: 300 } }],
      ['Birch', { pct: 90, play: 9500, deaths: 2, splits: { gloaming: 800, giant: 4000 }, bosses: { stag: 40 } }],
      ['Cedar', { pct: 60, play: 7000, deaths: 0, splits: { gloaming: 1000 }, bosses: { stag: 30 } }],
      ['Dogwood', { pct: 99, play: 8000, deaths: 7, splits: { gloaming: 1200, giant: 3500 } }],
      ['Elm', { pct: 10, play: 2000, deaths: 1, splits: { gloaming: 600 } }],
    ];
    for (const [name, over] of people) {
      keys[name] = await player(s);
      const res = await putRecord(s.url, keys[name], validRecord({ name: name + 'X', crew, bosses: {}, ...over }));
      assert.equal(res.status, 200);
    }
    // Someone in another crew, and someone in no crew.
    keys.Fir = await player(s);
    await putRecord(s.url, keys.Fir, validRecord({ name: 'FirX', crew: 'OTHER1', splits: { gloaming: 500 } }));
    keys.Gum = await player(s);
    await putRecord(s.url, keys.Gum, validRecord({ name: 'GumX', splits: { gloaming: 550 } }));
  });
  after(() => s.close());

  const board = async (query, key) => {
    const res = await getBoard(s.url, query, key);
    assert.equal(res.status, 200, query);
    return res.json();
  };
  const brief = (b) => b.rows.map((r) => [r.pos, r.name, r.value]);

  test('response shape: {b, crew, rows:[{pos,name,value,rank,badges,at}]}, no "you" without a key', async () => {
    const b = await board(`b=act1&crew=${crew}`);
    assert.deepEqual(Object.keys(b).sort(), ['b', 'crew', 'rows']);
    assert.equal(b.b, 'act1');
    assert.equal(b.crew, crew);
    assert.deepEqual(Object.keys(b.rows[0]).sort(), ['at', 'badges', 'name', 'pos', 'rank', 'value']);
    assert.equal(b.rows[0].rank, 1);
    assert.equal(b.rows[0].badges, 4);
    assert.equal(typeof b.rows[0].at, 'number');
  });

  test('act1: fastest first; equal times go to the earlier record', async () => {
    assert.deepEqual(brief(await board(`b=act1&crew=${crew}`)), [
      [1, 'ElmX', 600], [2, 'BirchX', 800], [3, 'AlderX', 1000], [4, 'CedarX', 1000], [5, 'DogwoodX', 1200],
    ]);
  });

  test('full: finished runs only, fastest first', async () => {
    assert.deepEqual(brief(await board(`b=full&crew=${crew}`)), [[1, 'DogwoodX', 3500], [2, 'BirchX', 4000], [3, 'AlderX', 5000]]);
  });

  test('deaths: finished runs only, fewest first, then the faster run', async () => {
    // Cedar has 0 deaths but never finished, so is not listed.
    assert.deepEqual(brief(await board(`b=deaths&crew=${crew}`)), [[1, 'BirchX', 2], [2, 'AlderX', 2], [3, 'DogwoodX', 7]]);
  });

  test('pct: highest first, then least play time', async () => {
    assert.deepEqual(brief(await board(`b=pct&crew=${crew}`)), [
      [1, 'DogwoodX', 99], [2, 'BirchX', 90], [3, 'CedarX', 60], [4, 'AlderX', 60], [5, 'ElmX', 10],
    ]);
  });

  test('boss boards: one per boss, ties to the earlier record', async () => {
    const b = await board(`b=boss:stag&crew=${crew}`);
    assert.equal(b.b, 'boss:stag');
    assert.deepEqual(brief(b), [[1, 'CedarX', 30], [2, 'AlderX', 40], [3, 'BirchX', 40]]);
    assert.deepEqual(brief(await board(`b=boss:giant&crew=${crew}`)), [[1, 'AlderX', 300]]);
    assert.deepEqual((await board(`b=boss:answer&crew=${crew}`)).rows, []);
  });

  test('without crew the board is everyone; crew is case-insensitive in the query', async () => {
    const all = await board('b=act1');
    assert.equal(all.crew, '');
    assert.deepEqual(all.rows.slice(0, 3).map((r) => r.name), ['FirX', 'GumX', 'ElmX']);
    assert.deepEqual(brief(await board('b=act1&crew=other1')), [[1, 'FirX', 500]]);
    assert.deepEqual((await board('b=act1&crew=NOBODY')).rows, []);
  });

  test('limit: default 25, 1..100', async () => {
    assert.deepEqual(brief(await board(`b=act1&crew=${crew}&limit=2`)), [[1, 'ElmX', 600], [2, 'BirchX', 800]]);
    assert.equal((await board('b=act1&limit=100')).rows.length, 7);
  });

  test('"you" with a Bearer code: inside the limit, outside it, unlisted, or null', async () => {
    let b = await board(`b=act1&crew=${crew}&limit=2`, keys.Birch);
    assert.deepEqual(b.you, { pos: 2, value: 800 });
    b = await board(`b=act1&crew=${crew}&limit=2`, keys.Dogwood);
    assert.deepEqual(b.you, { pos: 5, value: 1200 });
    assert.equal(b.rows.length, 2);
    // Not in this crew: value but no position.
    b = await board(`b=act1&crew=${crew}`, keys.Fir);
    assert.deepEqual(b.you, { pos: null, value: 500 });
    // No value on this board.
    b = await board(`b=full&crew=${crew}`, keys.Cedar);
    assert.equal(b.you, null);
    // Has a save but no record; and a code with nothing at all.
    assert.equal((await board('b=act1', await player(s))).you, null);
    assert.equal((await board('b=act1', freshKey())).you, null);
  });

  test('hidden rows are never listed and positions close up', async () => {
    const id = createHash('sha256').update(keys.Elm.replace(/-/g, '')).digest('hex');
    s.store._records.get(id).hidden = true;
    try {
      const b = await board(`b=act1&crew=${crew}`, keys.Elm);
      assert.deepEqual(brief(b).slice(0, 2), [[1, 'BirchX', 800], [2, 'AlderX', 1000]]);
      assert.ok(!b.rows.some((r) => r.name === 'ElmX'));
      assert.deepEqual(b.you, { pos: null, value: 600 });
      assert.ok(!(await board('b=pct&limit=100')).rows.some((r) => r.name === 'ElmX'));
    } finally {
      s.store._records.get(id).hidden = false;
    }
  });

  test('a bad Authorization header is 401 bad_key', async () => {
    const res = await getBoard(s.url, 'b=act1', 'NOT-A-KEY');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'bad_key' });
  });

  test('bad queries are 400 bad_request', async () => {
    for (const q of ['', 'b=', 'b=ACT1', 'b=speed', 'b=boss:', 'b=boss:lantern', 'b=boss:STAG', 'b=act1&crew=abc',
      'b=act1&crew=ab-cd', 'b=act1&limit=0', 'b=act1&limit=101', 'b=act1&limit=abc', 'b=act1&limit=-1', 'b=act1&limit=2.5']) {
      const res = await getBoard(s.url, q);
      assert.equal(res.status, 400, q);
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
  });
});

describe('records and boards: CORS, limits, logging', () => {
  const retryAfterOk = (res, maxSeconds) => {
    const v = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(v) && v >= 1 && v <= maxSeconds, `Retry-After was ${res.headers.get('retry-after')}`);
  };

  test('CORS: preflight on the new paths; other origins are 403', async () => {
    const s = await startServer();
    for (const path of ['/v1/record', '/v1/board']) {
      const res = await fetch(`${s.url}${path}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://nattyman.github.io', 'Access-Control-Request-Method': 'PUT' },
      });
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://nattyman.github.io');
      assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    }
    const o = { Origin: 'https://evil.example' };
    assert.equal((await getBoard(s.url, 'b=act1', null, o)).status, 403);
    assert.equal((await getRecord(s.url, freshKey(), o)).status, 403);
    assert.equal((await putRecord(s.url, freshKey(), validRecord(), o)).status, 403);
    const ok = await getBoard(s.url, 'b=act1', null, { Origin: 'https://html-classic.itch.zone' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://html-classic.itch.zone');
    await s.close();
  });

  test('PUT /v1/record shares the events budget', async () => {
    const s = await startServer({ config: { limits: { events: { max: 3 } } } });
    const key = await player(s, ip(1));
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 204);
    assert.equal((await putRecord(s.url, key, validRecord(), ip(1))).status, 200);
    assert.equal((await putRecord(s.url, key, validRecord(), ip(1))).status, 200);
    const res = await putRecord(s.url, key, validRecord(), ip(1));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
    retryAfterOk(res, 60);
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 429);
    assert.equal((await putRecord(s.url, key, validRecord(), ip(2))).status, 200);
    await s.close();
  });

  test('GET /v1/board and GET /v1/record share the boards budget; saves are unaffected', async () => {
    const s = await startServer({ config: { limits: { boards: { max: 3 } } } });
    const key = await player(s, ip(1));
    assert.equal((await getBoard(s.url, 'b=act1', null, ip(1))).status, 200);
    assert.equal((await getBoard(s.url, 'b=pct', key, ip(1))).status, 200);
    assert.equal((await getRecord(s.url, key, ip(1))).status, 404);
    const res = await getBoard(s.url, 'b=act1', null, ip(1));
    assert.equal(res.status, 429);
    retryAfterOk(res, 60);
    const rec = await getRecord(s.url, key, ip(1));
    assert.equal(rec.status, 429);
    // Bad queries count too (they are checked after the budget).
    assert.equal((await getBoard(s.url, 'b=nope', null, ip(1))).status, 429);
    assert.equal((await getBoard(s.url, 'b=act1', null, ip(2))).status, 200);
    assert.equal((await fetch(`${s.url}/v1/save`, { headers: { ...auth(key), ...ip(1) } })).status, 200);
    await s.close();
  });

  test('a GET /v1/record 404 does not use up the failed-lookup allowance, but a locked-out address is refused', async () => {
    const s = await startServer({ config: { limits: { failedLookups: { max: 2 } } } });
    const key = await player(s, ip(1));
    for (let i = 0; i < 5; i++) assert.equal((await getRecord(s.url, freshKey(), ip(1))).status, 404);
    assert.equal((await fetch(`${s.url}/v1/save`, { headers: { ...auth(key), ...ip(1) } })).status, 200);
    // Two failed save lookups lock the address out of both.
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${s.url}/v1/save`, { headers: { ...auth(freshKey()), ...ip(1) } })).status, 404);
    assert.equal((await getRecord(s.url, key, ip(1))).status, 429);
    await s.close();
  });

  test('logs carry no key, name, crew or query string', async () => {
    const s = await startServer();
    const key = await player(s);
    await putRecord(s.url, key, validRecord({ name: 'Logmarker', crew: 'CREWMARK' }));
    await getRecord(s.url, key);
    await getBoard(s.url, 'b=act1&crew=CREWMARK', key);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(s.logs.at(-3), /^PUT \/v1\/record 200 \d+ms$/);
    assert.match(s.logs.at(-2), /^GET \/v1\/record 200 \d+ms$/);
    assert.match(s.logs.at(-1), /^GET \/v1\/board 200 \d+ms$/);
    const all = s.logs.join('\n');
    for (const secret of [key, key.slice(0, 4), 'Logmarker', 'CREWMARK', 'b=act1']) assert.ok(!all.includes(secret), secret);
    await s.close();
  });

  test('a store failure on a record is a 500 with no detail', async () => {
    const s = await startServer({
      store: {
        putSave: async () => ({ status: 'ok', at: 1, created: true }),
        putRecord: async () => { throw new Error('secret detail'); },
      },
    });
    try {
      const res = await putRecord(s.url, freshKey(), validRecord());
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal' });
      assert.ok(!s.logs.join('\n').includes('secret detail'));
    } finally {
      await s.close();
    }
  });

  test('a store failure after a body has been read is a 500, not a dropped connection', async () => {
    const s = await startServer({ store: { putSave: async () => { throw new Error('secret detail'); } } });
    try {
      const res = await putSave(s.url, freshKey(), validSave());
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal' });
    } finally {
      await s.close();
    }
  });
});
