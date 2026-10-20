import { randomBytes } from 'node:crypto';
import {
  addBuckets,
  costMicroUsd,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_BUCKET_COUNT,
  latencyBucketIndex,
  uuidv7,
  type UsageEvent,
} from '@ai-gateway/shared';
import type { Db, RequestStatus } from '@ai-gateway/shared/node';
import fc from 'fast-check';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEvents } from '../src/ingest.js';
import { pruneRollups } from '../src/retention.js';
import { DEFAULT_MIGRATIONS_DIR } from '../src/worker.js';
import { captureLogger, connect, createProject } from './fixtures.js';
import { createDb, createPgPool, migrateDatabase } from '@ai-gateway/shared/node';

/** A provider model of its own with a price, so costs are exercised and no other test sees it. */
const pricedModel = `rollup-${randomBytes(3).toString('hex')}`;
const PRICE = { inputMicroUsdPerMTok: 1_500_000, outputMicroUsdPerMTok: 6_000_000 };

const { pool, db } = connect();

beforeAll(async () => {
  await db
    .insertInto('model_prices')
    .values({
      id: uuidv7(),
      provider: 'mock',
      model: pricedModel,
      input_micro_usd_per_mtok: PRICE.inputMicroUsdPerMTok,
      output_micro_usd_per_mtok: PRICE.outputMicroUsdPerMTok,
      effective_from: new Date('2020-01-01T00:00:00Z'),
    })
    .execute();
});

afterAll(async () => {
  await pool.end();
});

async function createKey(target: Db, projectId: string): Promise<string> {
  const id = uuidv7();
  await target
    .insertInto('api_keys')
    .values({
      id,
      project_id: projectId,
      key_id: randomBytes(8).toString('hex'),
      secret_hash: randomBytes(32),
      name: 'rollup-test',
    })
    .execute();
  return id;
}

/** The shape of one generated request, before it is tied to real projects and keys. */
interface Spec {
  offsetMs: number;
  project: number;
  key: number | null;
  model: 'm1' | 'm2';
  status: RequestStatus;
  errorCode: string | null;
  cacheHit: boolean;
  deployments: ('d1' | 'd2')[];
  usage: { promptTokens: number; completionTokens: number } | null;
  latencyMs: number;
  ttftMs: number | null;
}

const latencyArb = fc.oneof(
  fc.integer({ min: 0, max: 2_000 }),
  fc.constantFrom(...LATENCY_BUCKET_BOUNDS_MS, 120_001),
  fc.integer({ min: 0, max: 300_000 }),
);

const specArb: fc.Arbitrary<Spec> = fc
  .record({
    // Within the last day: minute rows are kept 25 h at least, even by other tests' consumers.
    offsetMs: fc.integer({ min: 0, max: 18 * 3_600_000 }),
    project: fc.integer({ min: 0, max: 1 }),
    key: fc.option(fc.integer({ min: 0, max: 1 })),
    model: fc.constantFrom('m1' as const, 'm2' as const),
    kind: fc.constantFrom('success', 'cache', 'error', 'canceled', 'rejected'),
    errorCode: fc.constantFrom('upstream_error', 'upstream_timeout', 'rpm_limit_exceeded'),
    deployments: fc.array(fc.constantFrom('d1' as const, 'd2' as const), {
      minLength: 1,
      maxLength: 4,
    }),
    usage: fc.option(
      fc.record({
        promptTokens: fc.integer({ min: 0, max: 50_000 }),
        completionTokens: fc.integer({ min: 0, max: 50_000 }),
      }),
    ),
    latencyMs: latencyArb,
    ttft: fc.option(fc.integer({ min: 0, max: 1_000_000 })),
  })
  .map(({ kind, ttft, ...s }): Spec => {
    const ttftMs = ttft === null ? null : Math.min(ttft, s.latencyMs);
    switch (kind) {
      case 'cache':
        return {
          ...s,
          status: 'success',
          errorCode: null,
          cacheHit: true,
          deployments: [],
          ttftMs,
        };
      case 'rejected':
        return {
          ...s,
          status: 'rejected',
          cacheHit: false,
          deployments: [],
          usage: null,
          ttftMs: null,
        };
      case 'canceled':
        return {
          ...s,
          status: 'canceled',
          errorCode: 'client_closed_request',
          cacheHit: false,
          ttftMs,
        };
      case 'error':
        return { ...s, status: 'error', cacheHit: false, ttftMs };
      default:
        return { ...s, status: 'success', errorCode: null, cacheHit: false, ttftMs };
    }
  });

function toEvent(spec: Spec, base: number, projects: string[], keys: string[]): UsageEvent {
  const start = base + spec.offsetMs;
  const end = start + spec.latencyMs;
  const attempts = spec.deployments.map((deployment, i) => ({
    id: uuidv7(start),
    attemptNumber: i + 1,
    deployment,
    provider: 'mock',
    providerModel: pricedModel,
    outcome: i === spec.deployments.length - 1 && spec.status === 'success' ? 'success' : 'error',
    upstreamStatus: null,
    routingPolicy: 'priority',
    routingReason: null,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(end).toISOString(),
    latencyMs: 0,
    ttftMs: null,
  }));
  const usage = spec.usage
    ? { ...spec.usage, totalTokens: spec.usage.promptTokens + spec.usage.completionTokens }
    : null;
  return {
    v: 1,
    type: 'request.completed',
    eventId: uuidv7(end),
    occurredAt: new Date(end).toISOString(),
    request: {
      id: uuidv7(start),
      projectId: projects[spec.project]!,
      apiKeyId: spec.key === null ? null : keys[spec.project * 2 + spec.key]!,
      model: spec.model,
      deployment: spec.deployments.at(-1) ?? null,
      stream: spec.ttftMs !== null,
      status: spec.status,
      httpStatus: spec.status === 'success' ? 200 : 500,
      errorCode: spec.errorCode,
      startedAt: new Date(start).toISOString(),
      completedAt: new Date(end).toISOString(),
      latencyMs: spec.latencyMs,
      ttftMs: spec.ttftMs,
    },
    attempts,
    usage,
    usageSource: usage ? 'reported' : 'missing',
    ...(spec.cacheHit ? { cacheHit: true } : {}),
  };
}

interface Totals {
  requests: number;
  cacheHits: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  attempts: number;
  retries: number;
  fallbacks: number;
  latencyMsSum: number;
  latencyBuckets: number[];
  ttftCount: number;
  ttftMsSum: number;
  ttftBuckets: number[];
  throughputTokens: number;
  throughputMs: number;
}

const zeroBuckets = () => new Array<number>(LATENCY_BUCKET_COUNT).fill(0);
const emptyTotals = (): Totals => ({
  requests: 0,
  cacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  attempts: 0,
  retries: 0,
  fallbacks: 0,
  latencyMsSum: 0,
  latencyBuckets: zeroBuckets(),
  ttftCount: 0,
  ttftMsSum: 0,
  ttftBuckets: zeroBuckets(),
  throughputTokens: 0,
  throughputMs: 0,
});

const TRUNC_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
type Granularity = keyof typeof TRUNC_MS;

/** The rollups worked out from the events alone: the oracle the database must match. */
function expectedRollups(events: UsageEvent[], granularity: Granularity): Map<string, Totals> {
  const rows = new Map<string, Totals>();
  for (const e of events) {
    const r = e.request;
    const last = e.attempts.at(-1);
    // A usage row exists when a provider was called or the cache answered (worker/ingest.ts).
    const hasUsage = last !== undefined || e.cacheHit === true;
    const usage = hasUsage ? e.usage : null;
    const bucket =
      Math.floor(Date.parse(r.startedAt) / TRUNC_MS[granularity]) * TRUNC_MS[granularity];
    const key = JSON.stringify([
      bucket,
      r.projectId,
      r.apiKeyId,
      r.model,
      r.deployment,
      last?.provider ?? null,
      r.status,
      r.errorCode,
    ]);
    const t = rows.get(key) ?? emptyTotals();
    t.requests += 1;
    t.cacheHits += e.cacheHit ? 1 : 0;
    t.promptTokens += usage?.promptTokens ?? 0;
    t.completionTokens += usage?.completionTokens ?? 0;
    t.totalTokens += usage?.totalTokens ?? 0;
    if (usage && last)
      t.costMicroUsd += costMicroUsd(usage.promptTokens, usage.completionTokens, PRICE);
    t.attempts += e.attempts.length;
    for (let i = 1; i < e.attempts.length; i++) {
      if (e.attempts[i]!.deployment === e.attempts[i - 1]!.deployment) t.retries += 1;
      else t.fallbacks += 1;
    }
    t.latencyMsSum += r.latencyMs;
    t.latencyBuckets[latencyBucketIndex(r.latencyMs)]! += 1;
    if (r.ttftMs !== null) {
      t.ttftCount += 1;
      t.ttftMsSum += r.ttftMs;
      t.ttftBuckets[latencyBucketIndex(r.ttftMs)]! += 1;
    }
    if (r.status === 'success' && usage && usage.completionTokens > 0) {
      t.throughputTokens += usage.completionTokens;
      t.throughputMs += Math.max(0, r.latencyMs - (r.ttftMs ?? 0));
    }
    rows.set(key, t);
  }
  return rows;
}

async function storedRollups(projects: string[], granularity: Granularity) {
  const rows = await db
    .selectFrom(`usage_rollups_${granularity}`)
    .selectAll()
    .where('project_id', 'in', projects)
    .execute();
  return new Map(
    rows.map((row): [string, Totals] => [
      JSON.stringify([
        row.bucket_start.getTime(),
        row.project_id,
        row.api_key_id,
        row.model,
        row.deployment,
        row.provider,
        row.status,
        row.error_code,
      ]),
      {
        requests: row.requests,
        cacheHits: row.cache_hits,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        costMicroUsd: row.cost_micro_usd,
        attempts: row.attempts,
        retries: row.retries,
        fallbacks: row.fallbacks,
        latencyMsSum: row.latency_ms_sum,
        latencyBuckets: addBuckets(zeroBuckets(), row.latency_buckets),
        ttftCount: row.ttft_count,
        ttftMsSum: row.ttft_ms_sum,
        ttftBuckets: addBuckets(zeroBuckets(), row.ttft_buckets),
        throughputTokens: row.throughput_tokens,
        throughputMs: row.throughput_ms,
      },
    ]),
  );
}

/** Totals straight from the raw records, with no rollup code involved. */
async function rawTotals(projects: string[]) {
  const totals = await db
    .selectFrom('request_records as r')
    .leftJoin('usage_events as u', 'u.request_id', 'r.id')
    .select([
      sql<number>`count(*)::int`.as('requests'),
      sql<number>`coalesce(sum(u.total_tokens), 0)::bigint`.as('tokens'),
      sql<number>`coalesce(sum(u.cost_micro_usd), 0)::bigint`.as('cost'),
      sql<number>`coalesce(sum(r.latency_ms), 0)::bigint`.as('latency'),
      sql<number>`count(*) filter (where r.cache_hit)::int`.as('cacheHits'),
    ])
    .where('r.project_id', 'in', projects)
    .executeTakeFirstOrThrow();
  const attempts = await db
    .selectFrom('provider_attempts as a')
    .innerJoin('request_records as r', 'r.id', 'a.request_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('r.project_id', 'in', projects)
    .executeTakeFirstOrThrow();
  return { ...totals, attempts: attempts.n };
}

async function ingest(events: UsageEvent[]) {
  await db.transaction().execute((trx) => ingestEvents(trx, events));
}

describe('analytics rollups', () => {
  it('keep the histogram bounds of the shared package', async () => {
    const { rows } = await sql<{
      bounds: number[];
    }>`SELECT rollup_bucket_bounds() AS bounds`.execute(db);
    expect(rows[0]?.bounds).toEqual([...LATENCY_BUCKET_BOUNDS_MS]);
    await fc.assert(
      fc.asyncProperty(fc.array(latencyArb, { minLength: 1, maxLength: 20 }), async (values) => {
        const { rows: hist } = await sql<{ h: number[] }>`
          SELECT histogram_one_hot(v) AS h FROM unnest(${values}::int[]) AS v`.execute(db);
        expect(hist.map((row) => row.h.indexOf(1))).toEqual(values.map(latencyBucketIndex));
      }),
      { numRuns: 20 },
    );
  });

  it('equal the raw records and the events for any dataset, batching and re-delivery', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(specArb, { minLength: 1, maxLength: 40 }),
        fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 10 }),
        fc.array(fc.nat(), { maxLength: 10 }),
        async (specs, batchSizes, redeliveries) => {
          const projects = [await createProject(db), await createProject(db)];
          const keys: string[] = [];
          for (const project of projects) {
            keys.push(await createKey(db, project), await createKey(db, project));
          }
          const base = Date.now() - 20 * 3_600_000;
          const events = specs.map((spec) => toEvent(spec, base, projects, keys));

          // Ingest in batches of varying size; some events are delivered again in later batches.
          const queue = [...events];
          for (const n of redeliveries) queue.push(events[n % events.length]!);
          for (let i = 0, b = 0; i < queue.length; b++) {
            const size = batchSizes[b % batchSizes.length]!;
            await ingest(queue.slice(i, i + size));
            i += size;
          }

          for (const granularity of ['minute', 'hour', 'day'] as const) {
            const stored = await storedRollups(projects, granularity);
            expect(stored).toEqual(expectedRollups(events, granularity));
          }

          const raw = await rawTotals(projects);
          const [day] = await db
            .selectFrom('usage_rollups_day')
            .select([
              sql<number>`sum(requests)::int`.as('requests'),
              sql<number>`sum(total_tokens)::bigint`.as('tokens'),
              sql<number>`sum(cost_micro_usd)::bigint`.as('cost'),
              sql<number>`sum(latency_ms_sum)::bigint`.as('latency'),
              sql<number>`sum(cache_hits)::int`.as('cacheHits'),
              sql<number>`sum(attempts)::int`.as('attempts'),
            ])
            .where('project_id', 'in', projects)
            .execute();
          expect(day).toEqual(raw);
          expect(raw.requests).toBe(events.length);
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe('rollup retention', () => {
  /** A throwaway database: retention deletes across every project, so it cannot share one. */
  const dbName = `gw_retention_${randomBytes(4).toString('hex')}`;
  const adminUrl = process.env.DATABASE_URL!;
  const url = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  let freshPool: pg.Pool;
  let fresh: Db;

  async function admin(query: string) {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${dbName}`);
    const { logger } = captureLogger();
    await migrateDatabase({ databaseUrl: url, dir: DEFAULT_MIGRATIONS_DIR, logger });
    freshPool = createPgPool(url, logger);
    fresh = createDb(freshPool);
  });

  afterAll(async () => {
    await freshPool?.end();
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  });

  it('deletes each table past its own retention and keeps the coarser rows', async () => {
    const project = await createProject(fresh);
    const now = Date.parse('2026-06-15T12:00:00Z');
    const old = (ms: number) =>
      toEvent(
        {
          offsetMs: 0,
          project: 0,
          key: null,
          model: 'm1',
          status: 'success',
          errorCode: null,
          cacheHit: false,
          deployments: ['d1'],
          usage: { promptTokens: 1, completionTokens: 1 },
          latencyMs: 100,
          ttftMs: null,
        },
        now - ms,
        [project],
        [],
      );
    const hours = (n: number) => n * 3_600_000;
    await fresh
      .transaction()
      .execute((trx) => ingestEvents(trx, [old(hours(1)), old(hours(72)), old(hours(24 * 40))]));

    const deleted = await pruneRollups(fresh, now, { minuteHours: 48, hourDays: 35, dayDays: 400 });
    expect(deleted).toEqual({ minute: 2, hour: 1, day: 0 });
    const count = async (
      table: 'usage_rollups_minute' | 'usage_rollups_hour' | 'usage_rollups_day',
    ) => (await fresh.selectFrom(table).select('requests').execute()).length;
    expect([await count('usage_rollups_minute'), await count('usage_rollups_hour')]).toEqual([
      1, 2,
    ]);
    expect(await count('usage_rollups_day')).toBe(3);
  });
});
