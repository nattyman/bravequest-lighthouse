// Entry point: reads the environment, builds the store, listens, shuts down cleanly.

import http from 'node:http';
import { createApp } from './app.js';
import { createMemoryStore, createPgStore } from './store.js';

const port = Number(process.env.PORT) || 3000;
const databaseUrl = (process.env.DATABASE_URL || '').trim();
const allowedOrigins = process.env.ALLOWED_ORIGINS || '';
const trustProxy = (process.env.TRUST_PROXY ?? '1') === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildStore() {
  if (!databaseUrl) {
    console.warn(
      'WARNING: DATABASE_URL is not set. Using the in-memory store: saves, events and ' +
        'feedback are NOT persistent and are lost when this process stops.',
    );
    return createMemoryStore();
  }
  const store = createPgStore(databaseUrl);
  // The database may still be starting when the container comes up.
  const attempts = 10;
  for (let i = 1; ; i++) {
    try {
      await store.init();
      console.log('postgres store ready');
      return store;
    } catch (err) {
      console.error(`postgres not ready (attempt ${i}/${attempts}): ${err.code || err.message}`);
      if (i >= attempts) throw err;
      await sleep(3000);
    }
  }
}

const store = await buildStore().catch((err) => {
  console.error(`could not initialise the store: ${err.code || err.message}`);
  process.exit(1);
});

const app = createApp({ store, config: { allowedOrigins, trustProxy } });

if (app.origins.invalid.length > 0) {
  console.warn(`WARNING: ignoring invalid ALLOWED_ORIGINS entries: ${app.origins.invalid.join(', ')}`);
}
if (app.origins.size === 0) {
  console.warn('WARNING: ALLOWED_ORIGINS is empty. Every browser request will be refused with 403.');
}

const server = http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;

server.listen(port, () => {
  console.log(`lighthouse save service listening on :${port} (store: ${store.kind}, trust proxy: ${trustProxy})`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => {
    console.error('shutdown timed out, exiting');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(async () => {
    try {
      await store.close();
    } catch (err) {
      console.error(`error closing the store: ${err.code || err.message}`);
    }
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
