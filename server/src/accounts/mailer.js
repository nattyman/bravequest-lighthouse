// Sending email. Spec: ACCOUNTS.md (section 5).
//
// A mailer is { kind, send({ to, subject, text, html }) -> Promise }. send() rejects on failure; callers
// decide what a failure means (sign-in start ignores it and logs one line with no address).
//
//   createResendMailer({ apiKey, from, fetchImpl?, timeoutMs? })   Resend's send-email API via fetch
//   createFakeMailer()                                             keeps messages in memory: .sent, .last(to),
//                                                                  .fail(true) makes sends reject

const RESEND_URL = 'https://api.resend.com/emails';

export function createResendMailer({ apiKey, from, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!apiKey || !from) throw new Error('createResendMailer needs apiKey and from');
  return {
    kind: 'resend',
    async send({ to, subject, text, html }) {
      const res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = new Error(`mail provider answered ${res.status}`);
        err.code = `mail_${res.status}`;
        throw err;
      }
    },
  };
}

export function createFakeMailer() {
  const sent = [];
  let failing = false;
  return {
    kind: 'fake',
    sent,
    async send(msg) {
      if (failing) {
        const err = new Error('fake mailer failure');
        err.code = 'mail_fake';
        throw err;
      }
      sent.push({ ...msg, at: Date.now() });
    },
    /** The newest message to `to` (or the newest of all), or undefined. */
    last(to) {
      for (let i = sent.length - 1; i >= 0; i--) if (to === undefined || sent[i].to === to) return sent[i];
      return undefined;
    },
    fail(on = true) {
      failing = on;
    },
    clear() {
      sent.length = 0;
    },
  };
}
