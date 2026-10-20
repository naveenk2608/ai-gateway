/**
 * Analytics rollups (ADR 015): the worker keeps per-minute, per-hour and per-day totals with
 * latency histograms, and the admin API answers from them instead of scanning request history.
 */

/**
 * Inclusive upper bounds, in milliseconds, of the latency and time-to-first-token histogram
 * buckets. One more bucket holds everything above the last bound. The same list is in
 * `rollup_bucket_bounds()` (db/migrations/0004); a test keeps the two equal.
 */
export const LATENCY_BUCKET_BOUNDS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000,
] as const;

/** Number of histogram buckets: one per bound plus the overflow bucket. */
export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_BOUNDS_MS.length + 1;

/** The bucket a duration falls in, 0-based: bucket i holds (bound[i-1], bound[i]]. */
export function latencyBucketIndex(ms: number): number {
  const index = LATENCY_BUCKET_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? LATENCY_BUCKET_BOUNDS_MS.length : index;
}

/**
 * An approximate percentile (q in [0, 1]) from histogram counts, interpolating linearly inside
 * the bucket that holds it. Values in the overflow bucket are reported as the last bound, so the
 * result is a lower bound there. Null when the histogram is empty.
 */
export function percentileFromBuckets(buckets: readonly number[], q: number): number | null {
  if (q < 0 || q > 1) throw new RangeError(`percentile out of range: ${q}`);
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;
  const rank = q * total;
  let below = 0;
  for (let i = 0; i < buckets.length; i++) {
    const count = buckets[i] ?? 0;
    if (count > 0 && below + count >= rank) {
      const lower = i === 0 ? 0 : (LATENCY_BUCKET_BOUNDS_MS[i - 1] ?? 0);
      const upper = LATENCY_BUCKET_BOUNDS_MS[i];
      if (upper === undefined) return lower;
      return Math.round(lower + ((upper - lower) * (rank - below)) / count);
    }
    below += count;
  }
  return LATENCY_BUCKET_BOUNDS_MS.at(-1) ?? null;
}

/** Element-wise sum of histograms that may differ in length (an empty one counts as zeros). */
export function addBuckets(a: readonly number[], b: readonly number[]): number[] {
  const length = Math.max(a.length, b.length);
  return Array.from({ length }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
}

export type RollupGranularity = 'minute' | 'hour' | 'day';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The time ranges the analytics API supports, and how each is read. */
const RANGES = {
  '1h': { lengthMs: HOUR_MS, granularity: 'minute', stepMs: MINUTE_MS },
  '24h': { lengthMs: DAY_MS, granularity: 'minute', stepMs: 15 * MINUTE_MS },
  '7d': { lengthMs: 7 * DAY_MS, granularity: 'hour', stepMs: HOUR_MS },
  '30d': { lengthMs: 30 * DAY_MS, granularity: 'day', stepMs: DAY_MS },
} as const satisfies Record<
  string,
  { lengthMs: number; granularity: RollupGranularity; stepMs: number }
>;

export type AnalyticsRange = keyof typeof RANGES;
export const ANALYTICS_RANGES = Object.keys(RANGES) as AnalyticsRange[];

export function isAnalyticsRange(value: string): value is AnalyticsRange {
  return Object.hasOwn(RANGES, value);
}

export interface RangeWindow {
  range: AnalyticsRange;
  /** The rollup table the range reads. */
  granularity: RollupGranularity;
  /** Width of one point of a time series. */
  stepMs: number;
  /** Start (inclusive) and end (exclusive), aligned to the step, in ms since the epoch (UTC). */
  from: number;
  to: number;
}

/**
 * The window a range covers at `now`: it ends with the step that contains `now` and spans the
 * range's length, so 1 h is 60 minute points, 24 h 96 quarter-hours, 7 d 168 hours and 30 d 30
 * UTC days (today included).
 */
export function rangeWindow(range: AnalyticsRange, now: number): RangeWindow {
  const { lengthMs, granularity, stepMs } = RANGES[range];
  const to = Math.floor(now / stepMs) * stepMs + stepMs;
  return { range, granularity, stepMs, from: to - lengthMs, to };
}

/** The start of every series point in a window, oldest first. */
export function seriesStarts(window: Pick<RangeWindow, 'from' | 'to' | 'stepMs'>): number[] {
  const starts: number[] = [];
  for (let at = window.from; at < window.to; at += window.stepMs) starts.push(at);
  return starts;
}
