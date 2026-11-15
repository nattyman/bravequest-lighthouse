import { createMemoryStore } from '../src/store.js';
import { runStoreContract } from './_store_contract.js';

const store = createMemoryStore();

runStoreContract('memory store', () => store, {
  events: async (sid) => store._events.filter((e) => e.sid === sid),
  feedback: async (build) => store._feedback.filter((f) => f.build === build),
});
