// The three account emails, each as plain text and simple HTML (inline styles, no remote images, no
// tracking). Spec: ACCOUNTS.md (section 5).

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const INK = '#2e2238';
const VIOLET = '#5b3f8c';
const PARCHMENT = '#f4ead5';
const EDGE = '#d8c6a0';

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:#e9dfc8;font-family:Georgia,'Times New Roman',serif;color:${INK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:${PARCHMENT};border:1px solid ${EDGE};border-radius:6px;">
<tr><td style="padding:28px 28px 8px 28px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${VIOLET};">Brave Quest: Lighthouse</td></tr>
<tr><td style="padding:4px 28px 28px 28px;font-size:16px;line-height:1.5;">
${bodyHtml}
</td></tr></table>
</td></tr></table>
</body></html>`;
}

/** Sign in: the link, the code in large digits, the expiry, and "ignore it if you didn't ask". */
export function signInEmail({ link, code, minutes = 15 }) {
  const subject = `Your Brave Quest sign-in code: ${code}`;
  const text = [
    'Sign in to Brave Quest: Lighthouse',
    '',
    'Open this link to sign in:',
    link,
    '',
    `Or type this code in the game: ${code}`,
    '',
    `The link and the code expire in ${minutes} minutes and work once.`,
    "If you didn't ask for this, ignore this email: nothing happens without the link or the code.",
  ].join('\n');
  const html = page(
    'Sign in',
    `<h1 style="margin:0 0 16px 0;font-size:22px;font-weight:normal;">Sign in to the lighthouse</h1>
<p style="margin:0 0 20px 0;">Press the button to sign in on this device.</p>
<p style="margin:0 0 24px 0;"><a href="${esc(link)}" style="display:inline-block;background:${VIOLET};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:16px;">Sign in</a></p>
<p style="margin:0 0 8px 0;">Or type this code in the game:</p>
<p style="margin:0 0 24px 0;font-family:'Courier New',Courier,monospace;font-size:34px;letter-spacing:8px;font-weight:bold;color:${VIOLET};">${esc(code)}</p>
<p style="margin:0 0 8px 0;font-size:14px;">The link and the code expire in ${minutes} minutes and work once.</p>
<p style="margin:0;font-size:14px;">If you didn't ask for this, ignore this email: nothing happens without the link or the code.</p>`,
  );
  return { subject, text, html };
}

export function passwordChangedEmail() {
  const subject = 'Your Brave Quest password was changed';
  const text = [
    'The password for your Brave Quest: Lighthouse account was just set or changed.',
    'Every other device signed in to the account has been signed out.',
    '',
    "If this wasn't you, sign in with an emailed link from the game and set a new password.",
  ].join('\n');
  const html = page(
    'Password changed',
    `<h1 style="margin:0 0 16px 0;font-size:22px;font-weight:normal;">Password changed</h1>
<p style="margin:0 0 12px 0;">The password for your account was just set or changed. Every other device signed in to the account has been signed out.</p>
<p style="margin:0;font-size:14px;">If this wasn't you, sign in with an emailed link from the game and set a new password.</p>`,
  );
  return { subject, text, html };
}

export function accountDeletedEmail() {
  const subject = 'Your Brave Quest account was deleted';
  const text = [
    'Your Brave Quest: Lighthouse account has been deleted, with its save slots and its board record.',
    '',
    'You can keep playing as a guest, or make a new account any time by signing in with this address.',
  ].join('\n');
  const html = page(
    'Account deleted',
    `<h1 style="margin:0 0 16px 0;font-size:22px;font-weight:normal;">Account deleted</h1>
<p style="margin:0 0 12px 0;">Your account has been deleted, with its save slots and its board record.</p>
<p style="margin:0;font-size:14px;">You can keep playing as a guest, or make a new account any time by signing in with this address.</p>`,
  );
  return { subject, text, html };
}
