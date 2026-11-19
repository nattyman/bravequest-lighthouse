// Save slots, claims and account records against a real Postgres: the slot store contract and the HTTP
// suite. Only runs when TEST_DATABASE_URL is set; skipped otherwise.
import { test, before, after } from 'node:test';
import { createPgStore } from '../src/store.js';
import { runSlotStoreContract } from './_slots_store_contract.js';
import { runSlotsHttp } from './_slots_http.js';

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  test('postgres save slots (skipped: TEST_DATABASE_URL is not set)', { skip: true }, () => {});
} else {
  let store;
  before(async () => {
    store = createPgStore(url);
    await store.init();
  });
  after(async () => {
    await store.close();
  });
  runSlotStoreContract('postgres store (slots)', () => store);
  runSlotsHttp('postgres', () => store);
}
