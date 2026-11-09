import { inSpan, POSTGRES_SPAN } from '@ai-gateway/shared/node';
import { estimateTextTokens, type Clock } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiKeyAuth } from '../auth/api-key-auth.js';
import type { KeyVerifier } from '../auth/key-verifier.js';
import {
  CACHE_HEADER,
  embeddingsCacheKey,
  type CachedEmbeddings,
  type ResponseCache,
} from '../cache/response-cache.js';
import { GatewayError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import type { AdmissionControl } from '../limits/admission.js';
import type { GatewayMetrics } from '../metrics.js';
import { MAX_EMBEDDING_INPUTS } from '../models-config.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Usage } from '../providers/types.js';
import type { RouteOverrides } from '../routing/overrides.js';
import { runRouted, type RoutingDeps } from '../routing/routed.js';
import { runEmbed, type AttemptContext } from './attempt.js';
import { promptTooLarge, upstreamFailure, watchDisconnect } from './chat-completions.js';
import { blockingError, Findings, scanEmbeddingsInput } from '../guardrails/scan.js';
import { follow, type Coalescer } from './coalesce.js';
import {
  answerNotStored,
  IDEMPOTENCY_HEADER,
  idempotencyUnavailable,
  keyInProgress,
  keyReused,
  parseIdempotencyKey,
  REPLAYED_HEADER,
  requestFingerprint,
  type Claim,
  type IdempotencyGate,
  type IdempotentLead,
  type StoredResponse,
} from './idempotency.js';
import { setRateLimitHeaders } from './rate-limit-headers.js';
import { replayHeaders, routingHeaders } from './routing-headers.js';
import { errorBodySchema } from './schema.js';
import { RequestTrace } from './trace.js';

/** Estimated input tokens per request at most: OpenAI's documented limit for the format. */
export const MAX_EMBEDDING_TOKENS = 300_000;
/**
 * Numbers per answer at most (inputs x dimensions), so a provider's answer stays within the
 * 10 MiB the gateway reads from it: 128 inputs of 3,072 dimensions, or 384 of 1,024.
 */
export const MAX_EMBEDDING_VALUES = 393_216;

export const embeddingsRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    input: z.union(
      [z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_EMBEDDING_INPUTS)],
      {
        error:
          `input must be a non-empty string or an array of 1 to ${MAX_EMBEDDING_INPUTS} ` +
          'non-empty strings (token arrays are not supported)',
      },
    ),
    encoding_format: z.enum(['float', 'base64']).nullish(),
    dimensions: z.number().int().positive().nullish(),
    user: z.string().max(256).nullish(),
  })
  .strict();

export type EmbeddingsRequest = z.output<typeof embeddingsRequestSchema>;

export const embeddingsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      object: z.literal('embedding'),
      index: z.number().int(),
      /** Numbers, or with `encoding_format: "base64"` the little-endian float32 bytes in base64. */
      embedding: z.union([z.array(z.number()), z.string()]),
    }),
  ),
  model: z.string(),
  usage: z.object({ prompt_tokens: z.number().int(), total_tokens: z.number().int() }),
});

/** What an Idempotency-Key keeps of an embeddings answer (ADR 032): the data as sent, and usage. */
const storedEmbeddingsSchema = z.object({
  data: z.array(z.union([z.array(z.number()), z.string()])).min(1),
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .nullable(),
});

export interface EmbeddingsRouteOptions {
  registry: ProviderRegistry;
  clock: Clock;
  verifier: KeyVerifier;
  events: EventBus;
  admission: AdmissionControl;
  routing: RoutingDeps;
  cache?: ResponseCache | null;
  /** Identical requests in flight share one upstream call (ADR 031). */
  coalescer?: Coalescer | null;
  /** Idempotency-Key: a retry is answered with the first answer (ADR 032). */
  idempotency?: IdempotencyGate | null;
  /** Per-project route overrides (ADR 034); without them, the models file's routes. */
  routeOverrides?: RouteOverrides | null;
  /** Each project's guardrails run (GUARDRAILS_ENABLED, ADR 035). */
  guardrailsEnabled?: boolean;
  metrics?: GatewayMetrics;
}

/** A vector as OpenAI's `base64` encoding sends it: float32 values, little-endian. */
export function base64Vector(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((x, i) => bytes.writeFloatLE(x, i * 4));
  return bytes.toString('base64');
}

const badRequest = (code: string, message: string, param: string) =>
  new GatewayError(code, message, { httpStatus: 400, param });

/**
 * `POST /v1/embeddings` in OpenAI's format (ADR 029), through the same path as chat: the API key
 * and its allow-list, limits and the budget (input tokens only), quotas and cooldowns, breakers,
 * retries and the request deadline, the cache, and one usage event with `endpoint: embeddings`.
 */
export function registerEmbeddings(app: FastifyInstance, options: EmbeddingsRouteOptions): void {
  const {
    registry,
    clock,
    verifier,
    events,
    admission,
    routing,
    cache = null,
    coalescer = null,
    idempotency = null,
    routeOverrides = null,
    guardrailsEnabled = false,
    metrics,
  } = options;
  /** Hands the finished trace to the event bus, once (a second call does nothing). */
  const emit = (trace: RequestTrace | null, httpStatus: number) => {
    const event = trace?.finish(httpStatus);
    if (event) {
      events.publish(event);
      metrics?.requestFinished(event);
    }
  };
  if (!app.hasRequestDecorator('apiKey')) app.decorateRequest('apiKey', null);
  if (!app.hasRequestDecorator('trace')) app.decorateRequest('trace', null);

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/embeddings',
    {
      onRequest: apiKeyAuth(verifier),
      onError: (request, _reply, err, done) => {
        request.trace?.setError(err instanceof GatewayError ? err.code : 'internal_error');
        done();
      },
      onResponse: (request, reply, done) => {
        emit(request.trace, reply.statusCode);
        done();
      },
      schema: {
        tags: ['embeddings'],
        security: [{ apiKey: [] }],
        summary: 'Create embeddings (OpenAI-compatible)',
        description:
          'One vector per input. An embeddings model falls back only between deployments of the ' +
          'same model with the same dimensions.',
        body: embeddingsRequestSchema,
        response: {
          200: embeddingsResponseSchema,
          '4xx': errorBodySchema,
          '5xx': errorBodySchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const apiKey = request.apiKey;
      // The onRequest hook guarantees a key.
      if (!apiKey) {
        throw new GatewayError('internal_error', 'Internal server error', { httpStatus: 500 });
      }
      // Replaced by the masked input when this project's guardrails mask a value (ADR 035).
      let input = typeof body.input === 'string' ? [body.input] : body.input;
      const trace = new RequestTrace(
        {
          requestId: request.id,
          projectId: apiKey.projectId,
          apiKeyId: apiKey.apiKeyId,
          model: body.model,
          stream: false,
          endpoint: 'embeddings',
          estimatedPromptTokens: input.reduce((n, text) => n + estimateTextTokens(text), 0),
          traceContext: request.traceContext,
        },
        clock,
      );
      request.trace = trace;

      const allowed = apiKey.allowedModels;
      if (allowed && !allowed.includes(body.model)) {
        throw new GatewayError(
          'model_not_allowed',
          `This project is not allowed to use the model \`${body.model}\`.`,
          { httpStatus: 403, param: 'model' },
        );
      }
      // The models file's route, or this project's override of it (ADR 034).
      const fileRoute = registry.route(body.model);
      const route =
        fileRoute && routeOverrides ? routeOverrides.apply(apiKey.projectId, fileRoute) : fileRoute;
      if (!route) {
        throw new GatewayError('model_not_found', `The model \`${body.model}\` does not exist.`, {
          httpStatus: 404,
          param: 'model',
        });
      }
      const spec = route.targets[0]?.deployment.embedding;
      if (route.type !== 'embeddings' || !spec) {
        throw badRequest(
          'model_endpoint_mismatch',
          `The model \`${body.model}\` is a chat model: send it to /v1/chat/completions.`,
          'model',
        );
      }

      // Every deployment of an embeddings route serves the same model at the same size.
      const requested = body.dimensions ?? undefined;
      if (requested !== undefined) {
        const range = spec.dimensionsRange;
        if (!range) {
          throw badRequest(
            'unsupported_parameter',
            `The model \`${body.model}\` does not take dimensions: its vectors have ${spec.dimensions}.`,
            'dimensions',
          );
        }
        if (requested < range.min || requested > range.max) {
          throw badRequest(
            'unsupported_parameter',
            `The model \`${body.model}\` takes dimensions from ${range.min} to ${range.max}.`,
            'dimensions',
          );
        }
      }
      const size = requested ?? spec.dimensions;
      const maxInputs = Math.min(
        MAX_EMBEDDING_INPUTS,
        Math.max(1, Math.floor(MAX_EMBEDDING_VALUES / size)),
        ...route.targets.map((t) => t.deployment.embedding?.maxInputs ?? MAX_EMBEDDING_INPUTS),
      );
      if (input.length > maxInputs) {
        throw badRequest(
          'request_exceeds_limit',
          `The model \`${body.model}\` takes at most ${maxInputs} inputs per request at ${size} dimensions.`,
          'input',
        );
      }
      if (trace.estimatedPromptTokens > MAX_EMBEDDING_TOKENS) {
        throw badRequest(
          'request_exceeds_limit',
          `The input is about ${trace.estimatedPromptTokens} tokens; a request may have at most ` +
            `${MAX_EMBEDDING_TOKENS}. Split it into smaller requests.`,
          'input',
        );
      }

      const deployments = route.targets.map((t) => t.deployment);
      // A malformed Idempotency-Key is a 400 before limits are spent (ADR 032).
      const idemKey = idempotency?.settings.enabled
        ? parseIdempotencyKey(request.headers[IDEMPOTENCY_HEADER])
        : undefined;
      // Embeddings produce no output tokens: the reservation is the input at its price.
      const settlement = await admission.admit({
        key: apiKey,
        trace,
        deployments,
        clientMaxTokens: 0,
        log: request.log,
      });
      const disconnect = watchDisconnect(reply.raw);
      /** The request holding its Idempotency-Key, which completes it with the answer or fails it. */
      let lead: IdempotentLead | undefined;
      try {
        // Guardrails before the model (ADR 035), before the fingerprint, cache key and routing.
        const guard = guardrailsEnabled ? apiKey.guardrails : undefined;
        const findings = new Findings();
        trace.guardrails = findings;
        if (guard) {
          const cap = guard.maxPromptTokens;
          if (cap !== null && trace.estimatedPromptTokens > cap) {
            findings.add('input', 'prompt_size', 'block');
            throw promptTooLarge(trace.estimatedPromptTokens, cap);
          }
          input = scanEmbeddingsInput(input, guard, findings);
          const refusal = blockingError(findings);
          if (refusal) throw refusal;
        }
        const encoding = body.encoding_format ?? 'float';
        const deadlineAt =
          routing.deadlineMs === undefined ? undefined : trace.startedAt + routing.deadlineMs;
        const answer = (data: (number[] | string)[], usage: Usage | null) => {
          setRateLimitHeaders(reply, settlement.rateLimits);
          const tokens = usage?.promptTokens ?? trace.estimatedPromptTokens;
          return {
            object: 'list' as const,
            data: data.map((embedding, index) => ({
              object: 'embedding' as const,
              index,
              embedding,
            })),
            model: body.model,
            usage: { prompt_tokens: tokens, total_tokens: usage?.totalTokens ?? tokens },
          };
        };

        // Idempotency-Key (ADR 032): a repeat is answered with the first request's vectors, waits
        // for them on this instance, or gets 409 / 422; the first request leads.
        if (idempotency && idemKey !== undefined) {
          const replayStored = (stored: StoredResponse) => {
            if (stored.body === null) throw answerNotStored();
            const kept = storedEmbeddingsSchema.safeParse(stored.body);
            if (!kept.success) {
              throw new GatewayError('internal_error', 'Internal server error', {
                httpStatus: 500,
              });
            }
            trace.replayed = true;
            trace.setUsage(kept.data.usage);
            if (!kept.data.usage) trace.estimatePromptOnly();
            for (const [name, value] of Object.entries(stored.headers)) {
              void reply.header(name, value);
            }
            void reply.header(REPLAYED_HEADER, 'true');
            return answer(kept.data.data, kept.data.usage);
          };
          let claim: Claim;
          try {
            claim = await inSpan(
              'db.idempotency_claim',
              trace.traceContext,
              () =>
                idempotency.claim({
                  projectId: apiKey.projectId,
                  endpoint: 'embeddings',
                  key: idemKey,
                  fingerprint: requestFingerprint({ ...body, input }),
                  requestId: request.id,
                  deadlineMs: routing.deadlineMs,
                }),
              POSTGRES_SPAN,
            );
          } catch (err) {
            request.log.warn({ err }, 'idempotency key check failed');
            throw idempotencyUnavailable();
          }
          switch (claim.kind) {
            case 'mismatch':
              throw keyReused();
            case 'busy':
              throw keyInProgress(claim.retryAfterSeconds);
            case 'replay':
              return replayStored(claim.stored);
            case 'wait': {
              let stored: StoredResponse;
              try {
                stored = await inSpan('coalesce.wait', trace.traceContext, () =>
                  follow(claim.flight, {
                    clock,
                    clientSignal: disconnect.signal,
                    deadlineAt,
                  }),
                );
              } catch (err) {
                // Past this request's own deadline it stops waiting: the first still runs.
                if (err instanceof ProviderError && err.kind === 'timeout') throw keyInProgress(1);
                throw upstreamFailure(err);
              }
              return replayStored(stored);
            }
            case 'lead':
              lead = claim.lead;
          }
        }
        /** Stores the vectors under the key, with the routing headers a replay repeats. */
        const keep = async (entry: CachedEmbeddings) => {
          await lead?.complete({ status: 200, headers: replayHeaders(reply), body: entry });
        };

        const header = request.headers[CACHE_HEADER];
        // The cache key also coalesces identical requests in flight (ADR 031), cache on or not.
        const key =
          (cache || coalescer?.enabled) && header !== 'off'
            ? embeddingsCacheKey(apiKey.projectId, body.model, input, requested ?? null, encoding)
            : null;
        if (cache && key) {
          const hit = await inSpan('cache.lookup', trace.traceContext, async (span) => {
            const found = await cache.getEmbeddings(key);
            span.set({ 'gateway.cache_hit': found !== null });
            return found;
          });
          metrics?.cacheLookup(hit !== null);
          void reply.header(CACHE_HEADER, hit ? 'hit' : 'miss');
          if (hit && hit.data.length === input.length) {
            trace.cacheHit = true;
            trace.setUsage(hit.usage);
            if (!hit.usage) trace.estimatePromptOnly();
            await keep(hit);
            return answer(hit.data, hit.usage);
          }
        }

        // Identical requests in flight share one upstream call (ADR 031): a follower waits for
        // the leader's vectors (or error) within its own deadline, and costs nothing.
        const joined =
          coalescer?.enabled && key ? coalescer.join<CachedEmbeddings>(`emb:${key}`) : null;
        if (joined && !joined.leader) {
          trace.coalesced = true;
          metrics?.coalesced('embeddings');
          void reply.header(CACHE_HEADER, 'coalesced');
          let shared: CachedEmbeddings;
          try {
            shared = await inSpan('coalesce.wait', trace.traceContext, () =>
              follow(joined.flight, {
                clock,
                clientSignal: disconnect.signal,
                deadlineAt,
              }),
            );
          } catch (err) {
            throw upstreamFailure(err);
          }
          trace.setUsage(shared.usage);
          if (!shared.usage) trace.estimatePromptOnly();
          await keep(shared);
          return answer(shared.data, shared.usage);
        }
        const flight = joined?.flight;
        // The leader takes part until its client leaves or it ends; the call stops only when
        // nobody waits for it. With an Idempotency-Key, the client leaving cancels nothing: the
        // call finishes within its timeouts and the deadline, and is stored (ADR 032).
        const leaveFlight = flight?.enter('leader');
        if (leaveFlight && !lead) {
          if (disconnect.signal.aborted) leaveFlight();
          else disconnect.signal.addEventListener('abort', leaveFlight, { once: true });
        }

        let served: AttemptContext | undefined;
        try {
          const result = await runRouted(
            routing,
            {
              route,
              trace,
              clock,
              clientSignal:
                flight?.signal ?? (lead ? new AbortController().signal : disconnect.signal),
              log: request.log,
              maxTokens: 0,
              budget: settlement.budget,
            },
            (ctx) => {
              served = ctx;
              return runEmbed(ctx, {
                model: ctx.deployment.providerModel,
                input,
                dimensions: requested,
                user: body.user ?? undefined,
              });
            },
          );
          routingHeaders(reply, served);
          trace.setUsage(result.usage);
          if (!result.usage) trace.estimatePromptOnly();
          const data = result.vectors.map((v) => (encoding === 'base64' ? base64Vector(v) : v));
          const entry: CachedEmbeddings = { data, usage: result.usage };
          flight?.resolve(entry);
          if (cache && key) cache.setEmbeddings(key, entry);
          await keep(entry);
          if ((flight || lead) && disconnect.signal.aborted) {
            // Its client left while followers or its Idempotency-Key kept the call going:
            // recorded as cancelled, with the call's attempt, usage and cost (ADR 031, ADR 032).
            trace.setError('client_closed_request');
            emit(trace, 499);
          }
          return answer(data, result.usage);
        } catch (err) {
          flight?.reject(err);
          throw upstreamFailure(err);
        } finally {
          leaveFlight?.();
        }
      } catch (err) {
        // A key whose request failed is released, so the client may retry with it (ADR 032).
        await lead?.fail(err);
        throw err;
      } finally {
        disconnect.dispose();
        settlement.release();
        // Every path above completes or fails the key; this only guards against a missed one.
        if (lead && !lead.done) {
          await lead.fail(
            new GatewayError('internal_error', 'Internal server error', { httpStatus: 500 }),
          );
        }
      }
    },
  );
}
