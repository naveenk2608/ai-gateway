import { describe, expect, it } from 'vitest';
import { budgetPeriodAt } from './budget.js';
import { estimatePromptTokens, estimateTextTokens } from './tokens.js';

describe('estimateTextTokens', () => {
  it('counts nothing for empty text', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('   ')).toBe(0);
  });

  it('charges a token per word up to five letters, more for longer words', () => {
    expect(estimateTextTokens('Say hello')).toBe(2);
    expect(estimateTextTokens('deterministic')).toBe(3);
  });

  it('splits numbers into groups of three digits and punctuation into pairs', () => {
    expect(estimateTextTokens('1234567')).toBe(3);
    expect(estimateTextTokens('...')).toBe(2);
    expect(estimateTextTokens('Hi!')).toBe(2);
  });

  it('counts each run of newlines once', () => {
    expect(estimateTextTokens('a\n\nb')).toBe(3);
  });

  it('charges scripts written without spaces per character, counting code points', () => {
    expect(estimateTextTokens('日本語のテキスト')).toBe(8);
    expect(estimateTextTokens('😀😀')).toBe(1);
  });

  it('stays at or above the observed count for ordinary English', () => {
    // 10 tokens with OpenAI's o200k tokenizer.
    expect(
      estimateTextTokens('The quick brown fox jumps over the lazy dog.'),
    ).toBeGreaterThanOrEqual(10);
  });
});

describe('estimatePromptTokens', () => {
  it('adds per-message framing and reply priming', () => {
    expect(estimatePromptTokens([])).toBe(3);
    expect(estimatePromptTokens([{ text: 'Say hello' }])).toBe(3 + 3 + 2);
    expect(estimatePromptTokens([{ text: 'Hi', name: 'bob' }])).toBe(3 + 3 + 1 + 1 + 1);
  });
});

describe('budgetPeriodAt', () => {
  it('is the UTC calendar month', () => {
    const period = budgetPeriodAt(Date.UTC(2026, 9, 20, 12));
    expect(period).toEqual({
      key: '2026-10',
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 10, 1),
    });
  });

  it('rolls over at the year end and keeps the boundary in the new month', () => {
    expect(budgetPeriodAt(Date.UTC(2026, 11, 31, 23, 59, 59, 999)).key).toBe('2026-12');
    expect(budgetPeriodAt(Date.UTC(2027, 0, 1)).key).toBe('2027-01');
    expect(budgetPeriodAt(Date.UTC(2026, 11, 15)).end).toBe(Date.UTC(2027, 0, 1));
  });
});
