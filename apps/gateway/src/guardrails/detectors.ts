/**
 * Detectors for personal data in text (M16, ADR 035). Each finds candidates with a pattern and
 * keeps only those that pass the format's own check (Luhn for cards, Verhoeff for Aadhaar). Sources
 * and the reasons for each pattern are in docs/ROADMAP.md ("M16 plan") and PLAN-NOTES. Matched
 * values are never logged or stored: callers keep only types and counts.
 */

export const DETECTOR_TYPES = ['email', 'phone', 'card', 'aadhaar', 'pan'] as const;
export type DetectorType = (typeof DETECTOR_TYPES)[number];

/** What a masked value is replaced with. */
export const PLACEHOLDER: Record<DetectorType, string> = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  card: '[CARD]',
  aadhaar: '[AADHAAR]',
  pan: '[PAN]',
};

/** Names used in messages: a type, never a value. */
export const DETECTOR_LABEL: Record<DetectorType, string> = {
  email: 'an email address',
  phone: 'a phone number',
  card: 'a payment card number',
  aadhaar: 'an Aadhaar number',
  pan: 'a PAN',
};

/**
 * The longest text a match can span: an email address of 254 characters (the longest path SMTP
 * carries, RFC 5321 section 4.5.3.1.3, less its angle brackets) plus a margin. A stream holds back
 * this many characters so a value split across chunks is still found whole.
 */
export const MAX_MATCH_LENGTH = 256;

export interface Match {
  type: DetectorType;
  start: number;
  end: number;
}

/** Luhn (ISO/IEC 7812-1): doubling every second digit from the right, the sum is a multiple of 10. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// Verhoeff's check (dihedral group D5): multiplication, permutation and inverse tables.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Whether a digit string ends in a valid Verhoeff check digit. */
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]![P[i % 8]![d]!]!;
  }
  return c === 0;
}

/** The Verhoeff check digit for a digit string (tests build valid numbers with it). */
export function verhoeffDigit(digits: string): string {
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(digits.length - 1 - i) - 48;
    c = D[c]![P[(i + 1) % 8]![d]!]!;
  }
  return String(INV[c]);
}

interface Span {
  start: number;
  end: number;
}

interface Detector {
  type: DetectorType;
  find: (text: string) => Span[];
}

/** Spans of a pattern's matches. */
const byPattern =
  (pattern: RegExp) =>
  (text: string): Span[] =>
    [...text.matchAll(pattern)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

/** A run of digit groups joined by single spaces or hyphens, as card and Aadhaar numbers print. */
const DIGIT_RUN = /(?<![\d.])\d+(?:[ -]\d+)*(?!\d|\.\d)/g;

/**
 * Within each run of digit groups, the first window of whole groups (longest first) that `fits`,
 * then the same after it. A run longer than the number (say a card followed by a year) still
 * yields the number, and a window never starts or ends inside a group.
 */
function inDigitRuns(
  text: string,
  fits: (digits: string, groups: string[]) => boolean,
  /** Only the whole run may match (a number that is never followed by more groups). */
  wholeRunOnly = false,
): Span[] {
  const spans: Span[] = [];
  for (const run of text.matchAll(DIGIT_RUN)) {
    const groups: { digits: string; start: number; end: number }[] = [];
    for (const g of run[0].matchAll(/\d+/g)) {
      groups.push({
        digits: g[0],
        start: run.index + g.index,
        end: run.index + g.index + g[0].length,
      });
    }
    if (wholeRunOnly) {
      const digits = groups.map((g) => g.digits).join('');
      if (
        fits(
          digits,
          groups.map((g) => g.digits),
        )
      ) {
        spans.push({ start: groups[0]!.start, end: groups.at(-1)!.end });
      }
      continue;
    }
    let i = 0;
    while (i < groups.length) {
      let found = -1;
      for (let j = groups.length - 1; j >= i; j--) {
        const window = groups.slice(i, j + 1);
        const digits = window.map((g) => g.digits).join('');
        if (digits.length > 19) continue;
        if (digits.length < 12) break;
        if (
          fits(
            digits,
            window.map((g) => g.digits),
          )
        ) {
          found = j;
          break;
        }
      }
      if (found === -1) {
        i++;
        continue;
      }
      spans.push({ start: groups[i]!.start, end: groups[found]!.end });
      i = found + 1;
    }
  }
  return spans;
}

/**
 * In priority order: when two matches overlap, the earlier detector's wins (a 12-digit number
 * that passes Verhoeff is an Aadhaar number even if it also passes Luhn; +91 98765 43210 is a
 * phone number, never a card).
 */
const DETECTORS: Detector[] = [
  {
    // 12 digits, as one group or grouped 4-4-4 (as printed on the card), passing Verhoeff.
    type: 'aadhaar',
    find: (text) =>
      inDigitRuns(
        text,
        (digits, groups) =>
          digits.length === 12 &&
          (groups.length === 1 || (groups.length === 3 && groups.every((g) => g.length === 4))) &&
          verhoeffValid(digits),
        true,
      ),
  },
  {
    // Indian mobile: 10 digits from 6-9, after +91, 0091, 91 or 0; one space or hyphen allowed.
    type: 'phone',
    find: byPattern(/(?<![\d+])(?:(?:\+|00)91[ -]?|91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?!\d)/g),
  },
  {
    // E.164: + and 8 to 15 digits, no separators.
    type: 'phone',
    find: byPattern(/(?<![\w+])\+[1-9]\d{7,14}(?!\d)/g),
  },
  {
    // 12 to 19 digits, single spaces or hyphens allowed between groups, passing Luhn.
    type: 'card',
    find: (text) => inDigitRuns(text, (digits) => luhnValid(digits)),
  },
  {
    // Five letters, four digits, one letter, as one word.
    type: 'pan',
    find: byPattern(/(?<![A-Za-z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Za-z0-9])/g),
  },
  {
    // The HTML Standard's valid email address, with at least one dot in the domain.
    type: 'email',
    find: byPattern(
      /(?<![A-Za-z0-9.!#$%&'*+/=?^_`{|}~-])[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g,
    ),
  },
];

/** Every match of the enabled types in `text`, sorted by position, without overlaps. */
export function findMatches(text: string, enabled: ReadonlySet<DetectorType>): Match[] {
  if (enabled.size === 0 || text === '') return [];
  const accepted: Match[] = [];
  const overlaps = (start: number, end: number) =>
    accepted.some((m) => start < m.end && m.start < end);
  for (const detector of DETECTORS) {
    if (!enabled.has(detector.type)) continue;
    for (const { start, end } of detector.find(text)) {
      if (!overlaps(start, end)) accepted.push({ type: detector.type, start, end });
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

/** `text` with each match of a type in `mask` replaced by its placeholder. */
export function maskMatches(
  text: string,
  matches: readonly Match[],
  mask: ReadonlySet<DetectorType>,
): string {
  let out = '';
  let at = 0;
  for (const m of matches) {
    if (!mask.has(m.type)) continue;
    out += text.slice(at, m.start) + PLACEHOLDER[m.type];
    at = m.end;
  }
  return out + text.slice(at);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blocked words and phrases as one pattern: case-insensitive, whole words only (not inside a
 * longer word), any run of white space between a phrase's words. Null when there are none.
 */
export function blockedTermsPattern(terms: readonly string[]): RegExp | null {
  const parts = terms
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => t.split(/\s+/).map(escapeRegExp).join('\\s+'));
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${parts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
}
