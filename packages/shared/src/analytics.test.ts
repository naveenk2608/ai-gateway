import { describe, expect, it } from 'vitest';
import {
  addBuckets,
  ANALYTICS_RANGES,
  isAnalyticsRange,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  percentileFromBuckets,
  rangeWindow,
  seriesStarts,
} from './analytics.js';

/** A histogram with `count` values in the bucket that holds `ms`. */
function histogram(entries: [ms: number, count: number][]): number[] {
  const buckets = new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
  for (const [ms, count] of entries) buckets[latencyBucketIndex(ms)]! += count;
  return buckets;
}

describe('latency buckets', () => {
  it('puts each bound in its own bucket and larger values in the overflow bucket', () => {
    expect(latencyBucketIndex(0)).toBe(0);
    expect(latencyBucketIndex(10)).toBe(0);
    expect(latencyBucketIndex(11)).toBe(1);
    expect(latencyBucketIndex(1_000)).toBe(LATENCY_BUCKET_BOUNDS_MS.indexOf(1_000));
    expect(latencyBucketIndex(120_000)).toBe(LATENCY_BUCKET_BOUNDS_MS.length - 1);
    expect(latencyBucketIndex(120_001)).toBe(LATENCY_BUCKET_COUNT - 1);
  });

  it('has strictly increasing bounds', () => {
    for (let i = 1; i < LATENCY_BUCKET_BOUNDS_MS.length; i++) {
      expect(LATENCY_BUCKET_BOUNDS_MS[i]).toBeGreaterThan(LATENCY_BUCKET_BOUNDS_MS[i - 1]!);
    }
  });

  it('adds histograms of different lengths', () => {
    expect(addBuckets([1, 2], [3, 4, 5])).toEqual([4, 6, 5]);
    expect(addBuckets([], [])).toEqual([]);
  });
});

describe('percentileFromBuckets', () => {
  it('is null for an empty histogram', () => {
    expect(percentileFromBuckets([], 0.5)).toBeNull();
    expect(percentileFromBuckets(histogram([]), 0.99)).toBeNull();
  });

  it('interpolates inside the bucket that holds the rank', () => {
    // 100 values in (100, 250]: the median sits half way through that bucket.
    const buckets = histogram([[200, 100]]);
    expect(percentileFromBuckets(buckets, 0.5)).toBe(175);
    expect(percentileFromBuckets(buckets, 1)).toBe(250);
  });

  it('stays within the bounds of the bucket that holds the true value', () => {
    const values = [5, 12, 40, 80, 90, 300, 700, 900, 4_000, 20_000];
    const buckets = histogram(values.map((ms) => [ms, 1]));
    for (const q of [0.5, 0.95, 0.99]) {
      const exact = values[Math.ceil(q * values.length) - 1]!;
      const index = latencyBucketIndex(exact);
      const approx = percentileFromBuckets(buckets, q)!;
      expect(approx).toBeGreaterThanOrEqual(index === 0 ? 0 : LATENCY_BUCKET_BOUNDS_MS[index - 1]!);
      expect(approx).toBeLessThanOrEqual(LATENCY_BUCKET_BOUNDS_MS[index]!);
    }
  });

  it('reports the overflow bucket as the last bound', () => {
    expect(percentileFromBuckets(histogram([[500_000, 3]]), 0.5)).toBe(120_000);
  });

  it('rejects a percentile outside [0, 1]', () => {
    expect(() => percentileFromBuckets([1], 1.5)).toThrow(RangeError);
  });
});

describe('analytics ranges', () => {
  const now = Date.parse('2026-10-21T13:47:12.345Z');

  it('accepts only the supported ranges', () => {
    expect(ANALYTICS_RANGES).toEqual(['1h', '24h', '7d', '30d']);
    expect(isAnalyticsRange('24h')).toBe(true);
    expect(isAnalyticsRange('2h')).toBe(false);
    expect(isAnalyticsRange('toString')).toBe(false);
  });

  it('reads minute rollups for 1 h and 24 h, hourly for 7 d and daily for 30 d', () => {
    expect(rangeWindow('1h', now)).toMatchObject({ granularity: 'minute', stepMs: 60_000 });
    expect(rangeWindow('24h', now)).toMatchObject({ granularity: 'minute', stepMs: 900_000 });
    expect(rangeWindow('7d', now)).toMatchObject({ granularity: 'hour', stepMs: 3_600_000 });
    expect(rangeWindow('30d', now)).toMatchObject({ granularity: 'day', stepMs: 86_400_000 });
  });

  it('ends with the step that contains now', () => {
    const hour = rangeWindow('1h', now);
    expect(new Date(hour.to).toISOString()).toBe('2026-10-21T13:48:00.000Z');
    expect(new Date(hour.from).toISOString()).toBe('2026-10-21T12:48:00.000Z');
    const month = rangeWindow('30d', now);
    expect(new Date(month.to).toISOString()).toBe('2026-10-22T00:00:00.000Z');
    expect(new Date(month.from).toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });

  it('has one series point per step', () => {
    expect(seriesStarts(rangeWindow('1h', now))).toHaveLength(60);
    expect(seriesStarts(rangeWindow('24h', now))).toHaveLength(96);
    expect(seriesStarts(rangeWindow('7d', now))).toHaveLength(168);
    expect(seriesStarts(rangeWindow('30d', now))).toHaveLength(30);
  });
});
