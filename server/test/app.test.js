import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { test, describe, before, after } from 'node:test';
import { compileOrigins, createLimiter, normaliseKey } from '../src/app.js';
import {
  KEY, KEY2, auth, freshKey, getSave, post, putSave, startServer,
  validEvent, validFeedback, validSave,
} from './_helpers.js';

const ip = (n) => ({ 'X-Forwarded-For': `10.0.0.${n}` });

describe('basics', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('health is 200 {ok:true} with no-store', async () => {
    const res = await fetch(`${s.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-type'), /^application\/json/);
  });

  test('health is 503 {ok:false} when the store is unreachable', async () => {
    const broken = await startServer({
      store: { ping: async () => { throw new Error('down'); } },
    });
    const res = await fetch(`${broken.url}/health`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false });
    await broken.close();
  });

  test('health is 503 when the store hangs', async () => {
    const hung = await startServer({
      store: { ping: () => new Promise(() => {}) },
      config: { healthTimeoutMs: 50 },
    });
    assert.equal((await fetch(`${hung.url}/health`)).status, 503);
    await hung.close();
  });

  test('unknown path is 404 not_found', async () => {
    for (const path of ['/', '/v1', '/v1/saves', '/v1/save/', '/v2/save', '/health/x']) {
      const res = await fetch(`${s.url}${path}`);
      assert.equal(res.status, 404, path);
      assert.deepEqual(await res.json(), { error: 'not_found' });
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });

  test('wrong method on a known path is 405 with Allow', async () => {
    const cases = [
      ['POST', '/health'], ['POST', '/v1/save'], ['DELETE', '/v1/save'],
      ['GET', '/v1/event'], ['PUT', '/v1/event'], ['GET', '/v1/feedback'], ['DELETE', '/v1/feedback'],
    ];
    for (const [method, path] of cases) {
      const res = await fetch(`${s.url}${path}`, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
      assert.ok(res.headers.get('allow'));
    }
  });

  test('a query string does not change routing', async () => {
    assert.equal((await fetch(`${s.url}/health?x=1`)).status, 200);
  });

  test('a store failure is a 500 with no detail', async () => {
    const broken = await startServer({
      store: { getSave: async () => { throw new Error('secret detail'); } },
    });
    const res = await getSave(broken.url, KEY);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal' });
    assert.ok(!broken.logs.join('\n').includes('secret detail'));
    await broken.close();
  });
});

describe('sync key', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('missing key is 401 bad_key on GET and PUT', async () => {
    const get = await fetch(`${s.url}/v1/save`);
    assert.equal(get.status, 401);
    assert.deepEqual(await get.json(), { error: 'bad_key' });
    const put = await fetch(`${s.url}/v1/save`, { method: 'PUT', body: JSON.stringify(validSave()) });
    assert.equal(put.status, 401);
    assert.deepEqual(await put.json(), { error: 'bad_key' });
  });

  test('malformed keys are 401', async () => {
    const bad = [
      'SHORT', // too short
      'ABCD-EFGH-IJKL', // I and L are not in the alphabet
      'OOOO-OOOO-OOOO', // O
      'UUUU-UUUU-UUUU', // U
      'ABCDEFGHJKM', // 11 chars
      'A'.repeat(33), // too long
      'ABCD_EFGH_JKMN', // underscore
      'ABCDEFGHJKMN!',
    ];
    for (const key of bad) {
      const res = await getSave(s.url, key);
      assert.equal(res.status, 401, key);
    }
    const noScheme = await fetch(`${s.url}/v1/save`, { headers: { Authorization: KEY } });
    assert.equal(noScheme.status, 401);
    const basic = await fetch(`${s.url}/v1/save`, { headers: { Authorization: `Basic ${KEY}` } });
    assert.equal(basic.status, 401);
  });

  test('normaliseKey', () => {
    assert.equal(normaliseKey('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
    assert.equal(normaliseKey(' abcd efgh jkmn '), 'ABCDEFGHJKMN');
    assert.equal(normaliseKey('ABCDEFGHJKMN'), 'ABCDEFGHJKMN');
    assert.equal(normaliseKey('Z'.repeat(32)), 'Z'.repeat(32));
    assert.equal(normaliseKey('abcd-efgh-jkml'), null);
    assert.equal(normaliseKey(undefined), null);
  });

  test('lowercase with dashes and spaces is the same key as uppercase without', async () => {
    const put = await putSave(s.url, 'abcd-efgh-jkmn-pqrs', validSave({ at: 5, save: 'norm' }));
    assert.equal(put.status, 200);
    for (const form of ['ABCDEFGHJKMNPQRS', 'ABCD-EFGH-JKMN-PQRS', 'abcd efgh jkmn pqrs', 'AbCd-eFgH jkmnPQRS']) {
      const res = await getSave(s.url, form);
      assert.equal(res.status, 200, form);
      assert.equal((await res.json()).save, 'norm');
    }
    assert.equal((await getSave(s.url, KEY2)).status, 404);
  });

  test('the store only ever sees sha256(normalised key), and logs never contain the key', async () => {
    const expected = createHash('sha256').update('ABCDEFGHJKMNPQRS').digest('hex');
    assert.ok(s.store._saves.has(expected));
    for (const id of s.store._saves.keys()) assert.match(id, /^[0-9a-f]{64}$/);
    const logs = s.logs.join('\n');
    assert.ok(!/ABCD/i.test(logs));
    assert.ok(!logs.includes('norm'));
  });
});

describe('save round trip', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('get 404, put 200, get returns it', async () => {
    const miss = await getSave(s.url, KEY);
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { error: 'no_save' });

    const put = await putSave(s.url, KEY, validSave({ at: 1700000000000 }));
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, at: 1700000000000 });
    assert.equal(put.headers.get('cache-control'), 'no-store');

    const got = await getSave(s.url, KEY);
    assert.equal(got.status, 200);
    assert.deepEqual(await got.json(), { v: 1, at: 1700000000000, objective: 'Light the lamp', save: '{"hp":3}' });
    assert.equal(got.headers.get('cache-control'), 'no-store');
  });

  test('stale put (older or equal at) is 409 and leaves the stored save unchanged', async () => {
    for (const at of [1700000000000, 1699999999999, 1]) {
      const res = await putSave(s.url, KEY, validSave({ at, objective: 'changed', save: 'changed' }));
      assert.equal(res.status, 409, String(at));
      assert.deepEqual(await res.json(), { error: 'stale', at: 1700000000000 });
    }
    const got = await (await getSave(s.url, KEY)).json();
    assert.deepEqual(got, { v: 1, at: 1700000000000, objective: 'Light the lamp', save: '{"hp":3}' });
  });

  test('newer put replaces', async () => {
    const res = await putSave(s.url, KEY, validSave({ at: 1700000000001, objective: 'Climb', save: 'v2' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, at: 1700000000001 });
    const got = await (await getSave(s.url, KEY)).json();
    assert.deepEqual(got, { v: 1, at: 1700000000001, objective: 'Climb', save: 'v2' });
  });

  test('saves are separate per key', async () => {
    assert.equal((await getSave(s.url, KEY2)).status, 404);
  });

  test('objective is truncated to 120 chars; save of exactly 245760 chars is accepted', async () => {
    const key = freshKey();
    const big = 'x'.repeat(245760);
    const res = await putSave(s.url, key, validSave({ objective: 'o'.repeat(500), save: big }));
    assert.equal(res.status, 200);
    const got = await (await getSave(s.url, key)).json();
    assert.equal(got.objective, 'o'.repeat(120));
    assert.equal(got.save.length, 245760);
  });

  test('content type is not required to be JSON (text/plain avoids a preflight)', async () => {
    const key = freshKey();
    const res = await putSave(s.url, key, validSave(), { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 200);
  });
});

describe('save validation', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.close(); });

  test('a save stamped more than a day in the future is 400', async () => {
    const srv = await startServer();
    try {
      const put = (at) => fetch(srv.url + '/v1/save', { method: 'PUT', headers: { Authorization: 'Bearer ' + freshKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, at, objective: '', save: 'x' }) });
      assert.equal((await put(Date.now() + 48 * 3600 * 1000)).status, 400);
      assert.equal((await put(Date.now() + 60 * 1000)).status, 200);
    } finally { await srv.close(); }
  });

  test('bad bodies are 400 bad_request and store nothing', async () => {
    const bad = [
      '', 'not json', '[]', 'null', '"str"', '{', '123',
      {}, validSave({ v: 2 }), validSave({ v: '1' }), validSave({ v: undefined }),
      validSave({ at: 0 }), validSave({ at: -5 }), validSave({ at: 1.5 }), validSave({ at: '1000' }),
      validSave({ at: null }), validSave({ at: 2 ** 60 }), validSave({ at: undefined }),
      validSave({ objective: 5 }), validSave({ objective: undefined }), validSave({ objective: null }),
      validSave({ save: '' }), validSave({ save: 5 }), validSave({ save: { a: 1 } }), validSave({ save: undefined }),
      validSave({ save: 'x'.repeat(245761) }), validSave({ save: 'nul\u0000byte' }),
      validSave({ objective: 'nul\u0000' }),
    ];
    for (const body of bad) {
      const res = await putSave(s.url, KEY, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    assert.equal((await getSave(s.url, KEY)).status, 404);
    assert.equal(s.store._saves.size, 0);
  });

  test('the key is checked before the body', async () => {
    const res = await fetch(`${s.url}/v1/save`, { method: 'PUT', body: 'not json' });
    assert.equal(res.status, 401);
  });
});

describe('oversized bodies', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  test('PUT over 300 KB with Content-Length is 413 too_large', async () => {
    const res = await putSave(s.url, KEY, JSON.stringify(validSave({ save: 'x'.repeat(310 * 1024) })));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too_large' });
    assert.equal(s.store._saves.size, 0);
  });

  test('a body just under the byte limit but over the char limit is 400, not 413', async () => {
    const res = await putSave(s.url, KEY, validSave({ save: 'x'.repeat(250000) }));
    assert.equal(res.status, 400);
  });

  test('a streamed (chunked) body is cut off with 413 once it passes the limit', async () => {
    const { port } = new URL(s.url);
    const result = await new Promise((resolve, reject) => {
      let sent = 0;
      let timer;
      const req = http.request(
        { host: '127.0.0.1', port, path: '/v1/save', method: 'PUT', headers: auth(KEY) },
        (res) => {
          clearInterval(timer);
          let text = '';
          res.on('data', (d) => { text += d; });
          res.on('end', () => resolve({ status: res.statusCode, text, sent, connection: res.headers.connection }));
        },
      );
      req.on('error', (err) => { clearInterval(timer); reject(err); });
      req.write('{"v":1,"at":5,"objective":"","save":"');
      const chunk = 'y'.repeat(16 * 1024);
      // Would send 16 MB in total if the server never answered.
      timer = setInterval(() => {
        if (sent >= 16 * 1024 * 1024) { clearInterval(timer); req.end('"}'); return; }
        sent += chunk.length;
        req.write(chunk);
      }, 1);
    });
    assert.equal(result.status, 413);
    assert.deepEqual(JSON.parse(result.text), { error: 'too_large' });
    assert.equal(result.connection, 'close');
    assert.ok(result.sent < 4 * 1024 * 1024, `server answered after ${result.sent} bytes`);
    assert.equal(s.store._saves.size, 0);
  });

  test('event and feedback bodies have a small cap', async () => {
    const res = await post(s.url, '/v1/feedback', validFeedback({ text: 'x'.repeat(40 * 1024) }));
    assert.equal(res.status, 413);
    const ev = await post(s.url, '/v1/event', validEvent({ extra: 'x'.repeat(40 * 1024) }));
    assert.equal(ev.status, 413);
  });
});

describe('CORS', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(() => s.close());

  const allowed = [
    'https://nattyman.github.io', // exact
    'https://html-classic.itch.zone', // wildcard subdomain label
    'https://v6p9d9t4.itch.zone',
    'http://localhost:8996', // wildcard port
    'http://localhost:3000',
    'http://localhost',
  ];
  const refused = [
    'https://evil.example',
    'http://nattyman.github.io', // wrong scheme
    'https://nattyman.github.io.evil.example',
    'https://itch.zone', // no subdomain label
    'https://a.b.itch.zone', // two labels
    'https://evil-itch.zone',
    'https://x.itch.zone.evil.example',
    'http://x.itch.zone',
    'https://localhost:3000', // wrong scheme
    'http://localhost.evil.example',
    'http://localhost:3000.evil.example',
    'http://localhost:abc',
    'null',
  ];

  test('allowed origins get the CORS headers', async () => {
    for (const origin of allowed) {
      const res = await getSave(s.url, freshKey(), { Origin: origin });
      assert.equal(res.status, 404, origin); // routed normally
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.equal(res.headers.get('vary'), 'Origin');
      assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, PUT, POST, OPTIONS');
      assert.equal(res.headers.get('access-control-max-age'), '86400');
    }
  });

  test('disallowed origins are 403 origin_not_allowed on every API path', async () => {
    for (const origin of refused) {
      const res = await getSave(s.url, KEY, { Origin: origin });
      assert.equal(res.status, 403, origin);
      assert.deepEqual(await res.json(), { error: 'origin_not_allowed' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    const o = { Origin: 'https://evil.example' };
    assert.equal((await putSave(s.url, KEY, validSave(), o)).status, 403);
    assert.equal((await post(s.url, '/v1/event', validEvent(), o)).status, 403);
    assert.equal((await post(s.url, '/v1/feedback', validFeedback(), o)).status, 403);
    assert.equal((await fetch(`${s.url}/v1/save`, { method: 'OPTIONS', headers: o })).status, 403);
    assert.equal((await fetch(`${s.url}/nope`, { headers: o })).status, 403);
    assert.equal(s.store._saves.size, 0);
    assert.equal(s.store._events.length, 0);
    assert.equal(s.store._feedback.length, 0);
  });

  test('/health is exempt from the origin check', async () => {
    const res = await fetch(`${s.url}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const ok = await fetch(`${s.url}/health`, { headers: { Origin: 'https://nattyman.github.io' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://nattyman.github.io');
  });

  test('requests with no Origin header are allowed and get no CORS headers', async () => {
    const res = await getSave(s.url, freshKey());
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('preflight is 204 with CORS headers and no body', async () => {
    for (const path of ['/v1/save', '/v1/event', '/v1/feedback', '/health']) {
      const res = await fetch(`${s.url}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://html-classic.itch.zone',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization, content-type',
        },
      });
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://html-classic.itch.zone');
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, PUT, POST, OPTIONS');
      assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
      assert.equal(res.headers.get('access-control-max-age'), '86400');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(await res.text(), '');
    }
  });

  test('preflight does not need a key and does not count against rate limits', async () => {
    const tight = await startServer({ config: { limits: { saves: { max: 1 } } } });
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${tight.url}/v1/save`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:1' } });
      assert.equal(res.status, 204);
    }
    await tight.close();
  });

  test('error responses to an allowed origin still carry CORS headers', async () => {
    const res = await fetch(`${s.url}/v1/save`, { headers: { Origin: 'https://nattyman.github.io' } });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://nattyman.github.io');
  });

  test('compileOrigins reports entries it cannot use', () => {
    const o = compileOrigins('https://a.example/, *, https://*.*.example, https://ex*ample.com, ftp://x, https://b.example:8443');
    assert.deepEqual(o.invalid, ['*', 'https://*.*.example', 'https://ex*ample.com', 'ftp://x']);
    assert.ok(o.test('https://a.example'));
    assert.ok(o.test('https://b.example:8443'));
    assert.ok(o.test('HTTPS://A.EXAMPLE'));
    assert.ok(!o.test('https://c.example'));
    assert.equal(compileOrigins('').size, 0);
    assert.ok(!compileOrigins(undefined).test('https://a.example'));
  });
});

describe('events', () => {
  let s;
  before(async () => { s = await startServer({ config: { limits: { events: { max: 1000 } } } }); });
  after(() => s.close());

  test('valid event is 204 and stores name, build, platform, sid and a timestamp, but no IP', async () => {
    const res = await post(s.url, '/v1/event', validEvent({ ip: '1.2.3.4', extra: 'ignored' }), {
      'X-Forwarded-For': '203.0.113.77',
      'CF-Connecting-IP': '203.0.113.77',
    });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(s.store._events.length, 1);
    const row = s.store._events[0];
    assert.deepEqual(Object.keys(row).sort(), ['build', 'createdAt', 'name', 'platform', 'sid']);
    assert.equal(row.name, 'act1.start');
    assert.equal(row.build, 'b42');
    assert.equal(row.platform, 'touch');
    assert.equal(row.sid, 'abc12345');
    assert.equal(typeof row.createdAt, 'number');
    assert.ok(!JSON.stringify(row).includes('203.0.113.77'));
  });

  test('every platform value and edge-length fields are accepted', async () => {
    for (const platform of ['touch', 'keyboard', 'pad', 'unknown']) {
      assert.equal((await post(s.url, '/v1/event', validEvent({ platform }))).status, 204);
    }
    const edge = validEvent({ name: 'a_b.c:d-9' + 'x'.repeat(39), build: 'b'.repeat(40), sid: 'a1'.repeat(12) });
    assert.equal((await post(s.url, '/v1/event', edge)).status, 204);
    assert.equal((await post(s.url, '/v1/event', validEvent({ build: '' }))).status, 204);
  });

  test('invalid events are 400 and store nothing', async () => {
    const before = s.store._events.length;
    const bad = [
      '', 'nope', '[]', {},
      validEvent({ name: '' }), validEvent({ name: 'Upper' }), validEvent({ name: 'has space' }),
      validEvent({ name: 'x'.repeat(49) }), validEvent({ name: 5 }), validEvent({ name: undefined }),
      validEvent({ name: 'ok\n' }),
      validEvent({ build: 'b'.repeat(41) }), validEvent({ build: 7 }), validEvent({ build: undefined }),
      validEvent({ platform: 'mouse' }), validEvent({ platform: 'Touch' }), validEvent({ platform: undefined }),
      validEvent({ sid: 'short' }), validEvent({ sid: 'UPPERCASE1' }), validEvent({ sid: 'a'.repeat(25) }),
      validEvent({ sid: 'has-dash-1' }), validEvent({ sid: undefined }),
    ];
    for (const body of bad) {
      const res = await post(s.url, '/v1/event', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    assert.equal(s.store._events.length, before);
  });
});

describe('feedback', () => {
  let s;
  before(async () => { s = await startServer({ config: { limits: { feedback: { max: 1000 } } } }); });
  after(() => s.close());

  test('valid feedback is 204, trimmed, optional fields default to empty, no IP stored', async () => {
    const res = await post(s.url, '/v1/feedback', validFeedback({ text: '  The lamp puzzle was great \n' }), {
      'X-Forwarded-For': '203.0.113.78',
    });
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    const row = s.store._feedback[0];
    assert.deepEqual(Object.keys(row).sort(), ['build', 'contact', 'createdAt', 'platform', 'progress', 'text']);
    assert.equal(row.text, 'The lamp puzzle was great');
    assert.equal(row.progress, '');
    assert.equal(row.contact, '');
    assert.ok(!JSON.stringify(row).includes('203.0.113.78'));
  });

  test('progress and contact are stored when given; edge lengths accepted', async () => {
    const res = await post(s.url, '/v1/feedback', validFeedback({
      text: 't'.repeat(4000), build: 'b'.repeat(40), progress: 'p'.repeat(120), contact: 'c'.repeat(200),
    }));
    assert.equal(res.status, 204);
    const row = s.store._feedback.at(-1);
    assert.equal(row.text.length, 4000);
    assert.equal(row.progress.length, 120);
    assert.equal(row.contact.length, 200);
    // 4000 after trimming is fine even if longer before.
    assert.equal((await post(s.url, '/v1/feedback', validFeedback({ text: ' ' + 't'.repeat(4000) + ' ' }))).status, 204);
    assert.equal((await post(s.url, '/v1/feedback', validFeedback({ progress: null, contact: null }))).status, 204);
  });

  test('invalid feedback is 400 and stores nothing', async () => {
    const before = s.store._feedback.length;
    const bad = [
      '', 'nope', '[]', {},
      validFeedback({ text: '' }), validFeedback({ text: '   \n\t ' }), validFeedback({ text: 't'.repeat(4001) }),
      validFeedback({ text: 5 }), validFeedback({ text: undefined }),
      validFeedback({ build: 'b'.repeat(41) }), validFeedback({ build: undefined }),
      validFeedback({ platform: 'phone' }), validFeedback({ platform: undefined }),
      validFeedback({ progress: 'p'.repeat(121) }), validFeedback({ progress: 5 }),
      validFeedback({ contact: 'c'.repeat(201) }), validFeedback({ contact: { a: 1 } }),
    ];
    for (const body of bad) {
      const res = await post(s.url, '/v1/feedback', body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.deepEqual(await res.json(), { error: 'bad_request' });
    }
    assert.equal(s.store._feedback.length, before);
  });

  test('feedback text never reaches the log', async () => {
    await post(s.url, '/v1/feedback', validFeedback({ text: 'zebra-crossing-marker', contact: 'contact-marker' }));
    const logs = s.logs.join('\n');
    assert.ok(!logs.includes('zebra-crossing-marker'));
    assert.ok(!logs.includes('contact-marker'));
  });
});

describe('rate limits', () => {
  const retryAfterOk = (res, maxSeconds) => {
    const v = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(v) && v >= 1 && v <= maxSeconds, `Retry-After was ${res.headers.get('retry-after')}`);
  };

  test('saves: GET and PUT share one limit, per IP', async () => {
    const s = await startServer({ config: { limits: { saves: { max: 4 } } } });
    const key = freshKey();
    assert.equal((await putSave(s.url, key, validSave({ at: 1 }), ip(1))).status, 200);
    assert.equal((await getSave(s.url, key, ip(1))).status, 200);
    assert.equal((await putSave(s.url, key, validSave({ at: 2 }), ip(1))).status, 200);
    assert.equal((await getSave(s.url, key, ip(1))).status, 200);
    const get = await getSave(s.url, key, ip(1));
    assert.equal(get.status, 429);
    assert.deepEqual(await get.json(), { error: 'rate_limited' });
    retryAfterOk(get, 60);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const put = await putSave(s.url, key, validSave({ at: 3 }), ip(1));
    assert.equal(put.status, 429);
    retryAfterOk(put, 60);
    // Another address is unaffected, and the refused PUT changed nothing.
    const other = await getSave(s.url, key, ip(2));
    assert.equal(other.status, 200);
    assert.equal((await other.json()).at, 2);
    await s.close();
  });

  test('events limit', async () => {
    const s = await startServer({ config: { limits: { events: { max: 3 } } } });
    for (let i = 0; i < 3; i++) assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 204);
    const res = await post(s.url, '/v1/event', validEvent(), ip(1));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
    retryAfterOk(res, 60);
    assert.equal(s.store._events.length, 3);
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(2))).status, 204);
    await s.close();
  });

  test('feedback limit (only valid feedback counts)', async () => {
    const s = await startServer({ config: { limits: { feedback: { max: 2 } } } });
    assert.equal((await post(s.url, '/v1/feedback', validFeedback({ text: '' }), ip(1))).status, 400);
    assert.equal((await post(s.url, '/v1/feedback', validFeedback(), ip(1))).status, 204);
    assert.equal((await post(s.url, '/v1/feedback', validFeedback(), ip(1))).status, 204);
    const res = await post(s.url, '/v1/feedback', validFeedback(), ip(1));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
    retryAfterOk(res, 3600);
    assert.equal(s.store._feedback.length, 2);
    assert.equal((await post(s.url, '/v1/feedback', validFeedback(), ip(2))).status, 204);
    await s.close();
  });

  test('failed key lookups: after the limit every GET from that IP is 429, even for a real key', async () => {
    const s = await startServer({ config: { limits: { failedLookups: { max: 3 } } } });
    const real = freshKey();
    assert.equal((await putSave(s.url, real, validSave(), ip(9))).status, 200);
    // Successful lookups do not count.
    for (let i = 0; i < 5; i++) assert.equal((await getSave(s.url, real, ip(1))).status, 200);
    for (let i = 0; i < 3; i++) assert.equal((await getSave(s.url, freshKey(), ip(1))).status, 404);
    const guess = await getSave(s.url, freshKey(), ip(1));
    assert.equal(guess.status, 429);
    assert.deepEqual(await guess.json(), { error: 'rate_limited' });
    retryAfterOk(guess, 3600);
    const realNow = await getSave(s.url, real, ip(1));
    assert.equal(realNow.status, 429);
    retryAfterOk(realNow, 3600);
    // Other addresses still work.
    assert.equal((await getSave(s.url, real, ip(2))).status, 200);
    await s.close();
  });

  test('new save ids: limited per IP; updates to existing saves still work', async () => {
    const s = await startServer({ config: { limits: { newSaves: { max: 2 } } } });
    const a = freshKey();
    const b = freshKey();
    assert.equal((await putSave(s.url, a, validSave({ at: 1 }), ip(1))).status, 200);
    // Updates and stale writes do not use up the allowance.
    assert.equal((await putSave(s.url, a, validSave({ at: 2 }), ip(1))).status, 200);
    assert.equal((await putSave(s.url, a, validSave({ at: 2 }), ip(1))).status, 409);
    assert.equal((await putSave(s.url, b, validSave({ at: 1 }), ip(1))).status, 200);
    const c = freshKey();
    const res = await putSave(s.url, c, validSave({ at: 1 }), ip(1));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
    retryAfterOk(res, 3600);
    assert.equal((await getSave(s.url, c, ip(2))).status, 404); // nothing was created
    assert.equal(s.store._saves.size, 2);
    // Existing saves can still be updated and still report stale.
    assert.equal((await putSave(s.url, a, validSave({ at: 3 }), ip(1))).status, 200);
    assert.equal((await putSave(s.url, a, validSave({ at: 3 }), ip(1))).status, 409);
    // A different address can create.
    assert.equal((await putSave(s.url, c, validSave({ at: 1 }), ip(2))).status, 200);
    await s.close();
  });

  test('new save ids: concurrent creates cannot overshoot', async () => {
    const s = await startServer({ config: { limits: { newSaves: { max: 3 } } } });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => putSave(s.url, freshKey(), validSave(), ip(1)).then((r) => r.status)),
    );
    assert.equal(results.filter((x) => x === 200).length, 3);
    assert.equal(results.filter((x) => x === 429).length, 9);
    assert.equal(s.store._saves.size, 3);
    await s.close();
  });

  test('the window resets', async () => {
    let t = 1_000_000;
    const s = await startServer({ config: { now: () => t, limits: { events: { max: 1, windowMs: 60_000 } } } });
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 204);
    const res = await post(s.url, '/v1/event', validEvent(), ip(1));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    t += 30_500;
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).headers.get('retry-after'), '30');
    t += 29_500;
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 204);
    await s.close();
  });

  test('client IP: CF-Connecting-IP wins, then first X-Forwarded-For entry', async () => {
    const s = await startServer({ config: { limits: { events: { max: 1 } } } });
    const send = (headers) => post(s.url, '/v1/event', validEvent(), headers).then((r) => r.status);
    assert.equal(await send({ 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '10.1.1.1' }), 204);
    // Same CF address, different XFF: same bucket.
    assert.equal(await send({ 'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '10.1.1.2' }), 429);
    // Different CF address: new bucket.
    assert.equal(await send({ 'CF-Connecting-IP': '198.51.100.2', 'X-Forwarded-For': '10.1.1.1' }), 204);
    // No CF header: first XFF entry is used.
    assert.equal(await send({ 'X-Forwarded-For': '10.2.2.2, 172.16.0.1' }), 204);
    assert.equal(await send({ 'X-Forwarded-For': '10.2.2.2, 172.16.0.9' }), 429);
    assert.equal(await send({ 'X-Forwarded-For': '10.2.2.3, 172.16.0.1' }), 204);
    // IPv6 addresses in the same /64 share a bucket.
    assert.equal(await send({ 'CF-Connecting-IP': '2001:db8:1:2::1' }), 204);
    assert.equal(await send({ 'CF-Connecting-IP': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), 429);
    assert.equal(await send({ 'CF-Connecting-IP': '2001:db8:1:3::1' }), 204);
    await s.close();
  });

  test('with trustProxy off the proxy headers are ignored', async () => {
    const s = await startServer({ config: { trustProxy: false, limits: { events: { max: 1 } } } });
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(1))).status, 204);
    assert.equal((await post(s.url, '/v1/event', validEvent(), ip(2))).status, 429);
    await s.close();
  });

  test('limiter prunes expired entries and caps its size', () => {
    let t = 0;
    const limiter = createLimiter({ max: 1, windowMs: 1000 }, () => t, 50);
    for (let i = 0; i < 40; i++) limiter.take(`k${i}`);
    assert.equal(limiter.size, 40);
    t = 1500; // every window has ended
    limiter.take('fresh');
    assert.equal(limiter.size, 1);
    for (let i = 0; i < 500; i++) limiter.take(`flood${i}`);
    assert.ok(limiter.size <= 51, `size ${limiter.size}`);
  });
});

describe('logging', () => {
  test('one line per request: method, path, status, ms; nothing sensitive', async () => {
    const s = await startServer();
    await fetch(`${s.url}/health?token=querysecret`);
    await putSave(s.url, KEY, validSave({ save: 'save-body-marker', objective: 'objective-marker' }));
    await getSave(s.url, KEY);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.logs.length, 3);
    assert.match(s.logs[0], /^GET \/health 200 \d+ms$/);
    assert.match(s.logs[1], /^PUT \/v1\/save 200 \d+ms$/);
    assert.match(s.logs[2], /^GET \/v1\/save 200 \d+ms$/);
    const all = s.logs.join('\n');
    for (const secret of ['querysecret', 'save-body-marker', 'objective-marker', 'ABCD', 'EFGH']) {
      assert.ok(!all.includes(secret), secret);
    }
    await s.close();
  });
});
