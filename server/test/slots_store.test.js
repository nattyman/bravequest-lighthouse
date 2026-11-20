import { createMemoryStore } from '../src/store.js';
import { runSlotStoreContract } from './_slots_store_contract.js';

const store = createMemoryStore();
runSlotStoreContract('memory store (slots)', () => store);
