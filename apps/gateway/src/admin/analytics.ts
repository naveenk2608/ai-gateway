import {
  ANALYTICS_RANGES,
  isAnalyticsRange,
  percentileFromBuckets,
  rangeWindow,
  seriesStarts,
  type RangeWindow,
} from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { FastifyRequest } from 'fastify';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { currentUser, projectNotFound } from './access.js';

/**
 * Shared pieces of the analytics API (ADR 015): the query every section accepts, the projects a
 * caller may see, rollup queries and the metrics computed from rollup sums.
 */

export const requestStatusSchema = z.enum(['success', 'error', 'canceled', 'rejected']);

export const analyticsQuerySchema = z.object({
  range: z
    .string()
    .max(10)
    .default('24h')
    .describe(`One of ${ANALYTICS_RANGES.join(', ')}.`),
  projectId: z
    .uuid()
    .optional()
    .describe('Only this project; default: every project of the caller.'),
  apiKeyId: z.uuid().optional(),
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(256).optional(),
  status: requestStatusSchema.optional(),
});
export type AnalyticsQuery = z.output<typeof analyticsQuerySchema>;
export type Filters = Pick<AnalyticsQuery, 'apiKeyId' | 'provider' | 'model' | 'status'>;

export const windowSchema = z.object({
  range: z.string(),
  /** Start (inclusive) and end (exclusive) of the window, aligned to `stepSeconds`. */
  from: z.string(),
  to: z.string(),
  /** The rollup table read: minute for 1h and 24h, hour for 7d, day for 30d. */
  granularity: z.enum(['minute', 'hour', 'day']),
  stepSeconds: z.number(),
});

/** Parses `range`; an unsupported one is a 400 that lists the supported ranges. */
export function windowFor(range: string, now: number): RangeWindow {
  if (!isAnalyticsRange(range)) {
    throw new GatewayError(
      'unsupported_range',
      `Unsupported range "${range}". Supported ranges: ${ANALYTICS_RANGES.join(', ')}.`,
      { httpStatus: 400, param: 'range' },
    );
  }
  return rangeWindow(range, now);
}

export function describeWindow(window: RangeWindow): z.output<typeof windowSchema> {
  return {
    range: window.range,
    from: new Date(window.from).toISOString(),
    to: new Date(window.to).toISOString(),
    granularity: window.granularity,
    stepSeconds: window.stepMs / 1000,
  };
}

/**
 * The projects the caller may see: every project they belong to (any role), or the one asked for.
 * Asking for a project they do not belong to is a 404, as for every other project resource.
 */
export async function projectScope(
  db: Db,
  request: FastifyRequest,
  projectId: string | undefined,
): Promise<string[]> {
  const user = currentUser(request);
  let query = db.selectFrom('project_members').select('project_id').where('user_id', '=', user.id);
  if (projectId) query = query.where('project_id', '=', projectId);
  const rows = await query.execute();
  if (projectId && rows.length === 0) throw projectNotFound();
  return rows.map((row) => row.project_id);
}

/** `column IN (scope)`, or false for an empty scope (a caller with no projects sees nothing). */
export function inScope(column: string, scope: string[]): RawBuilder<boolean> {
  return scope.length === 0
    ? sql<boolean>`false`
    : sql<boolean>`${sql.ref(column)} = any(${scope}::uuid[])`;
}

type RollupTable = 'usage_rollups_minute' | 'usage_rollups_hour' | 'usage_rollups_day';

/** Rollup rows in the window, scope and filters. All three tables have the same columns. */
export function rollups(db: Db, window: RangeWindow, scope: string[], filters: Filters) {
  const table = `usage_rollups_${window.granularity}` satisfies RollupTable;
  let query = db
    // Typed as the minute table: the three share one shape.
    .selectFrom(table as 'usage_rollups_minute')
    .where('bucket_start', '>=', new Date(window.from))
    .where('bucket_start', '<', new Date(window.to))
    .where(inScope('project_id', scope));
  if (filters.apiKeyId) query = query.where('api_key_id', '=', filters.apiKeyId);
  if (filters.provider) query = query.where('provider', '=', filters.provider);
  if (filters.model) query = query.where('model', '=', filters.model);
  if (filters.status) query = query.where('status', '=', filters.status);
  return query;
}

export const sumOf = (column: string) => sql<number>`coalesce(sum(${sql.ref(column)}), 0)::bigint`;
export const sumWithStatus = (status: string) =>
  sql<number>`coalesce(sum(requests) filter (where status = ${status}), 0)::bigint`;

/** The sums every metrics object is computed from. */
export function metricSums() {
  return [
    sumOf('requests').as('requests'),
    sumWithStatus('success').as('succeeded'),
    sumWithStatus('error').as('failed'),
    sumWithStatus('rejected').as('rejected'),
    sumWithStatus('canceled').as('canceled'),
    sumOf('cache_hits').as('cache_hits'),
    sumOf('prompt_tokens').as('prompt_tokens'),
    sumOf('completion_tokens').as('completion_tokens'),
    sumOf('total_tokens').as('total_tokens'),
    sumOf('cost_micro_usd').as('cost_micro_usd'),
    sumOf('attempts').as('attempts'),
    sumOf('retries').as('retries'),
    sumOf('fallbacks').as('fallbacks'),
    sumOf('latency_ms_sum').as('latency_ms_sum'),
    sql<number[]>`bucket_sum(latency_buckets)`.as('latency_buckets'),
    sumOf('ttft_count').as('ttft_count'),
    sumOf('ttft_ms_sum').as('ttft_ms_sum'),
    sql<number[]>`bucket_sum(ttft_buckets)`.as('ttft_buckets'),
    sumOf('throughput_tokens').as('throughput_tokens'),
    sumOf('throughput_ms').as('throughput_ms'),
  ] as const;
}

export interface MetricSums {
  requests: number;
  succeeded: number;
  failed: number;
  rejected: number;
  canceled: number;
  cache_hits: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_micro_usd: number;
  attempts: number;
  retries: number;
  fallbacks: number;
  latency_ms_sum: number;
  latency_buckets: number[];
  ttft_count: number;
  ttft_ms_sum: number;
  ttft_buckets: number[];
  throughput_tokens: number;
  throughput_ms: number;
}

const latencySchema = z
  .object({
    avg: z.number().nullable(),
    p50: z.number().nullable(),
    p95: z.number().nullable(),
    p99: z.number().nullable(),
  })
  .describe(
    'Milliseconds. Percentiles are approximate: interpolated within histogram buckets ' +
      '(10 ms ... 120 s); values above 120 s are reported as 120 s. Null without data.',
  );

export const metricsSchema = z.object({
  requests: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  rejected: z.number(),
  canceled: z.number(),
  cacheHits: z.number(),
  promptTokens: z.number(),
  completionTokens: z.number(),
  totalTokens: z.number(),
  costMicroUsd: z.number(),
  /** Upstream attempts; retries stayed on a deployment, fallbacks moved to another. */
  attempts: z.number(),
  retries: z.number(),
  fallbacks: z.number(),
  errorRate: z
    .number()
    .nullable()
    .describe('Failed share of admitted (not rejected) requests; null without any.'),
  fallbackRate: z.number().nullable().describe('Fallbacks per admitted request; null without any.'),
  latencyMs: latencySchema,
  ttftMs: latencySchema.describe('Time to first token of streamed requests; see latencyMs.'),
  outputTokensPerSecond: z
    .number()
    .nullable()
    .describe(
      'Completion tokens of successful requests over the time spent producing them (after the ' +
        'first token when streamed); null without data.',
    ),
});
export type Metrics = z.output<typeof metricsSchema>;

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

function latency(sum: number, count: number, buckets: number[]) {
  return {
    avg: count > 0 ? Math.round(sum / count) : null,
    p50: percentileFromBuckets(buckets, 0.5),
    p95: percentileFromBuckets(buckets, 0.95),
    p99: percentileFromBuckets(buckets, 0.99),
  };
}

/** Metrics from rollup sums (a row of metricSums()). */
export function toMetrics(s: MetricSums): Metrics {
  const admitted = s.requests - s.rejected;
  return {
    requests: s.requests,
    succeeded: s.succeeded,
    failed: s.failed,
    rejected: s.rejected,
    canceled: s.canceled,
    cacheHits: s.cache_hits,
    promptTokens: s.prompt_tokens,
    completionTokens: s.completion_tokens,
    totalTokens: s.total_tokens,
    costMicroUsd: s.cost_micro_usd,
    attempts: s.attempts,
    retries: s.retries,
    fallbacks: s.fallbacks,
    errorRate: ratio(s.failed, admitted),
    fallbackRate: ratio(s.fallbacks, admitted),
    latencyMs: latency(s.latency_ms_sum, s.requests, s.latency_buckets),
    ttftMs: latency(s.ttft_ms_sum, s.ttft_count, s.ttft_buckets),
    outputTokensPerSecond:
      s.throughput_ms > 0
        ? Math.round((s.throughput_tokens * 1000 * 10) / s.throughput_ms) / 10
        : null,
  };
}

/** The series bucket of a rollup row: its start, binned to the window's step. */
export function seriesBucket(window: RangeWindow) {
  return sql<Date>`date_bin(${`${window.stepMs / 1000} seconds`}::interval, bucket_start, ${new Date(0)}::timestamptz)`;
}

/**
 * One point per step of the window, oldest first; steps with no rows get `empty()`. Bounded by
 * the window (at most 168 points), so it never grows with history.
 */
export function fillSeries<T>(
  window: RangeWindow,
  rows: { start: Date; values: T }[],
  empty: () => T,
): ({ start: string } & T)[] {
  const byStart = new Map(rows.map((row) => [row.start.getTime(), row.values]));
  return seriesStarts(window).map((at) => ({
    start: new Date(at).toISOString(),
    ...(byStart.get(at) ?? empty()),
  }));
}
