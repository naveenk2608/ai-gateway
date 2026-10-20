import { budgetPeriodAt } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { requireProjectRole } from './access.js';
import { errorResponses, iso, projectParams, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];

const requestSummarySchema = z.object({
  id: z.string(),
  apiKeyId: z.string().nullable(),
  model: z.string(),
  deployment: z.string().nullable(),
  stream: z.boolean(),
  status: z.enum(['success', 'error', 'canceled', 'rejected']),
  httpStatus: z.number(),
  errorCode: z.string().nullable(),
  attemptCount: z.number(),
  cacheHit: z.boolean(),
  startedAt: z.string(),
  latencyMs: z.number(),
  totalTokens: z.number().nullable(),
  costMicroUsd: z.number().nullable(),
});

const overviewSchema = z.object({
  /** The counters cover requests that started in [from, to). */
  from: z.string(),
  to: z.string(),
  requests: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  rejected: z.number(),
  canceled: z.number(),
  cacheHits: z.number(),
  totalTokens: z.number(),
  costMicroUsd: z.number(),
  /** Spend recorded for the current UTC month, and the project's budget (null: none). */
  month: z.object({
    period: z.string(),
    spentMicroUsd: z.number(),
    budgetMicroUsd: z.number().nullable(),
  }),
});

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

const DAY_MS = 24 * 3600 * 1000;

/** Read-only usage views for the dashboard (MVP). M6 replaces the overview with rollups. */
export function registerUsageRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects/:projectId/requests',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's requests, newest first (viewer)",
        description:
          'Keyset pagination: pass `nextCursor` from a page as `cursor` to get the next one. ' +
          'Requests appear once the worker has processed their usage event.',
        security,
        params: projectParams,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().max(200).optional(),
        }),
        response: {
          200: z.object({ data: z.array(requestSummarySchema), nextCursor: z.string().nullable() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const { limit, cursor } = request.query;
      await requireProjectRole(db, request, projectId, 'viewer');
      let query = db
        .selectFrom('request_records as r')
        .leftJoin('usage_events as u', 'u.request_id', 'r.id')
        .select([
          'r.id',
          'r.api_key_id',
          'r.model',
          'r.deployment',
          'r.stream',
          'r.status',
          'r.http_status',
          'r.error_code',
          'r.attempt_count',
          'r.cache_hit',
          'r.started_at',
          'r.latency_ms',
          'u.total_tokens',
          'u.cost_micro_usd',
        ])
        .where('r.project_id', '=', projectId)
        .orderBy('r.started_at', 'desc')
        .orderBy('r.id', 'desc')
        .limit(limit + 1);
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
        data: page.map((r) => ({
          id: r.id,
          apiKeyId: r.api_key_id,
          model: r.model,
          deployment: r.deployment,
          stream: r.stream,
          status: r.status,
          httpStatus: r.http_status,
          errorCode: r.error_code,
          attemptCount: r.attempt_count,
          cacheHit: r.cache_hit,
          startedAt: iso(r.started_at),
          latencyMs: r.latency_ms,
          totalTokens: r.total_tokens,
          costMicroUsd: r.cost_micro_usd,
        })),
        nextCursor: rows.length > limit && last ? encodeCursor(last.started_at, last.id) : null,
      };
    },
  );

  routes.get(
    '/admin/projects/:projectId/overview',
    {
      schema: {
        tags: ['admin'],
        summary: 'Counters for the last 24 hours and spend this month (viewer)',
        security,
        params: projectParams,
        response: { 200: overviewSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const now = clock.now();
      const from = new Date(now - DAY_MS);
      const to = new Date(now);
      const period = budgetPeriodAt(now);
      const count = (status?: string) =>
        status === undefined
          ? sql<string>`count(*)`
          : sql<string>`count(*) filter (where r.status = ${status})`;
      const [totals, month, project] = await Promise.all([
        db
          .selectFrom('request_records as r')
          .leftJoin('usage_events as u', 'u.request_id', 'r.id')
          .select([
            count().as('requests'),
            count('success').as('succeeded'),
            count('error').as('failed'),
            count('rejected').as('rejected'),
            count('canceled').as('canceled'),
            sql<string>`count(*) filter (where r.cache_hit)`.as('cache_hits'),
            sql<string>`coalesce(sum(u.total_tokens), 0)`.as('tokens'),
            sql<string>`coalesce(sum(u.cost_micro_usd), 0)`.as('cost'),
          ])
          .where('r.project_id', '=', projectId)
          .where('r.started_at', '>=', from)
          .where('r.started_at', '<', to)
          .executeTakeFirstOrThrow(),
        db
          .selectFrom('budget_periods')
          .select('spent_micro_usd')
          .where('project_id', '=', projectId)
          .where('period_start', '=', new Date(period.start))
          .executeTakeFirst(),
        db
          .selectFrom('projects')
          .select('monthly_budget_micro_usd')
          .where('id', '=', projectId)
          .executeTakeFirstOrThrow(),
      ]);
      return {
        from: iso(from),
        to: iso(to),
        requests: Number(totals.requests),
        succeeded: Number(totals.succeeded),
        failed: Number(totals.failed),
        rejected: Number(totals.rejected),
        canceled: Number(totals.canceled),
        cacheHits: Number(totals.cache_hits),
        totalTokens: Number(totals.tokens),
        costMicroUsd: Number(totals.cost),
        month: {
          period: period.key,
          spentMicroUsd: month?.spent_micro_usd ?? 0,
          budgetMicroUsd: project.monthly_budget_micro_usd,
        },
      };
    },
  );
}
