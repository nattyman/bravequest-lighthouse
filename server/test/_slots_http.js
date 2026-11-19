// Save slots, claims, and records and boards with an account, over HTTP. Run on the memory store by
// slots.test.js and on Postgres by pg_slots.test.js. Spec: ACCOUNTS.md (section 3).
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { randomBytes } from 'node:crypto';
import { cleanName } from '../src/records.js';
import { freshKey, validSave } from './_helpers.js';
import { GAME, ITCH, freshEmail, freshIp, sha256, startAccounts } from './_accounts.js';

/** A random keeper name that passes the name rules (a random one can hit a blocked word). */
const uniqueName = () => {
  for (;;) {
    const n = `K${randomBytes(5).toString('hex')}`.slice(0, 12);
    if (cleanName(n)) return n;
  }
};
const record = (over = {}) => ({
  build: 'b42', play: 4000, deaths: 3, pct: 25, badges: 4, rank: 1, days: 2,
  splits: { ashore: 20, stag: 600 }, bosses: { stag: 95 }, ...over,
});
const slotSave = (over = {}) => ({ at: 1000, objective: 'Light the lamp', save: '{"hp":3}', ...over });

/** @param makeStore () => a fresh initialised store, or null for the default memory store */
export function runSlotsHttp(label, makeStore = () => undefined) {
  const start = (opts = {}) => startAccounts({ ...opts, ...(makeStore() ? { store: makeStore() } : {}) });

  describe(`${label}: save slots`, () => {
    let s;
    before(async () => { s = await start(); });
    after(() => s.close());
    const bearer = (key) => ({ Authorization: `Bearer ${key}` });

    test('account only: signed out, guests and bad codes are 401 signed_out', async () => {
      const key = freshKey();
      const calls = [
        ['GET', '/v1/saves'], ['GET', '/v1/saves/1'], ['PUT', '/v1/saves/1', slotSave()], ['DELETE', '/v1/saves/1'],
        ['POST', '/v1/saves/1/rename', { name: 'A' }], ['POST', '/v1/saves/claim', { code: key }],
      ];
      for (const [method, path, body] of calls) {
        for (const headers of [{}, bearer(key), { Authorization: 'Bearer nope' }]) {
          const r = await s.api(path, { method, body, headers });
          assert.deepEqual([r.status, r.body], [401, { error: 'signed_out' }], `${method} ${path} ${JSON.stringify(headers)}`);
        }
      }
    });

    test('PUT, GET, list: shapes, default name, no body in the list', async () => {
      const { token } = await s.signIn(freshEmail());
      assert.deepEqual((await s.api('/v1/saves', { cookie: token })).body, { max: 10, slots: [] });
      assert.deepEqual((await s.api('/v1/saves/4', { cookie: token })).body, { error: 'no_save' });
      const put = await s.api('/v1/saves/4', {
        method: 'PUT', cookie: token, body: { v: 1, ...slotSave(), rec: { play: 120, pct: 3, rank: 'Lamplighter', ri: 1, extra: 'dropped' } },
      });
      assert.deepEqual([put.status, put.body], [200, { ok: true, at: 1000, test: false }]);
      assert.equal(put.headers.get('cache-control'), 'no-store');
      const one = await s.api('/v1/saves/4', { cookie: token });
      assert.deepEqual(one.body, {
        slot: 4, name: 'Save 4', test: false, at: 1000, objective: 'Light the lamp',
        rec: { play: 120, pct: 3, rank: 'Lamplighter', ri: 1 }, body: '{"hp":3}', updated: s.clock.t,
      });
      // `body` may stand for `save`, `v` may be left out, and a name may be given.
      await s.api('/v1/saves/2', { method: 'PUT', cookie: token, body: { at: 5, objective: '', body: 'two', name: '  My   run ' } });
      const list = await s.api('/v1/saves', { cookie: token });
      assert.deepEqual(list.body, {
        max: 10,
        slots: [
          { slot: 2, name: 'My run', test: false, at: 5, objective: '', rec: null, updated: s.clock.t },
          { slot: 4, name: 'Save 4', test: false, at: 1000, objective: 'Light the lamp', rec: { play: 120, pct: 3, rank: 'Lamplighter', ri: 1 }, updated: s.clock.t },
        ],
      });
      // Another account sees none of it.
      const other = await s.signIn(freshEmail());
      assert.deepEqual((await s.api('/v1/saves', { cookie: other.token })).body.slots, []);
      assert.equal((await s.api('/v1/saves/4', { cookie: other.token })).status, 404);
    });

    test('slots are 1..10: anything else is 400 bad_slot', async () => {
      const { token } = await s.signIn(freshEmail());
      for (const slot of ['0', '11', '01', '-1', '1.5', 'abc', '%20', '100']) {
        for (const [method, path, body] of [
          ['GET', `/v1/saves/${slot}`], ['PUT', `/v1/saves/${slot}`, slotSave()], ['DELETE', `/v1/saves/${slot}`],
          ['POST', `/v1/saves/${slot}/rename`, { name: 'x' }],
        ]) {
          const r = await s.api(path, { method, body, cookie: token });
          assert.deepEqual([r.status, r.body], [400, { error: 'bad_slot' }], `${method} ${path}`);
        }
      }
      for (const slot of [0, 11, '3', 2.5]) {
        const r = await s.api('/v1/saves/claim', { method: 'POST', cookie: token, body: { code: freshKey(), slot } });
        assert.deepEqual([r.status, r.body], [400, { error: 'bad_slot' }], String(slot));
      }
      for (let n = 1; n <= 10; n++) {
        assert.equal((await s.api(`/v1/saves/${n}`, { method: 'PUT', cookie: token, body: slotSave() })).status, 200, String(n));
      }
      assert.equal((await s.api('/v1/saves', { cookie: token })).body.slots.length, 10);
      const claimRoute = await s.api('/v1/saves/claim', { cookie: token });
      assert.equal(claimRoute.status, 405);
      assert.equal(claimRoute.headers.get('allow'), 'POST, OPTIONS');
      assert.equal((await s.api('/v1/saves/1/nope', { cookie: token })).status, 404);
    });

    test('newer wins, as PUT /v1/save: 409 {error:"stale", at} and nothing written', async () => {
      const { token } = await s.signIn(freshEmail());
      await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave({ at: 2000, save: 'first' }) });
      for (const at of [2000, 1999]) {
        const r = await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave({ at, save: 'older', test: true, name: 'Zz' }) });
        assert.deepEqual([r.status, r.body], [409, { error: 'stale', at: 2000 }]);
      }
      const g = (await s.api('/v1/saves/1', { cookie: token })).body;
      assert.deepEqual([g.body, g.test, g.name], ['first', false, 'Save 1']);
      const ok = await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave({ at: 2001, save: 'newer' }) });
      assert.deepEqual(ok.body, { ok: true, at: 2001, test: false });
    });

    test('the same body checks and size limit as /v1/save', async () => {
      const { token } = await s.signIn(freshEmail());
      const bad = [
        'not json', { objective: '', save: 'x' }, slotSave({ at: 0 }), slotSave({ at: 1.5 }), slotSave({ at: Date.now() + 2 * 86_400_000 }),
        slotSave({ save: '' }), slotSave({ save: 5 }), slotSave({ v: 2 }), slotSave({ objective: 3 }), slotSave({ save: 'a\u0000b' }),
        slotSave({ name: '' }), slotSave({ name: 'x'.repeat(25) }), slotSave({ name: 'a\u0007b' }), slotSave({ name: 7 }),
        slotSave({ rec: [] }), slotSave({ rec: 'x' }), slotSave({ rec: { play: {} } }), slotSave({ rec: { rank: 'x'.repeat(41) } }),
        slotSave({ test: 'yes' }),
      ];
      for (const body of bad) {
        const r = await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body });
        assert.deepEqual([r.status, r.body], [400, { error: 'bad_request' }], JSON.stringify(body).slice(0, 80));
      }
      const big = await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave({ save: 'x'.repeat(310 * 1024) }) });
      assert.equal(big.status, 413);
      assert.equal((await s.api('/v1/saves', { cookie: token })).body.slots.length, 0);
      // Long objectives are cut, as for guests.
      await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave({ objective: 'o'.repeat(300) }) });
      assert.equal((await s.api('/v1/saves/1', { cookie: token })).body.objective.length, 120);
    });

    test('test is sticky until the slot is deleted', async () => {
      const { token } = await s.signIn(freshEmail());
      assert.equal((await s.api('/v1/saves/3', { method: 'PUT', cookie: token, body: slotSave({ at: 1, test: true }) })).body.test, true);
      let at = 1;
      for (const test of [false, undefined, null]) {
        const r = await s.api('/v1/saves/3', { method: 'PUT', cookie: token, body: slotSave({ at: ++at, test }) });
        assert.equal(r.body.test, true);
      }
      assert.equal((await s.api('/v1/saves', { cookie: token })).body.slots[0].test, true);
      assert.deepEqual((await s.api('/v1/saves/3', { method: 'DELETE', cookie: token })).body, { ok: true });
      assert.equal((await s.api('/v1/saves/3', { method: 'PUT', cookie: token, body: slotSave({ at: 1 }) })).body.test, false);
    });

    test('rename: 1..24 characters after trimming; 404 for an empty slot; delete is 200 even when empty', async () => {
      const { token } = await s.signIn(freshEmail());
      assert.deepEqual((await s.api('/v1/saves/5/rename', { method: 'POST', cookie: token, body: { name: 'Nope' } })).body, { error: 'no_save' });
      await s.api('/v1/saves/5', { method: 'PUT', cookie: token, body: slotSave() });
      for (const name of ['', '   ', 'x'.repeat(25), 'a\u0007b', 5, null]) {
        const r = await s.api('/v1/saves/5/rename', { method: 'POST', cookie: token, body: { name } });
        assert.deepEqual([r.status, r.body], [400, { error: 'bad_request' }], String(name));
      }
      assert.deepEqual((await s.api('/v1/saves/5/rename', { method: 'POST', cookie: token, body: { name: `  ${'y'.repeat(24)}  ` } })).body, { ok: true });
      assert.equal((await s.api('/v1/saves/5', { cookie: token })).body.name, 'y'.repeat(24));
      assert.deepEqual((await s.api('/v1/saves/5/rename', { method: 'POST', cookie: token, body: { name: 'Ü' } })).body, { ok: true });
      // A later save keeps the name.
      await s.api('/v1/saves/5', { method: 'PUT', cookie: token, body: slotSave({ at: 5000 }) });
      assert.equal((await s.api('/v1/saves/5', { cookie: token })).body.name, 'Ü');
      assert.deepEqual((await s.api('/v1/saves/5', { method: 'DELETE', cookie: token })).body, { ok: true });
      assert.deepEqual((await s.api('/v1/saves/5', { method: 'DELETE', cookie: token })).body, { ok: true });
      assert.equal((await s.api('/v1/saves/5', { cookie: token })).status, 404);
    });

    test('writes need X-BQ-Client and an exactly-listed Origin; reads do not; disabled accounts are refused', async () => {
      const { token, id } = await s.signIn(freshEmail());
      for (const c of [{ client: false }, { origin: null }, { origin: ITCH }]) {
        for (const [method, path, body] of [
          ['PUT', '/v1/saves/1', slotSave()], ['DELETE', '/v1/saves/1'], ['POST', '/v1/saves/1/rename', { name: 'a' }],
          ['POST', '/v1/saves/claim', { code: freshKey() }],
        ]) {
          const r = await s.api(path, { method, body, cookie: token, ...c });
          assert.deepEqual([r.status, r.body], [403, { error: 'bad_origin' }], `${method} ${path} ${JSON.stringify(c)}`);
        }
      }
      assert.equal((await s.api('/v1/saves', { cookie: token, client: false, origin: null })).status, 200);
      await s.store.accounts.update(id, { status: 'disabled' });
      assert.deepEqual((await s.api('/v1/saves', { cookie: token })).body, { error: 'disabled' });
    });

    test('credentialed CORS on the slot routes for exact origins only', async () => {
      const { token } = await s.signIn(freshEmail());
      const get = await s.api('/v1/saves', { cookie: token });
      assert.equal(get.headers.get('access-control-allow-origin'), GAME);
      assert.equal(get.headers.get('access-control-allow-credentials'), 'true');
      for (const path of ['/v1/saves', '/v1/saves/3', '/v1/saves/3/rename', '/v1/saves/claim']) {
        const pre = await s.api(path, {
          method: 'OPTIONS', client: false,
          headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type, x-bq-client' },
        });
        assert.equal(pre.status, 204, path);
        assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
        assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, PUT, POST, DELETE, OPTIONS');
        assert.match(pre.headers.get('access-control-allow-headers'), /X-BQ-Client/);
        const wild = await s.api(path, { method: 'OPTIONS', client: false, origin: ITCH });
        assert.equal(wild.headers.get('access-control-allow-credentials'), null);
      }
    });
  });

  describe(`${label}: claim`, () => {
    let s;
    before(async () => { s = await start(); });
    after(() => s.close());
    const guestPut = (key, body, ip) => s.api('/v1/save', { method: 'PUT', body, headers: { Authorization: `Bearer ${key}` }, ip });
    const guestRecord = (key, body) => s.api('/v1/record', { method: 'PUT', body, headers: { Authorization: `Bearer ${key}` } });
    const claim = (token, body, ip) => s.api('/v1/saves/claim', { method: 'POST', cookie: token, body, ip });

    async function guestWith({ name, rec = {} } = {}) {
      const key = freshKey();
      assert.equal((await guestPut(key, validSave({ at: 4242, save: `guest ${key}` }))).status, 200);
      if (name !== undefined || Object.keys(rec).length) {
        // Guests cannot set new names while accounts are on, so a named guest is seeded as an older one would be.
        if (name !== undefined) {
          const id = sha256(key.replace(/-/g, ''));
          const r = await s.store.putRecord(id, { name, nameKey: name.toLowerCase(), crew: undefined, build: 'b', play: 1, deaths: 0, pct: 0, badges: 0, rank: 0, days: 0, act1: null, full: null, fullDeaths: null, splits: {}, bosses: {} });
          assert.equal(r.status, 'ok');
        }
        if (Object.keys(rec).length) assert.equal((await guestRecord(key, record(rec))).status, 200);
      }
      return key;
    }

    test('into the first free slot, or a chosen one; the code is retired', async () => {
      const { token } = await s.signIn(freshEmail());
      await s.api('/v1/saves/1', { method: 'PUT', cookie: token, body: slotSave() });
      const key = await guestWith();
      const r = await claim(token, { code: key.toLowerCase() });
      assert.deepEqual([r.status, r.body], [200, { ok: true, slot: 2, name: '' }]);
      const got = (await s.api('/v1/saves/2', { cookie: token })).body;
      assert.deepEqual([got.at, got.body, got.name, got.test, got.objective], [4242, `guest ${key}`, 'Save 2', false, 'Light the lamp']);
      // The guest's save is gone; claiming twice is 404 no_save.
      assert.equal((await s.api('/v1/save', { headers: { Authorization: `Bearer ${key}` } })).status, 404);
      assert.deepEqual((await claim(token, { code: key })).body, { error: 'no_save' });
      const key2 = await guestWith();
      assert.deepEqual((await claim(token, { code: key2, slot: 9 })).body, { ok: true, slot: 9, name: '' });
    });

    test('slot_taken, full, unknown code, bad code', async () => {
      const { token } = await s.signIn(freshEmail());
      await s.api('/v1/saves/3', { method: 'PUT', cookie: token, body: slotSave() });
      const key = await guestWith();
      assert.deepEqual([(await claim(token, { code: key, slot: 3 })).status, (await claim(token, { code: key, slot: 3 })).body], [409, { error: 'slot_taken' }]);
      for (let n = 1; n <= 10; n++) await s.api(`/v1/saves/${n}`, { method: 'PUT', cookie: token, body: slotSave({ at: 5000 + n }) });
      const full = await claim(token, { code: key });
      assert.deepEqual([full.status, full.body], [409, { error: 'full' }]);
      // Nothing was taken from the guest.
      assert.equal((await s.api('/v1/save', { headers: { Authorization: `Bearer ${key}` } })).status, 200);
      const unknown = await claim(token, { code: freshKey() });
      assert.deepEqual([unknown.status, unknown.body], [404, { error: 'no_save' }]);
      for (const code of [undefined, '', 'SHORT', 'IIII-IIII-IIII', 12345]) {
        const r = await claim(token, { code });
        assert.deepEqual([r.status, r.body], [401, { error: 'bad_key' }], String(code));
      }
      assert.deepEqual((await claim(token, 'nope')).body, { error: 'bad_request' });
    });

    test('the record merges (better times kept), the name moves only when the account has none', async () => {
      const a = await s.signIn(freshEmail());
      const gname = uniqueName();
      const key = await guestWith({ name: gname, rec: { play: 5000, splits: { ashore: 20, stag: 600, gloaming: 2000 }, bosses: { stag: 50, gloaming: 300 } } });
      assert.deepEqual((await claim(a.token, { code: key })).body, { ok: true, slot: 1, name: gname });
      assert.equal((await s.api('/v1/me', { cookie: a.token })).body.name, gname);
      let r = (await s.api('/v1/record', { cookie: a.token })).body;
      assert.deepEqual([r.name, r.act1, r.bosses], [gname, 2000, { stag: 50, gloaming: 300 }]);
      // The guest's record is gone; the board lists the account under that name.
      assert.equal((await s.api('/v1/record', { headers: { Authorization: `Bearer ${key}` } })).status, 404);
      const board = await s.api('/v1/board?b=act1&limit=100', { cookie: a.token });
      assert.ok(board.body.rows.some((x) => x.name === gname));
      assert.deepEqual(board.body.you.value, 2000);

      // A second guest, faster at Act 1 but slower at the stag, with its own name: the account keeps its name.
      const other = uniqueName();
      const key2 = await guestWith({ name: other, rec: { play: 6000, splits: { ashore: 20, stag: 600, gloaming: 1500 }, bosses: { stag: 70 } } });
      assert.deepEqual((await claim(a.token, { code: key2 })).body, { ok: true, slot: 2, name: gname });
      r = (await s.api('/v1/record', { cookie: a.token })).body;
      assert.deepEqual([r.name, r.act1, r.bosses, r.play], [gname, 1500, { stag: 50, gloaming: 300 }, 6000]);
      // The second guest's name was freed.
      const b = await s.signIn(freshEmail());
      assert.equal((await s.api('/v1/me', { method: 'PUT', cookie: b.token, body: { name: other } })).status, 200);
    });

    test('a guest name already held elsewhere is not carried (the claim still succeeds)', async () => {
      const a = await s.signIn(freshEmail());
      const gname = uniqueName();
      const key = await guestWith({ name: gname });
      // Stage a clash the API never allows: another account holding the same name.
      const b = await s.signIn(freshEmail());
      if (s.store.kind === 'memory') Object.assign(s.store._mem.accounts.get(b.id), { displayName: gname, nameKey: gname.toLowerCase() });
      else await s.store._pool.query('UPDATE accounts SET display_name = $2, name_key = $3 WHERE id = $1::uuid', [b.id, gname, gname.toLowerCase()]);
      assert.deepEqual((await claim(a.token, { code: key })).body, { ok: true, slot: 1, name: '' });
      assert.equal((await s.api('/v1/me', { cookie: a.token })).body.name, '');
    });

    test('claim then delete the account: nothing of the guest or the account is left', async () => {
      const a = await s.signIn(freshEmail());
      const gname = uniqueName();
      const key = await guestWith({ name: gname, rec: { play: 4100 } });
      const guestId = sha256(key.replace(/-/g, ''));
      assert.equal((await claim(a.token, { code: key })).status, 200);
      assert.equal((await s.api('/v1/me', { method: 'DELETE', cookie: a.token })).status, 200);
      assert.equal(await s.store.getSave(guestId), null);
      assert.equal(await s.store.getRecord(guestId), null);
      assert.equal(await s.store.getRecord(`a:${a.id}`), null);
      assert.equal(await s.store.slots.count(a.id), 0);
      const b = await s.signIn(freshEmail());
      assert.equal((await s.api('/v1/me', { method: 'PUT', cookie: b.token, body: { name: gname } })).status, 200);
    });

    test('claims cannot be used to guess codes: failures count with the guest save lookups', async () => {
      const t = await start({ config: { limits: { failedLookups: { max: 3, windowMs: 3_600_000 } } } });
      try {
        const { token } = await t.signIn(freshEmail());
        const ip = freshIp();
        const c = (code) => t.api('/v1/saves/claim', { method: 'POST', cookie: token, body: { code }, ip });
        for (let i = 0; i < 3; i++) assert.equal((await c(freshKey())).status, 404);
        const locked = await c(freshKey());
        assert.equal(locked.status, 429);
        assert.ok(Number(locked.headers.get('retry-after')) > 0);
        // The same address is locked out of guest save lookups too.
        assert.equal((await t.api('/v1/save', { headers: { Authorization: `Bearer ${freshKey()}` }, ip })).status, 429);
      } finally {
        await t.close();
      }
      const u = await start({ accounts: { limits: { claimsPerAccount: { max: 2, windowMs: 3_600_000 } } } });
      try {
        const { token } = await u.signIn(freshEmail());
        for (let i = 0; i < 2; i++) assert.equal((await u.api('/v1/saves/claim', { method: 'POST', cookie: token, body: { code: freshKey() } })).status, 404);
        assert.equal((await u.api('/v1/saves/claim', { method: 'POST', cookie: token, body: { code: freshKey() } })).status, 429);
      } finally {
        await u.close();
      }
    });
  });

  describe(`${label}: records and boards with an account`, () => {
    let s;
    before(async () => { s = await start(); });
    after(() => s.close());
    const putRec = (token, body, headers) => s.api('/v1/record', { method: 'PUT', cookie: token, body, headers });

    test('needs a non-test slot, not a guest save; id a:<account>; GET /v1/record reads it', async () => {
      const a = await s.signIn(freshEmail());
      assert.deepEqual((await s.api('/v1/record', { cookie: a.token })).body, { error: 'no_record' });
      assert.deepEqual((await putRec(a.token, record())).body, { error: 'no_save' });
      await s.api('/v1/saves/1', { method: 'PUT', cookie: a.token, body: slotSave({ test: true }) });
      const testOnly = await putRec(a.token, record());
      assert.deepEqual([testOnly.status, testOnly.body], [404, { error: 'no_save' }]);
      await s.api('/v1/saves/2', { method: 'PUT', cookie: a.token, body: slotSave() });
      const ok = await putRec(a.token, record());
      assert.deepEqual([ok.status, ok.body], [200, { ok: true, name: '' }]);
      assert.ok(await s.store.getRecord(`a:${a.id}`));
      const got = await s.api('/v1/record', { cookie: a.token });
      assert.deepEqual([got.status, got.body.play, got.body.bosses], [200, 4000, { stag: 95 }]);
      // Bests only improve, as for guests.
      await putRec(a.token, record({ bosses: { stag: 120 } }));
      assert.deepEqual((await s.api('/v1/record', { cookie: a.token })).body.bosses, { stag: 95 });
    });

    test('test:true is refused; cookie writes need the client check', async () => {
      const a = await s.signIn(freshEmail());
      await s.api('/v1/saves/1', { method: 'PUT', cookie: a.token, body: slotSave() });
      assert.deepEqual((await putRec(a.token, record({ test: true }))).body, { error: 'bad_request' });
      assert.equal(await s.store.getRecord(`a:${a.id}`), null);
      const r = await s.api('/v1/record', { method: 'PUT', cookie: a.token, body: record(), client: false });
      assert.deepEqual([r.status, r.body], [403, { error: 'bad_origin' }]);
    });

    test('name in the body is the keeper name (the PUT /v1/me path): they never disagree', async () => {
      const a = await s.signIn(freshEmail());
      await s.api('/v1/saves/1', { method: 'PUT', cookie: a.token, body: slotSave() });
      const n = uniqueName();
      assert.deepEqual((await putRec(a.token, record({ name: n }))).body, { ok: true, name: n });
      assert.equal((await s.api('/v1/me', { cookie: a.token })).body.name, n);
      assert.equal((await s.api('/v1/record', { cookie: a.token })).body.name, n);
      // Changed through /v1/me: the record follows.
      const n2 = uniqueName();
      await s.api('/v1/me', { method: 'PUT', cookie: a.token, body: { name: n2 } });
      assert.equal((await s.api('/v1/record', { cookie: a.token })).body.name, n2);
      // Taken by another account: 409 and nothing written.
      const b = await s.signIn(freshEmail());
      await s.api('/v1/saves/1', { method: 'PUT', cookie: b.token, body: slotSave() });
      const clash = await putRec(b.token, record({ name: n2.toUpperCase(), play: 9999 }));
      assert.deepEqual([clash.status, clash.body], [409, { error: 'name_taken' }]);
      assert.equal(await s.store.getRecord(`a:${b.id}`), null);
      assert.deepEqual((await putRec(b.token, record({ name: 'ab' }))).body, { error: 'name_invalid' });
      // '' clears both.
      assert.deepEqual((await putRec(a.token, record({ name: '' }))).body, { ok: true, name: '' });
      assert.equal((await s.api('/v1/me', { cookie: a.token })).body.name, '');
    });

    test('an account that already has a name gets it on its first record; the board lists it with you', async () => {
      const a = await s.signIn(freshEmail());
      const n = uniqueName();
      await s.api('/v1/me', { method: 'PUT', cookie: a.token, body: { name: n } });
      await s.api('/v1/saves/1', { method: 'PUT', cookie: a.token, body: slotSave() });
      assert.deepEqual((await putRec(a.token, record({ bosses: { stag: 11 } }))).body, { ok: true, name: n });
      const board = await s.api('/v1/board?b=boss:stag&limit=100', { cookie: a.token });
      assert.equal(board.status, 200);
      const row = board.body.rows.find((x) => x.name === n);
      assert.ok(row);
      assert.deepEqual(board.body.you, { pos: row.pos, value: 11 });
      // Signed out: no you. A cookie and a Bearer code: the account wins.
      assert.equal('you' in (await s.api('/v1/board?b=boss:stag')).body, false);
      const both = await s.api('/v1/board?b=boss:stag&limit=100', { cookie: a.token, headers: { Authorization: `Bearer ${freshKey()}` } });
      assert.deepEqual(both.body.you, { pos: row.pos, value: 11 });
      const guest = await s.api('/v1/board?b=boss:stag', { headers: { Authorization: `Bearer ${freshKey()}` } });
      assert.equal(guest.body.you, null);
    });

    test('guests: no new names (403 account_needed); a guest with a name keeps it, re-sends it, may clear it', async () => {
      const key = freshKey();
      const h = { Authorization: `Bearer ${key}` };
      const id = sha256(key);
      assert.equal((await s.api('/v1/save', { method: 'PUT', body: validSave(), headers: h })).status, 200);
      const n = uniqueName();
      const fresh = await s.api('/v1/record', { method: 'PUT', body: record({ name: n }), headers: h });
      assert.deepEqual([fresh.status, fresh.body], [403, { error: 'account_needed' }]);
      assert.equal(await s.store.getRecord(id), null);
      // Without a name it is as before.
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record(), headers: h })).body, { ok: true, name: '' });
      assert.equal((await s.api('/v1/record', { method: 'PUT', body: record({ name: n }), headers: h })).status, 403);
      // A guest named before accounts (seeded): same name again (any case) is fine, another is not.
      await s.store.putRecord(id, { ...((await import('./_slots_store_contract.js')).rec({ name: n })) });
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record({ name: n.toUpperCase() }), headers: h })).body, { ok: true, name: n.toUpperCase() });
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record(), headers: h })).body, { ok: true, name: n.toUpperCase() });
      assert.equal((await s.api('/v1/record', { method: 'PUT', body: record({ name: uniqueName() }), headers: h })).status, 403);
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record({ name: '' }), headers: h })).body, { ok: true, name: '' });
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record({ name: n }), headers: h })).body, { error: 'account_needed' });
      // A guest's own record and board answers are as before.
      assert.equal((await s.api('/v1/record', { headers: h })).status, 200);
      assert.equal((await s.api('/v1/record', { headers: { Authorization: 'Bearer nope' } })).status, 401);
      assert.equal((await s.api('/v1/record', { method: 'PUT', body: record() })).status, 401);
    });
  });

  test(`${label}: accounts off: slot routes are 503; guests may still set new names`, async () => {
    const s = await start({ accounts: { enabled: false } });
    try {
      for (const [method, path] of [['GET', '/v1/saves'], ['PUT', '/v1/saves/1'], ['DELETE', '/v1/saves/1'], ['POST', '/v1/saves/1/rename'], ['POST', '/v1/saves/claim']]) {
        const r = await s.api(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
        assert.deepEqual([r.status, r.body], [503, { error: 'accounts_off' }], `${method} ${path}`);
      }
      const key = freshKey();
      const h = { Authorization: `Bearer ${key}` };
      await s.api('/v1/save', { method: 'PUT', body: validSave(), headers: h });
      const n = uniqueName();
      assert.deepEqual((await s.api('/v1/record', { method: 'PUT', body: record({ name: n }), headers: h })).body, { ok: true, name: n });
      // A cookie means nothing while off.
      assert.equal((await s.api('/v1/record', { method: 'PUT', body: record(), cookie: 'a'.repeat(43) })).status, 401);
    } finally {
      await s.close();
    }
  });
}
