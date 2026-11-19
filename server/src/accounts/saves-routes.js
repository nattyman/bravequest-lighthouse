// Account save slots: /v1/saves, /v1/saves/:slot, /v1/saves/:slot/rename, /v1/saves/claim.
// Spec: ACCOUNTS.md (section 3, "Save slots").
//
// STUB: every /v1/saves* request answers 501 {error:'not_implemented'} until the save-slot routes are built
// here. Replace the single catch-all route below with the real ones; the shape is the same as in
// auth-routes.js: [{ method, path | match (RegExp, named groups become params), run(req, res, { ip, params, query }) }].
// The accounts switch (503 accounts_off), CORS with credentials and 404/405 are handled by createApp.
// Tools: ctx.resolveOwner(req, res) (account wins over a Bearer code), store.slots (src/stores/slots.js),
// readJsonBody/send/sendLimited and validateSave/MAX_SAVE_BODY_BYTES from ../http.js, SLOTS from ./limits.js.

import { send } from '../http.js';

export function savesRoutes(ctx) { // eslint-disable-line no-unused-vars
  return [
    {
      method: '*',
      match: /^\/v1\/saves(?:\/.*)?$/,
      run: async (req, res) => send(res, 501, { error: 'not_implemented' }),
    },
  ];
}
