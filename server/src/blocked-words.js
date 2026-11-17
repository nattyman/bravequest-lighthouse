// Words a board name may not contain. Matched as substrings of a normalised form of the name
// (lower case, no spaces/_/-/', common digit-for-letter swaps undone, repeated letters squeezed),
// so keep entries long enough not to catch ordinary names ("ass" would block "Cassandra").
// Extend the list here; entries are plain lower-case letters.

export const BLOCKED_WORDS = [
  'fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'twat', 'wank', 'pussy', 'asshole', 'bastard',
  'nigger', 'nigga', 'faggot', 'retard', 'kike', 'nazi', 'hitler', 'penis', 'vagina', 'dildo',
  'porn', 'jizz', 'boob', 'tits',
];

// Digits and look-alikes put back to the letters they usually stand in for. '1' can be i or l,
// so both readings are checked.
const SWAPS = { 0: 'o', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', $: 's', '@': 'a', '!': 'i' };

const squeeze = (s) => s.replace(/(.)\1+/g, '$1');

/** The forms of a name that are checked against the list. */
export function normalisedForms(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[\s_'\-.]+/g, '')
    .replace(/[0345-9$@!]/g, (c) => SWAPS[c]);
  const forms = new Set();
  for (const one of ['i', 'l']) {
    const f = base.replace(/1/g, one).replace(/[^a-z]/g, '');
    forms.add(f);
    forms.add(squeeze(f));
  }
  return [...forms];
}

const SQUEEZED = BLOCKED_WORDS.map(squeeze);

export function isBlockedName(name) {
  const forms = normalisedForms(name);
  return forms.some((f) => BLOCKED_WORDS.some((w) => f.includes(w)) || SQUEEZED.some((w) => f.includes(w)));
}
