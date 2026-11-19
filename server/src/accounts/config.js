// Reads the account switches and settings from the environment. Spec: ACCOUNTS.md (sections 0, 4, 5).
//
// accountsConfigFromEnv(env) -> {
//   enabled,            true only when ACCOUNTS=on and everything below that it needs is set
//   problems: [text],   why it is off (names of settings only, never their values)
//   appUrl, sessionSecret, cookieInsecure, superAdminEmails: [lower-cased],
//   mailer,             a Resend mailer, a fake one (MAIL_FAKE=1), or null
//   admin: { apiKey } | null    the private admin API (ADMIN_API_KEY, at least 32 characters)
// }
// createApp takes this object as config.accounts (tests build it by hand, see test/_accounts.js).

import { createFakeMailer, createResendMailer } from './mailer.js';
import { MIN_ADMIN_KEY_CHARS, MIN_SESSION_SECRET_CHARS } from './limits.js';

export const parseEmailList = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function accountsConfigFromEnv(env = process.env) {
  const problems = [];
  const on = (env.ACCOUNTS ?? '').trim().toLowerCase() === 'on';
  const appUrl = (env.APP_URL ?? '').trim();
  const sessionSecret = env.SESSION_SECRET ?? '';
  const mailFake = (env.MAIL_FAKE ?? '') === '1';
  const resendKey = (env.RESEND_API_KEY ?? '').trim();
  const mailFrom = (env.MAIL_FROM ?? '').trim();

  if (!on) problems.push('ACCOUNTS is not "on"');
  if (!/^https?:\/\/[^\s]+$/.test(appUrl)) problems.push('APP_URL is not set to an http(s) address');
  if (sessionSecret.length < MIN_SESSION_SECRET_CHARS) {
    problems.push(`SESSION_SECRET is not set (or shorter than ${MIN_SESSION_SECRET_CHARS} characters)`);
  }

  let mailer = null;
  if (mailFake) mailer = createFakeMailer();
  else if (resendKey && mailFrom) mailer = createResendMailer({ apiKey: resendKey, from: mailFrom });
  else problems.push('no mail sender: set RESEND_API_KEY and MAIL_FROM (or MAIL_FAKE=1 for local use)');

  const adminKey = env.ADMIN_API_KEY ?? '';
  return {
    enabled: problems.length === 0,
    problems,
    appUrl,
    sessionSecret,
    cookieInsecure: (env.COOKIE_INSECURE ?? '') === '1',
    superAdminEmails: parseEmailList(env.SUPER_ADMIN_EMAILS),
    mailer,
    admin: adminKey.length >= MIN_ADMIN_KEY_CHARS ? { apiKey: adminKey } : null,
    adminKeyTooShort: adminKey.length > 0 && adminKey.length < MIN_ADMIN_KEY_CHARS,
  };
}
