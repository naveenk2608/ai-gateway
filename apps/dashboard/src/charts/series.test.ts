import { describe, expect, it } from 'vitest';
import { formatStep } from '../format.js';
import { errorRates, foldShares, shareOfAdmitted } from './series.js';
import { sparklinePath } from './Sparkline.js';

const point = (requests: number, failed: number, rejected: number) => ({
  requests,
  failed,
  rejected,
});

describe('errorRates', () => {
  it('divides failed by admitted (requests minus rejected) per interval', () => {
    expect(errorRates([point(10, 1, 0), point(12, 3, 2), point(4, 0, 0)])).toEqual([0.1, 0.3, 0]);
  });

  it('leaves a gap (null) for an interval that admitted nothing, not 0% or NaN', () => {
    const rates = errorRates([point(5, 1, 0), point(0, 0, 0), point(3, 0, 3), point(2, 1, 0)]);
    expect(rates).toEqual([0.2, null, null, 0.5]);
    expect(rates.some((r) => Number.isNaN(r))).toBe(false);
  });

  it('is all gaps when no interval admitted a request', () => {
    expect(errorRates([point(0, 0, 0), point(4, 0, 4)])).toEqual([null, null]);
  });
});

describe('shareOfAdmitted', () => {
  it('is a share of admitted requests, and null when nothing was admitted', () => {
    expect(shareOfAdmitted(5, { requests: 120, rejected: 10 })).toBeCloseTo(5 / 110);
    expect(shareOfAdmitted(0, { requests: 7, rejected: 7 })).toBeNull();
    expect(shareOfAdmitted(0, { requests: 0, rejected: 0 })).toBeNull();
  });
});

describe('foldShares', () => {
  const part = (key: string, value: number) => ({ key, label: key, value });

  it('keeps every part, largest first, when they fit and add up to the total', () => {
    expect(foldShares([part('a', 1), part('b', 3)], 4, 5).map((s) => s.key)).toEqual(['b', 'a']);
  });

  it('folds the smallest parts into one Other slice holding the rest of the total', () => {
    const parts = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) => part(key, 60 - i * 10));
    const shares = foldShares(parts, 210, 5);
    expect(shares.map((s) => s.key)).toEqual(['a', 'b', 'c', 'd', 'other']);
    expect(shares.at(-1)).toEqual({ key: 'other', label: 'Other', value: 30, other: true });
    expect(shares.reduce((sum, s) => sum + s.value, 0)).toBe(210);
  });

  it('adds Other for spend the breakdown left out, so the slices add up to the total', () => {
    const shares = foldShares([part('a', 5), part('b', 3)], 10, 5);
    expect(shares.map((s) => [s.key, s.value])).toEqual([
      ['a', 5],
      ['b', 3],
      ['other', 2],
    ]);
  });

  it('drops parts worth nothing', () => {
    expect(foldShares([part('a', 2), part('free', 0)], 2, 5).map((s) => s.key)).toEqual(['a']);
  });
});

describe('sparklinePath', () => {
  it('draws one segment from zero to the largest value', () => {
    expect(sparklinePath([0, 5, 10])).toBe('M0.00 30.00L50.00 16.00L100.00 2.00');
  });

  it('breaks the line at a null point instead of drawing it at zero', () => {
    const path = sparklinePath([0.2, 0.4, null, 0.4]);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).toBe('M0.00 16.00L33.33 2.00M100.00 2.00h0');
  });

  it('draws nothing for a series with no measured point', () => {
    expect(sparklinePath([null, null])).toBe('');
    expect(sparklinePath([])).toBe('');
  });

  it('keeps an all-zero series on the baseline', () => {
    expect(sparklinePath([0, 0])).toBe('M0.00 30.00L100.00 30.00');
  });
});

describe('formatStep', () => {
  it('names the interval of each range', () => {
    expect(formatStep(60)).toBe('minute');
    expect(formatStep(900)).toBe('15 min');
    expect(formatStep(3_600)).toBe('hour');
    expect(formatStep(86_400)).toBe('day');
  });
});
