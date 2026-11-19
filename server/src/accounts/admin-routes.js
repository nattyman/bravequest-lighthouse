// The private admin API: /admin/v1/*. Spec: ACCOUNTS.md (section 4).
//
// adminGuard(ctx, req) runs before any admin route (createApp calls it) and answers for the whole prefix:
//   - no ADMIN_API_KEY (or shorter than 32 characters)          -> 404 not_found
//   - the request came through the public tunnel (cf-connecting-ip or cf-ray header), or carries an Origin
//     header (a browser)                                          -> 404 not_found
//   - X-Admin-Key missing or wrong (constant-time compare)       -> 401 {error:'admin_key'}
//   - X-Admin-Email missing or not an address                    -> 400 {error:'admin_email'}
// and on success returns { adminEmail } (lower-cased), passed to each route as info.adminEmail.
//
// STUB: every admin path answers 501 {error:'not_implemented'} until the admin routes are built here.
// Replace the catch-all below with the real routes (same shape as auth-routes.js; `match` RegExp named groups
// become info.params). Write an audit row for every change with ctx.audit({ adminEmail, action, accountId, detail }).
// Tools: store.accounts / store.sessions / store.slots / store.audit / store.settings, ctx.isSuper(account),
// ctx.me(account), ctx.toolsFor(account), ctx.mailer; TOOL_GROUPS, ROLES, STATUSES from ./limits.js.

import { send } from '../http.js';
import { safeEqual } from './crypto.js';

export const ADMIN_PREFIX = '/admin/v1';
export const isAdminPath = (path) => path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`);

/** -> { adminEmail } | { status, error } */
export function adminGuard(ctx, req) {
  const key = ctx.config.admin?.apiKey;
  if (!key) return { status: 404, error: 'not_found' };
  const h = req.headers;
  if (h['cf-connecting-ip'] !== undefined || h['cf-ray'] !== undefined || h.origin !== undefined) {
    return { status: 404, error: 'not_found' };
  }
  const given = typeof h['x-admin-key'] === 'string' ? h['x-admin-key'] : '';
  if (!safeEqual(given, key)) return { status: 401, error: 'admin_key' };
  const adminEmail = ctx.normaliseEmail(h['x-admin-email']);
  if (!adminEmail) return { status: 400, error: 'admin_email' };
  return { adminEmail };
}

export function adminRoutes(ctx) { // eslint-disable-line no-unused-vars
  return [
    {
      method: '*',
      match: /^\/admin\/v1(?:\/.*)?$/,
      run: async (req, res) => send(res, 501, { error: 'not_implemented' }),
    },
  ];
}
