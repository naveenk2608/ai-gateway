import { budgetPeriodAt, type Clock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import {
  analyticsQuerySchema,
  describeWindow,
  fillSeries,
  inScope,
  metricSums,
  metricsSchema,
  projectScope,
  requestStatusSchema,
  rollups,
  seriesBucket,
  sumOf,
  sumWithStatus,
  toMetrics,
  windowFor,
  windowSchema,
  type Filters,
} from './analytics.js';
import { breakerSchema, pipelineSchema } from './infra.js';
import { errorResponses, iso, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];
const tags = ['analytics'];
const DAY_MS = 86_400_000;
/** Most rows in any breakdown; each is ordered by its main measure. */
const BREAKDOWN_LIMIT = 100;
/** A budget at or above this share of its limit is flagged. */
const BUDGET_WARNING_SHARE = 0.8;
/** Days of daily rollups needed before a monthly spend projection is made. */
const PROJECTION_MIN_DAYS = 7;

const requestSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  apiKeyId: z.string().nullable(),
  model: z.string(),
  deployment: z.string().nullable(),
  provider: z.string().nullable(),
  stream: z.boolean(),
  status: requestStatusSchema,
  httpStatus: z.number(),
  errorCode: z.string().nullable(),
  attemptCount: z.number(),
  cacheHit: z.boolean(),
  startedAt: z.string(),
  latencyMs: z.number(),
  ttftMs: z.number().nullable(),
  totalTokens: z.number().nullable(),
  costMicroUsd: z.number().nullable(),
});

const countPointSchema = z.object({
  start: z.string(),
  requests: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  rejected: z.number(),
  canceled: z.number(),
});

const spendSchema = z.object({
  requests: z.number(),
  totalTokens: z.number(),
  costMicroUsd: z.number(),
});

const budgetSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  period: z.string(),
  spentMicroUsd: z.number(),
  /** Null: the project has no monthly budget. */
  budgetMicroUsd: z.number().nullable(),
  usedShare: z.number().nullable(),
  /** `warning` from 80% of the budget, `exceeded` from 100%; null without a budget. */
  alert: z.enum(['ok', 'warning', 'exceeded']).nullable(),
});

const projectionSchema = z.object({
  /** Spend so far this UTC month plus the last 7 days' daily average for the days left. */
  monthlyCostMicroUsd: z.number().nullable(),
  /** Why there is no projection (fewer than 7 days of data); null when there is one. */
  reason: z.string().nullable(),
  daysOfData: z.number(),
});

/** Rejection codes grouped as the Security page shows them. */
const REJECTION_CATEGORIES: Record<string, string> = {
  rpm_limit_exceeded: 'rate_limit',
  tpm_limit_exceeded: 'token_limit',
  concurrency_limit_exceeded: 'concurrency',
  budget_exceeded: 'budget',
  request_exceeds_limit: 'budget',
  model_not_allowed: 'policy',
  limits_unavailable: 'limits_unavailable',
};
const CATEGORY_ORDER = [
  'rate_limit',
  'token_limit',
  'concurrency',
  'budget',
  'policy',
  'limits_unavailable',
  'other',
];

const projectNames = async (db: Db, ids: string[]) =>
  ids.length === 0
    ? new Map<string, string>()
    : new Map(
        (
          await db.selectFrom('projects').select(['id', 'name']).where('id', 'in', ids).execute()
        ).map((p) => [p.id, p.name]),
      );

const keyNames = async (db: Db, ids: string[], scope: string[]) =>
  ids.length === 0
    ? new Map<string, string>()
    : new Map(
        (
          await db
            .selectFrom('api_keys')
            .select(['id', 'name'])
            .where('id', 'in', ids)
            .where(inScope('project_id', scope))
            .execute()
        ).map((k) => [k.id, k.name]),
      );

/** Opaque keyset cursor: the start time and ID of the last row of a page. */
function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const startedAt = new Date(at ?? '');
  if (!id || !/^[0-9a-f-]{36}$/.test(id) || Number.isNaN(startedAt.getTime())) {
    throw new GatewayError('invalid_cursor', 'The cursor is not valid.', {
      httpStatus: 400,
      param: 'cursor',
    });
  }
  return { startedAt, id };
}

/** Spend recorded this UTC month for the projects in scope (budget_periods, not the filters). */
async function budgets(
  db: Db,
  scope: string[],
  now: number,
): Promise<z.output<typeof budgetSchema>[]> {
  if (scope.length === 0) return [];
  const period = budgetPeriodAt(now);
  const rows = await db
    .selectFrom('projects as p')
    .leftJoin('budget_periods as b', (join) =>
      join.onRef('b.project_id', '=', 'p.id').on('b.period_start', '=', new Date(period.start)),
    )
    .select(['p.id', 'p.name', 'p.monthly_budget_micro_usd', 'b.spent_micro_usd'])
    .where('p.id', 'in', scope)
    .orderBy('p.name')
    .execute();
  return rows.map((row) => {
    const spent = row.spent_micro_usd ?? 0;
    const budget = row.monthly_budget_micro_usd;
    const usedShare = budget === null ? null : budget > 0 ? spent / budget : spent > 0 ? 1 : 0;
    return {
      projectId: row.id,
      projectName: row.name,
      period: period.key,
      spentMicroUsd: spent,
      budgetMicroUsd: budget,
      usedShare,
      alert:
        usedShare === null
          ? null
          : usedShare >= 1
            ? 'exceeded'
            : usedShare >= BUDGET_WARNING_SHARE
              ? 'warning'
              : 'ok',
    };
  });
}

/**
 * The month's spend projected from daily rollups: spend so far this UTC month plus the average of
 * the last 7 full days for each day left. Only with at least 7 full days of data.
 */
async function projection(
  db: Db,
  scope: string[],
  filters: Filters,
  now: number,
): Promise<z.output<typeof projectionSchema>> {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const period = budgetPeriodAt(now);
  const daily = (from: number, to: number) =>
    rollups(db, { granularity: 'day', from, to, stepMs: DAY_MS, range: '30d' }, scope, filters);
  const first = await daily(0, today + DAY_MS)
    .select(sql<Date | null>`min(bucket_start)`.as('first'))
    .executeTakeFirst();
  const daysOfData = first?.first ? Math.floor((today - first.first.getTime()) / DAY_MS) : 0;
  if (daysOfData < PROJECTION_MIN_DAYS) {
    return {
      monthlyCostMicroUsd: null,
      reason: `A projection needs ${PROJECTION_MIN_DAYS} full days of data; there ${
        daysOfData === 1 ? 'is 1' : `are ${daysOfData}`
      }.`,
      daysOfData,
    };
  }
  const [lastWeek, monthToDate] = await Promise.all([
    daily(today - PROJECTION_MIN_DAYS * DAY_MS, today)
      .select(sumOf('cost_micro_usd').as('cost'))
      .executeTakeFirstOrThrow(),
    daily(period.start, today + DAY_MS)
      .select(sumOf('cost_micro_usd').as('cost'))
      .executeTakeFirstOrThrow(),
  ]);
  const daysLeft = (period.end - now) / DAY_MS;
  return {
    monthlyCostMicroUsd:
      monthToDate.cost + Math.round((lastWeek.cost / PROJECTION_MIN_DAYS) * daysLeft),
    reason: null,
    daysOfData,
  };
}

/**
 * The analytics API (ADR 015): one read endpoint per dashboard section. Each takes a range
 * (1h and 24h read minute rollups, 7d hourly, 30d daily) and filters; the caller sees only the
 * projects they belong to. Only the request list reads raw records, a page at a time.
 */
export function registerAnalyticsRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock, infra } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/analytics/overview',
    {
      schema: {
        tags,
        summary: 'Request counts, tokens, cost, latency and a request-rate series',
        description:
          '`month` is the spend recorded this UTC month for the projects in scope; the other ' +
          'filters do not apply to it.',
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            totals: metricsSchema,
            series: z.array(countPointSchema),
            month: z.object({ period: z.string(), spentMicroUsd: z.number() }),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, ...filters } = request.query;
      const now = clock.now();
      const window = windowFor(range, now);
      const scope = await projectScope(db, request, projectId);
      const [totals, points, month] = await Promise.all([
        rollups(db, window, scope, filters).select(metricSums()).executeTakeFirstOrThrow(),
        rollups(db, window, scope, filters)
          .select([
            seriesBucket(window).as('start'),
            sumOf('requests').as('requests'),
            sumWithStatus('success').as('succeeded'),
            sumWithStatus('error').as('failed'),
            sumWithStatus('rejected').as('rejected'),
            sumWithStatus('canceled').as('canceled'),
          ])
          .groupBy(sql`1`)
          .execute(),
        budgets(db, scope, now),
      ]);
      return {
        window: describeWindow(window),
        totals: toMetrics(totals),
        series: fillSeries(
          window,
          points.map(({ start, ...values }) => ({ start, values })),
          () => ({ requests: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0 }),
        ),
        month: {
          period: budgetPeriodAt(now).key,
          spentMicroUsd: month.reduce((sum, b) => sum + b.spentMicroUsd, 0),
        },
      };
    },
  );

  routes.get(
    '/admin/analytics/requests',
    {
      schema: {
        tags,
        summary: 'Requests in the range, newest first, a page at a time',
        description:
          'Keyset pagination: pass `nextCursor` from a page as `cursor` to get the next one. ' +
          'Requests appear once the worker has processed their usage event.',
        security,
        querystring: analyticsQuerySchema.extend({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({
            window: windowSchema,
            data: z.array(requestSummarySchema),
            nextCursor: z.string().nullable(),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, limit, cursor, ...filters } = request.query;
      const window = windowFor(range, clock.now());
      const scope = await projectScope(db, request, projectId);
      let query = db
        .selectFrom('request_records as r')
        .leftJoin('usage_events as u', 'u.request_id', 'r.id')
        .select([
          'r.id',
          'r.project_id',
          'r.api_key_id',
          'r.model',
          'r.deployment',
          'u.provider',
          'r.stream',
          'r.status',
          'r.http_status',
          'r.error_code',
          'r.attempt_count',
          'r.cache_hit',
          'r.started_at',
          'r.latency_ms',
          'r.ttft_ms',
          'u.total_tokens',
          'u.cost_micro_usd',
        ])
        .where(inScope('r.project_id', scope))
        .where('r.started_at', '>=', new Date(window.from))
        .where('r.started_at', '<', new Date(window.to))
        .orderBy('r.started_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(limit + 1);
      if (filters.apiKeyId) query = query.where('r.api_key_id', '=', filters.apiKeyId);
      if (filters.provider) query = query.where('u.provider', '=', filters.provider);
      if (filters.model) query = query.where('r.model', '=', filters.model);
      if (filters.status) query = query.where('r.status', '=', filters.status);
      if (cursor) {
        const after = decodeCursor(cursor);
        query = query.where((eb) =>
          eb(eb.refTuple('r.started_at', 'r.id'), '<', eb.tuple(after.startedAt, after.id)),
        );
      }
      const rows = await query.execute();
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        window: describeWindow(window),
        data: page.map((r) => ({
          id: r.id,
          projectId: r.project_id,
          apiKeyId: r.api_key_id,
          model: r.model,
          deployment: r.deployment,
          provider: r.provider,
          stream: r.stream,
          status: r.status,
          httpStatus: r.http_status,
          errorCode: r.error_code,
          attemptCount: r.attempt_count,
          cacheHit: r.cache_hit,
          startedAt: iso(r.started_at),
          latencyMs: r.latency_ms,
          ttftMs: r.ttft_ms,
          totalTokens: r.total_tokens,
          costMicroUsd: r.cost_micro_usd,
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.started_at, last.id) : null,
      };
    },
  );

  routes.get(
    '/admin/analytics/models',
    {
      schema: {
        tags,
        summary:
          'Latency, TTFT, throughput, cost, failure and fallback rates per model and deployment',
        description:
          'Speed and cost only: nothing here measures the quality of the answers. Rows without a ' +
          'deployment are requests no provider answered (rejections, cache hits).',
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            data: z.array(
              z.object({
                model: z.string(),
                deployment: z.string().nullable(),
                provider: z.string().nullable(),
                metrics: metricsSchema,
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, ...filters } = request.query;
      const window = windowFor(range, clock.now());
      const scope = await projectScope(db, request, projectId);
      const rows = await rollups(db, window, scope, filters)
        .select(['model', 'deployment', 'provider', ...metricSums()])
        .groupBy(['model', 'deployment', 'provider'])
        .orderBy('requests', 'desc')
        .orderBy('model')
        .orderBy('deployment')
        .limit(BREAKDOWN_LIMIT)
        .execute();
      return {
        window: describeWindow(window),
        data: rows.map(({ model, deployment, provider, ...sums }) => ({
          model,
          deployment,
          provider,
          metrics: toMetrics(sums),
        })),
      };
    },
  );

  routes.get(
    '/admin/analytics/cost',
    {
      schema: {
        tags,
        summary: 'Spend by provider, model, project and key; trend; budgets and a projection',
        description:
          'Budgets are per project and UTC month and ignore the other filters. The projection ' +
          `needs ${PROJECTION_MIN_DAYS} full days of data, otherwise it is null with a reason.`,
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            totals: spendSchema.extend({ promptTokens: z.number(), completionTokens: z.number() }),
            byProvider: z.array(spendSchema.extend({ provider: z.string().nullable() })),
            byModel: z.array(spendSchema.extend({ model: z.string() })),
            byProject: z.array(
              spendSchema.extend({ projectId: z.string(), projectName: z.string() }),
            ),
            byApiKey: z.array(
              spendSchema.extend({ apiKeyId: z.string().nullable(), name: z.string().nullable() }),
            ),
            series: z.array(
              z.object({ start: z.string(), costMicroUsd: z.number(), totalTokens: z.number() }),
            ),
            budgets: z.array(budgetSchema),
            projection: projectionSchema,
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, ...filters } = request.query;
      const now = clock.now();
      const window = windowFor(range, now);
      const scope = await projectScope(db, request, projectId);
      const spend = [
        sumOf('requests').as('requests'),
        sumOf('total_tokens').as('totalTokens'),
        sumOf('cost_micro_usd').as('costMicroUsd'),
      ] as const;
      const base = () => rollups(db, window, scope, filters);
      const [totals, byProvider, byModel, byProject, byKey, points, budgetRows, projected] =
        await Promise.all([
          base()
            .select([
              ...spend,
              sumOf('prompt_tokens').as('promptTokens'),
              sumOf('completion_tokens').as('completionTokens'),
            ])
            .executeTakeFirstOrThrow(),
          base()
            .select(['provider', ...spend])
            .groupBy('provider')
            .orderBy('costMicroUsd', 'desc')
            .limit(BREAKDOWN_LIMIT)
            .execute(),
          base()
            .select(['model', ...spend])
            .groupBy('model')
            .orderBy('costMicroUsd', 'desc')
            .limit(BREAKDOWN_LIMIT)
            .execute(),
          base()
            .select(['project_id', ...spend])
            .groupBy('project_id')
            .orderBy('costMicroUsd', 'desc')
            .limit(BREAKDOWN_LIMIT)
            .execute(),
          base()
            .select(['api_key_id', ...spend])
            .groupBy('api_key_id')
            .orderBy('costMicroUsd', 'desc')
            .limit(BREAKDOWN_LIMIT)
            .execute(),
          base()
            .select([
              seriesBucket(window).as('start'),
              sumOf('cost_micro_usd').as('costMicroUsd'),
              sumOf('total_tokens').as('totalTokens'),
            ])
            .groupBy(sql`1`)
            .execute(),
          budgets(db, scope, now),
          projection(db, scope, filters, now),
        ]);
      const [names, keys] = await Promise.all([
        projectNames(
          db,
          byProject.map((p) => p.project_id),
        ),
        keyNames(
          db,
          byKey.flatMap((k) => (k.api_key_id ? [k.api_key_id] : [])),
          scope,
        ),
      ]);
      return {
        window: describeWindow(window),
        totals,
        byProvider,
        byModel,
        byProject: byProject.map(({ project_id, ...s }) => ({
          projectId: project_id,
          projectName: names.get(project_id) ?? '',
          ...s,
        })),
        byApiKey: byKey.map(({ api_key_id, ...s }) => ({
          apiKeyId: api_key_id,
          name: api_key_id ? (keys.get(api_key_id) ?? null) : null,
          ...s,
        })),
        series: fillSeries(
          window,
          points.map(({ start, ...values }) => ({ start, values })),
          () => ({ costMicroUsd: 0, totalTokens: 0 }),
        ),
        budgets: budgetRows,
        projection: projected,
      };
    },
  );

  routes.get(
    '/admin/analytics/reliability',
    {
      schema: {
        tags,
        summary: 'Errors, retries, fallbacks, circuit-breaker states and changes, health checks',
        description:
          'Breaker states and health events are fleet-wide (deployments are shared by every ' +
          'project), so only `range` applies to them. `breakers` is null when Redis is unreachable.',
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            totals: metricsSchema,
            errorsByCode: z.array(
              z.object({
                status: requestStatusSchema,
                errorCode: z.string().nullable(),
                requests: z.number(),
              }),
            ),
            byDeployment: z.array(
              z.object({
                deployment: z.string().nullable(),
                provider: z.string().nullable(),
                requests: z.number(),
                failed: z.number(),
                attempts: z.number(),
                retries: z.number(),
                fallbacks: z.number(),
              }),
            ),
            series: z.array(
              z.object({
                start: z.string(),
                requests: z.number(),
                failed: z.number(),
                retries: z.number(),
                fallbacks: z.number(),
              }),
            ),
            breakers: z.array(breakerSchema).nullable(),
            healthEvents: z.array(
              z.object({
                deployment: z.string(),
                instanceId: z.string(),
                fromState: z.string().nullable(),
                toState: z.string(),
                reason: z.string().nullable(),
                occurredAt: z.string(),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, ...filters } = request.query;
      const window = windowFor(range, clock.now());
      const scope = await projectScope(db, request, projectId);
      const base = () => rollups(db, window, scope, filters);
      const [totals, errors, byDeployment, points, breakers, events] = await Promise.all([
        base().select(metricSums()).executeTakeFirstOrThrow(),
        base()
          .select(['status', 'error_code', sumOf('requests').as('requests')])
          .where('status', 'in', ['error', 'canceled'])
          .groupBy(['status', 'error_code'])
          .orderBy('requests', 'desc')
          .limit(BREAKDOWN_LIMIT)
          .execute(),
        base()
          .select([
            'deployment',
            'provider',
            sumOf('requests').as('requests'),
            sumWithStatus('error').as('failed'),
            sumOf('attempts').as('attempts'),
            sumOf('retries').as('retries'),
            sumOf('fallbacks').as('fallbacks'),
          ])
          .where('deployment', 'is not', null)
          .groupBy(['deployment', 'provider'])
          .orderBy('requests', 'desc')
          .limit(BREAKDOWN_LIMIT)
          .execute(),
        base()
          .select([
            seriesBucket(window).as('start'),
            sumOf('requests').as('requests'),
            sumWithStatus('error').as('failed'),
            sumOf('retries').as('retries'),
            sumOf('fallbacks').as('fallbacks'),
          ])
          .groupBy(sql`1`)
          .execute(),
        infra.breakers().catch((err: unknown) => {
          request.log.warn({ err }, 'could not read breaker states');
          return null;
        }),
        db
          .selectFrom('provider_health_events')
          .selectAll()
          .where('occurred_at', '>=', new Date(window.from))
          .where('occurred_at', '<', new Date(window.to))
          .orderBy('occurred_at', 'desc')
          .limit(BREAKDOWN_LIMIT)
          .execute(),
      ]);
      return {
        window: describeWindow(window),
        totals: toMetrics(totals),
        errorsByCode: errors.map((e) => ({
          status: e.status,
          errorCode: e.error_code,
          requests: e.requests,
        })),
        byDeployment,
        series: fillSeries(
          window,
          points.map(({ start, ...values }) => ({ start, values })),
          () => ({ requests: 0, failed: 0, retries: 0, fallbacks: 0 }),
        ),
        breakers,
        healthEvents: events.map((e) => ({
          deployment: e.deployment,
          instanceId: e.instance_id,
          fromState: e.from_state,
          toState: e.to_state,
          reason: e.reason,
          occurredAt: iso(e.occurred_at),
        })),
      };
    },
  );

  routes.get(
    '/admin/analytics/security',
    {
      schema: {
        tags,
        summary: 'Rejected requests: rate, token, concurrency, budget and policy limits',
        description:
          'Requests with a missing, unknown, revoked or expired API key are refused before any ' +
          'project is known, so they are not counted per project (`invalidApiKeys.count` is null).',
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            rejected: z.number(),
            byCategory: z.array(z.object({ category: z.string(), requests: z.number() })),
            byCode: z.array(
              z.object({
                errorCode: z.string().nullable(),
                category: z.string(),
                requests: z.number(),
              }),
            ),
            byApiKey: z.array(
              z.object({
                apiKeyId: z.string().nullable(),
                name: z.string().nullable(),
                requests: z.number(),
              }),
            ),
            series: z.array(z.object({ start: z.string(), rejected: z.number() })),
            invalidApiKeys: z.object({ count: z.null(), reason: z.string() }),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId, ...filters } = request.query;
      const window = windowFor(range, clock.now());
      const scope = await projectScope(db, request, projectId);
      // Rejections only; another status filter matches nothing.
      const rejectedScope = filters.status && filters.status !== 'rejected' ? [] : scope;
      const base = () => rollups(db, window, rejectedScope, { ...filters, status: 'rejected' });
      const [byCode, byKey, points] = await Promise.all([
        base()
          .select(['error_code', sumOf('requests').as('requests')])
          .groupBy('error_code')
          .orderBy('requests', 'desc')
          .limit(BREAKDOWN_LIMIT)
          .execute(),
        base()
          .select(['api_key_id', sumOf('requests').as('requests')])
          .groupBy('api_key_id')
          .orderBy('requests', 'desc')
          .limit(BREAKDOWN_LIMIT)
          .execute(),
        base()
          .select([seriesBucket(window).as('start'), sumOf('requests').as('rejected')])
          .groupBy(sql`1`)
          .execute(),
      ]);
      const keys = await keyNames(
        db,
        byKey.flatMap((k) => (k.api_key_id ? [k.api_key_id] : [])),
        scope,
      );
      const categoryOf = (code: string | null) => (code && REJECTION_CATEGORIES[code]) || 'other';
      const categories = new Map(CATEGORY_ORDER.map((c) => [c, 0]));
      for (const row of byCode) {
        const category = categoryOf(row.error_code);
        categories.set(category, (categories.get(category) ?? 0) + row.requests);
      }
      return {
        window: describeWindow(window),
        rejected: byCode.reduce((sum, row) => sum + row.requests, 0),
        byCategory: [...categories].map(([category, requests]) => ({ category, requests })),
        byCode: byCode.map((row) => ({
          errorCode: row.error_code,
          category: categoryOf(row.error_code),
          requests: row.requests,
        })),
        byApiKey: byKey.map((k) => ({
          apiKeyId: k.api_key_id,
          name: k.api_key_id ? (keys.get(k.api_key_id) ?? null) : null,
          requests: k.requests,
        })),
        series: fillSeries(
          window,
          points.map(({ start, ...values }) => ({ start, values })),
          () => ({ rejected: 0 }),
        ),
        invalidApiKeys: {
          count: null,
          reason:
            'Invalid API keys are refused before a project is known, so they are not counted per project.',
        },
      };
    },
  );

  routes.get(
    '/admin/analytics/infra',
    {
      schema: {
        tags,
        summary: 'Usage pipeline lag, dead letters and dependency round trips, measured now',
        description:
          'Fleet-wide values measured when asked; `range` only sets the window for ' +
          '`failedEvents.inWindow`, and the other filters do not apply. `pipeline` is null when ' +
          'Redis is unreachable. Host metrics and history come with Prometheus (M8).',
        security,
        querystring: analyticsQuerySchema,
        response: {
          200: z.object({
            window: windowSchema,
            measuredAt: z.string(),
            pipeline: pipelineSchema.nullable(),
            failedEvents: z.object({ total: z.number(), inWindow: z.number() }),
            dependencies: z.record(
              z.string(),
              z.object({ status: z.enum(['ok', 'fail']), latencyMs: z.number() }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { range, projectId } = request.query;
      const now = clock.now();
      const window = windowFor(range, now);
      // Only to check that a requested project is the caller's; the values are fleet-wide.
      await projectScope(db, request, projectId);
      const [pipeline, failed, dependencies] = await Promise.all([
        infra.pipeline().catch((err: unknown) => {
          request.log.warn({ err }, 'could not read the usage pipeline state');
          return null;
        }),
        db
          .selectFrom('failed_events')
          .select([
            sql<number>`count(*)::int`.as('total'),
            sql<number>`(count(*) filter (where failed_at >= ${new Date(window.from)}))::int`.as(
              'inWindow',
            ),
          ])
          .executeTakeFirstOrThrow(),
        roundTrips(infra.checks, clock),
      ]);
      return {
        window: describeWindow(window),
        measuredAt: new Date(now).toISOString(),
        pipeline,
        failedEvents: failed,
        dependencies,
      };
    },
  );
}

const ROUND_TRIP_TIMEOUT_MS = 2_000;

/** Times each check; one that fails or takes over 2 s is `fail`. Errors are not returned. */
async function roundTrips(checks: Record<string, () => Promise<void>>, clock: Clock) {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const started = performance.now();
      const stop = new AbortController();
      const timeout = clock.sleep(ROUND_TRIP_TIMEOUT_MS, stop.signal).then(
        () => 'fail' as const,
        () => 'fail' as const,
      );
      const status = await Promise.race([
        check().then(
          () => 'ok' as const,
          () => 'fail' as const,
        ),
        timeout,
      ]);
      stop.abort();
      return [name, { status, latencyMs: Math.round(performance.now() - started) }] as const;
    }),
  );
  return Object.fromEntries(entries);
}
