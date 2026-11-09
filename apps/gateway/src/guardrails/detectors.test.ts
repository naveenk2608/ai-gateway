import { describe, expect, it } from 'vitest';
import {
  blockedTermsPattern,
  DETECTOR_TYPES,
  findMatches,
  luhnValid,
  maskMatches,
  verhoeffDigit,
  verhoeffValid,
  type DetectorType,
} from './detectors.js';

const ALL = new Set(DETECTOR_TYPES);
/** The types found in `text`, with the text each covers. */
const found = (text: string, types: ReadonlySet<DetectorType> = ALL) =>
  findMatches(text, types).map((m) => [m.type, text.slice(m.start, m.end)]);

/** A valid Aadhaar-shaped number: 11 digits and their Verhoeff check digit. */
const aadhaar = (base: string) => base + verhoeffDigit(base);

describe('checksums', () => {
  it('Luhn accepts known test card numbers and refuses a changed digit', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('5555555555554444')).toBe(true);
    expect(luhnValid('378282246310005')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('Verhoeff accepts its check digit and catches a changed digit or a swap', () => {
    // Verhoeff's published example: 236 has check digit 3.
    expect(verhoeffDigit('236')).toBe('3');
    expect(verhoeffValid('2363')).toBe(true);
    const number = aadhaar('23456789012');
    expect(verhoeffValid(number)).toBe(true);
    expect(verhoeffValid(number.slice(0, 11) + String((Number(number[11]) + 1) % 10))).toBe(false);
    expect(verhoeffValid(number[1]! + number[0]! + number.slice(2))).toBe(false);
  });
});

describe('findMatches', () => {
  it('finds email addresses with a dot in the domain', () => {
    expect(found('Write to jane.doe+news@mail.example.co.in today')).toEqual([
      ['email', 'jane.doe+news@mail.example.co.in'],
    ]);
    expect(found('user@localhost and a@b')).toEqual([]);
  });

  it('finds Indian mobile numbers and E.164 numbers', () => {
    expect(found('Call +91 98765 43210, 9876543210, 09876543210 or 0091-9876543210')).toEqual([
      ['phone', '+91 98765 43210'],
      ['phone', '9876543210'],
      ['phone', '09876543210'],
      ['phone', '0091-9876543210'],
    ]);
    expect(found('US: +14155552671')).toEqual([['phone', '+14155552671']]);
    // Mobile series start at 6; short international numbers are not matched.
    expect(found('5876543210 and +1234567')).toEqual([]);
  });

  it('finds card numbers that pass Luhn, grouped or not, and only those', () => {
    expect(found('Card 4111 1111 1111 1111 exp 12/27')).toEqual([['card', '4111 1111 1111 1111']]);
    expect(found('4111-1111-1111-1111')).toEqual([['card', '4111-1111-1111-1111']]);
    expect(found('Amex 378282246310005.')).toEqual([['card', '378282246310005']]);
    expect(found('Card 4111 1111 1111 1112')).toEqual([]);
    // A card followed by more digit groups is still found.
    expect(found('4111 1111 1111 1111 2025')).toEqual([['card', '4111 1111 1111 1111']]);
    // Decimals and long reference numbers are not cards.
    expect(found('Total 4111111111111111.50 and ref 41111111111111110000')).toEqual([]);
  });

  it('finds Aadhaar numbers that pass Verhoeff, as one group or 4-4-4, and only those', () => {
    const n = aadhaar('23456789012');
    const spaced = `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
    expect(found(`Aadhaar ${spaced}`)).toEqual([['aadhaar', spaced]]);
    expect(found(`Aadhaar ${n}`)).toEqual([['aadhaar', n]]);
    const wrong = n.slice(0, 11) + String((Number(n[11]) + 1) % 10);
    expect(found(`Aadhaar ${wrong}`, new Set(['aadhaar']))).toEqual([]);
    // Inside a longer run of groups it is not an Aadhaar number.
    expect(found(`${spaced} 1234`, new Set(['aadhaar']))).toEqual([]);
  });

  it('finds PANs as one upper-case word', () => {
    expect(found('PAN: ABCPE1234F.')).toEqual([['pan', 'ABCPE1234F']]);
    expect(found('abcpe1234f ABCPE1234FG XABCPE1234F')).toEqual([]);
  });

  it('only looks for the types asked for', () => {
    expect(found('jane@example.com 9876543210', new Set(['phone']))).toEqual([
      ['phone', '9876543210'],
    ]);
  });

  it('masks the types to mask with typed placeholders', () => {
    const text = 'Mail jane@example.com or call 9876543210';
    const matches = findMatches(text, ALL);
    expect(maskMatches(text, matches, new Set(['email']))).toBe('Mail [EMAIL] or call 9876543210');
    expect(maskMatches(text, matches, ALL)).toBe('Mail [EMAIL] or call [PHONE]');
  });
});

describe('blockedTermsPattern', () => {
  it('matches whole words and phrases, ignoring case and spacing', () => {
    const pattern = blockedTermsPattern(['secret plan', 'Foo', 'c++'])!;
    const count = (text: string) => [...text.matchAll(pattern)].length;
    expect(count('The SECRET   plan is foo, FOO!')).toBe(3);
    expect(count('food, foobar, secretplan')).toBe(0);
    expect(count('I like c++ a lot')).toBe(1);
    expect(blockedTermsPattern(['  ', ''])).toBeNull();
  });
});
