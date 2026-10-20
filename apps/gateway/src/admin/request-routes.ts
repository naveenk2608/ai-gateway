import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { currentUser } from './access.js';
import { errorResponses, iso, type AdminDeps } from './schemas.js';

const attemptSchema = z.object({
  id: z.string(),
  attemptNumber: z.number(),
  deployment: z.string(),
  provider: z.string(),
  providerModel: z.string(),
  outcome: z.string(),
  upstreamStatus: z.number().nullable(),
  routingPolicy: z.string().nullable(),
  routingReason: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  latencyMs: z.number(),
  ttftMs: z.number().nullable(),
});

const requestDetailSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  apiKeyId: z.string().nullable(),
  model: z.string(),
  deployment: z.string().nullable(),
  stream: z.boolean(),
  status: z.enum(['success', 'error', 'canceled', 'rejected']),
  httpStatus: z.number(),
  errorCode: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
  latencyMs: z.number(),
  ttftMs: z.number().nullable(),
  /** Answered from the response cache: no attempts, zero cost. */
  cacheHit: z.boolean(),
  /** Null for requests rejected before any provider call. */
  usage: z
    .object({
      source: z.enum(['reported', 'estimated', 'missing']),
      promptTokens: z.number().nullable(),
      completionTokens: z.number().nullable(),
      totalTokens: z.number().nullable(),
      costMicroUsd: z.number().nullable(),
      priceId: z.string().nullable(),
    })
    .nullable(),
  attempts: z.array(attemptSchema),
});

function requestNotFound(): GatewayError {
  return new GatewayError('request_not_found', 'Request not found.', { httpStatus: 404 });
}

export function registerRequestRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/requests/:requestId',
    {
      schema: {
        tags: ['admin'],
        summary: 'One request with its usage and every upstream attempt',
        description:
          'The request ID is the `x-request-id` response header. Requests appear once the worker ' +
          'has processed their usage event.',
        security: [{ session: [] }],
        params: z.object({ requestId: z.uuid() }),
        response: { 200: requestDetailSchema, ...errorResponses },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const { requestId } = request.params;
      // Only requests of projects the caller belongs to: anything else is "not found".
      const record = await db
        .selectFrom('request_records')
        .selectAll()
        .where('id', '=', requestId)
        .where('project_id', 'in', (eb) =>
          eb.selectFrom('project_members').select('project_id').where('user_id', '=', user.id),
        )
        .executeTakeFirst();
      if (!record) throw requestNotFound();

      const [usage, attempts] = await Promise.all([
        db
          .selectFrom('usage_events')
          .selectAll()
          .where('request_id', '=', requestId)
          .executeTakeFirst(),
        db
          .selectFrom('provider_attempts')
          .selectAll()
          .where('request_id', '=', requestId)
          .orderBy('attempt_number')
          .execute(),
      ]);

      return {
        id: record.id,
        projectId: record.project_id,
        apiKeyId: record.api_key_id,
        model: record.model,
        deployment: record.deployment,
        stream: record.stream,
        status: record.status,
        httpStatus: record.http_status,
        errorCode: record.error_code,
        startedAt: iso(record.started_at),
        completedAt: iso(record.completed_at),
        latencyMs: record.latency_ms,
        ttftMs: record.ttft_ms,
        cacheHit: record.cache_hit,
        usage: usage
          ? {
              source: usage.usage_source,
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
              costMicroUsd: usage.cost_micro_usd,
              priceId: usage.price_id,
            }
          : null,
        attempts: attempts.map((a) => ({
          id: a.id,
          attemptNumber: a.attempt_number,
          deployment: a.deployment,
          provider: a.provider,
          providerModel: a.provider_model,
          outcome: a.outcome,
          upstreamStatus: a.upstream_status,
          routingPolicy: a.routing_policy,
          routingReason: a.routing_reason,
          startedAt: iso(a.started_at),
          completedAt: iso(a.completed_at),
          latencyMs: a.latency_ms,
          ttftMs: a.ttft_ms,
        })),
      };
    },
  );
}
