// Shared helpers for the test files (not a test file itself).
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';

export const KEY = 'ABCD-EFGH-JKMN-PQRS';
export const KEY2 = '0123-4567-89AB-CDEF';

let keyCounter = 0;
/** A fresh valid sync key (Crockford alphabet). */
export function freshKey() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = ++keyCounter;
  let tail = '';
  for (let i = 0; i < 6; i++) {
    tail = alphabet[n % 32] + tail;
    n = Math.floor(n / 32);
  }
  let rand = '';
  for (let i = 0; i < 10; i++) rand += alphabet[Math.floor(Math.random() * 32)];
  return rand + tail;
}

/** Starts the app on an ephemeral port. Returns { url, store, app, logs, close }. */
export async function startServer({ store = createMemoryStore(), config = {} } = {}) {
  const logs = [];
  const app = createApp({
    store,
    config: {
      allowedOrigins: 'https://nattyman.github.io, https://*.itch.zone, http://localhost:*',
      log: (line) => logs.push(line),
      ...config,
    },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    store,
    app,
    logs,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export const auth = (key) => ({ Authorization: `Bearer ${key}` });

export function putSave(url, key, body, headers = {}) {
  return fetch(`${url}/v1/save`, {
    method: 'PUT',
    headers: { ...auth(key), 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function getSave(url, key, headers = {}) {
  return fetch(`${url}/v1/save`, { headers: { ...auth(key), ...headers } });
}

export function post(url, path, body, headers = {}) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export const validSave = (over = {}) => ({ v: 1, at: 1000, objective: 'Light the lamp', save: '{"hp":3}', ...over });
export const validEvent = (over = {}) => ({ name: 'act1.start', build: 'b42', platform: 'touch', sid: 'abc12345', ...over });
export const validFeedback = (over = {}) => ({ text: 'Loved the cave', build: 'b42', platform: 'keyboard', ...over });
