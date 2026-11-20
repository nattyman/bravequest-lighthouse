import { createMemoryStore } from '../src/store.js';
import { runAccountStoreContract } from './_accounts_store_contract.js';

const store = createMemoryStore();
runAccountStoreContract('memory store (accounts)', () => store);
