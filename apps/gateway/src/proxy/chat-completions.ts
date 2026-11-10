import { inSpan, POSTGRES_SPAN } from '@ai-gateway/shared/node';
import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { apiKeyAuth } from '../auth/api-key-auth.js';
import type { KeyVerifier } from '../auth/key-verifier.js';
import { GatewayError } from '../errors.js';
import { CACHE_HEADER, cacheable, cacheKey, type ResponseCache } from '../cache/response-cache.js';
import type { EventBus } from '../events/bus.js';
import type { AdmissionControl } from '../limits/admission.js';
import type { GatewayMetrics } from '../metrics.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { fitRoute, needsOf } from '../routing/capabilities.js';
import type { RouteOverrides } from '../routing/overrides.js';
import { runRouted, type RoutingDeps } from '../routing/routed.js';
import { SEMANTIC_HEADER, semanticRequested, SIMILARITY_HEADER } from '../semantic/policy.js';
import type { AnsweredBy, SemanticCache } from '../semantic/semantic-cache.js';
import type {
  ChatMessage,
  ChatRequest,
  ChatResult,
  FinishReason,
  ToolCall,
  Usage,
} from '../providers/types.js';
import {
  ClientClosedError,
  openStream,
  runChat,
  type AttemptContext,
  type OpenStream,
} from './attempt.js';
import { follow, shareStream, type Coalescer } from './coalesce.js';
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
import { estimateChatPromptTokens } from './estimate.js';
import { checksOutput } from '../guardrails/policy.js';
import {
  answerMatchesFormat,
  blockingError,
  Findings,
  scanAnswer,
  scanChatInput,
  scanStream,
} from '../guardrails/scan.js';
import {
  chatCompletionRequestSchema,
  chatCompletionSchema,
  errorBodySchema,
  type ChatCompletion,
  type ChatCompletionMessage,
  type ChatCompletionRequest,
} from './schema.js';
import { setRateLimitHeaders } from './rate-limit-headers.js';
import { replayHeaders, routingHeaders } from './routing-headers.js';
import { RequestTrace } from './trace.js';
import { toGatewayError } from './upstream-errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The request's lifecycle record on /v1 routes, emitted as a usage event at the end. */
    trace: RequestTrace | null;
  }
}

export interface ChatRouteOptions {
  registry: ProviderRegistry;
  clock: Clock;
  verifier: KeyVerifier;
  events: EventBus;
  admission: AdmissionControl;
  routing: RoutingDeps;
  /** The exact-match response cache (ADR 013); absent when CACHE_ENABLED is off. */
  cache?: ResponseCache | null;
  /** Identical cacheable requests in flight share one upstream call (ADR 031). */
  coalescer?: Coalescer | null;
  /** Answers from a similar earlier request, where projects opt in (ADR 040). */
  semanticCache?: SemanticCache | null;
  /** Idempotency-Key: a retry is answered with the first answer (ADR 032). */
  idempotency?: IdempotencyGate | null;
  /** Per-project route overrides (ADR 034); without them, the models file's routes. */
  routeOverrides?: RouteOverrides | null;
  /** Each project's guardrails run (GUARDRAILS_ENABLED, ADR 035). */
  guardrailsEnabled?: boolean;
  /** Records each finished request (attempts, routing, latency, tokens). */
  metrics?: GatewayMetrics;
}

interface ResponseMeta {
  id: string;
  created: number;
  model: string;
}

const internalError = new GatewayError('internal_error', 'Internal server error', {
  httpStatus: 500,
});

/** A prompt above the project's cap (ADR 035): refused before any provider call. */
export const promptTooLarge = (estimated: number, cap: number) =>
  new GatewayError(
    'guardrail_prompt_too_large',
    `The prompt is about ${estimated} tokens; this project's guardrails allow at most ${cap}.`,
    { httpStatus: 400 },
  );

/** A JSON answer that failed its schema, also on the next deployment (ADR 035). */
const outputFailed = () =>
  new GatewayError(
    'guardrail_output_failed',
    "The model's answer did not match the requested JSON format, also after a retry.",
    { httpStatus: 502 },
  );

/** What an Idempotency-Key keeps of a chat answer (ADR 032): the response's ID and the answer. */
const storedChatSchema = z.object({
  meta: z.object({ id: z.string(), created: z.number(), model: z.string() }),
  answer: z.object({
    content: z.string(),
    toolCalls: z
      .array(z.object({ id: z.string(), name: z.string(), arguments: z.string() }))
      .optional(),
    finishReason: z.enum(['stop', 'length', 'content_filter', 'tool_calls']),
    usage: z
      .object({
        promptTokens: z.number().int().min(0),
        completionTokens: z.number().int().min(0),
        totalTokens: z.number().int().min(0),
      })
      .nullable(),
  }),
});

/** An abort signal that fires if the client disconnects before the response is complete. */
export function watchDisconnect(res: ServerResponse): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new ClientClosedError());
  };
  res.once('close', onClose);
  return { signal: controller.signal, dispose: () => res.off('close', onClose) };
}

/** A message in the provider seam's form (providers/types.ts). */
function toProviderMessage(m: ChatCompletionMessage): ChatMessage {
  switch (m.role) {
    case 'user':
      return {
        role: 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((part) =>
                part.type === 'text'
                  ? part
                  : {
                      type: 'image',
                      url: part.image_url.url,
                      detail: part.image_url.detail ?? undefined,
                    },
              ),
        name: m.name,
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content ?? null,
        name: m.name,
        toolCalls: m.tool_calls?.map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      };
    case 'tool':
      return { role: 'tool', content: m.content, toolCallId: m.tool_call_id };
    default:
      return { role: m.role, content: m.content, name: m.name };
  }
}

/** The provider request without the deployment's model and output cap. */
type BaseRequest = Omit<ChatRequest, 'model' | 'maxTokens'>;

function toBaseRequest(body: ChatCompletionRequest): BaseRequest {
  const stop = body.stop ?? undefined;
  const choice = body.tool_choice ?? undefined;
  const format = body.response_format ?? undefined;
  return {
    messages: body.messages.map(toProviderMessage),
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stop: typeof stop === 'string' ? [stop] : stop,
    presencePenalty: body.presence_penalty ?? undefined,
    frequencyPenalty: body.frequency_penalty ?? undefined,
    seed: body.seed ?? undefined,
    user: body.user ?? undefined,
    tools: body.tools?.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? undefined,
      parameters: t.function.parameters ?? undefined,
      strict: t.function.strict ?? undefined,
    })),
    toolChoice: typeof choice === 'object' ? { name: choice.function.name } : choice,
    parallelToolCalls: body.parallel_tool_calls ?? undefined,
    // `text` is what a model does without a format, so it is not sent.
    responseFormat:
      format === undefined || format.type === 'text'
        ? undefined
        : format.type === 'json_object'
          ? format
          : {
              type: 'json_schema',
              name: format.json_schema.name,
              description: format.json_schema.description ?? undefined,
              schema: format.json_schema.schema ?? undefined,
              strict: format.json_schema.strict ?? undefined,
            },
  };
}

const wireToolCalls = (calls: readonly ToolCall[]) =>
  calls.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: c.arguments },
  }));

function wireUsage(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function toChatCompletion(meta: ResponseMeta, result: ChatResult): ChatCompletion {
  const toolCalls = result.toolCalls ?? [];
  return {
    ...meta,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI's shape: null content when the model only called tools.
          content: toolCalls.length > 0 && result.content === '' ? null : result.content,
          refusal: null,
          ...(toolCalls.length > 0 ? { tool_calls: wireToolCalls(toolCalls) } : {}),
        },
        finish_reason: result.finishReason,
        logprobs: null,
      },
    ],
    ...(result.usage ? { usage: wireUsage(result.usage) } : {}),
  };
}

const sseData = (json: string) => `data: ${json}\n\n`;
const SSE_DONE = 'data: [DONE]\n\n';

/** OpenAI `chat.completion.chunk` events, as SSE lines. */
function chunkWriter(meta: ResponseMeta, includeUsage: boolean) {
  const chunk = (choices: unknown[], usage: Usage | null = null) =>
    sseData(
      JSON.stringify({
        ...meta,
        object: 'chat.completion.chunk',
        choices,
        // With include_usage, every chunk carries `usage: null` except the final usage chunk.
        ...(includeUsage ? { usage: usage ? wireUsage(usage) : null } : {}),
      }),
    );
  const choice = (delta: object, finishReason: FinishReason | null = null) => ({
    index: 0,
    delta,
    logprobs: null,
    finish_reason: finishReason,
  });
  return {
    includeUsage,
    role: () => chunk([choice({ role: 'assistant', content: '' })]),
    content: (text: string) => chunk([choice({ content: text })]),
    // A tool call's first delta has its index, ID, type and name; its arguments follow in pieces.
    toolCall: (index: number, id: string, name: string) =>
      chunk([
        choice({
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
        }),
      ]),
    toolArguments: (index: number, text: string) =>
      chunk([choice({ tool_calls: [{ index, function: { arguments: text } }] })]),
    finish: (reason: FinishReason) => chunk([choice({}, reason)]),
    usage: (usage: Usage) => chunk([], usage),
    error: (error: GatewayError) => sseData(JSON.stringify(error.toBody())),
  };
}

/**
 * The SSE body. Errors after the first byte cannot change the status code, so they are sent as
 * an OpenAI-style `{"error": ...}` event and the stream ends without `[DONE]`.
 */
async function* sseBody(
  stream: OpenStream,
  write: ReturnType<typeof chunkWriter>,
  log: FastifyBaseLogger,
  trace: RequestTrace,
  onEnd: () => void,
  /** Called with the whole response when the stream completes (to cache it). */
  onComplete?: (result: ChatResult) => void,
): AsyncGenerator<string> {
  let completed = false;
  let failure: unknown;
  const text: string[] = [];
  const calls: ToolCall[] = [];
  try {
    yield write.role();
    let next = stream.first;
    while (!next.done) {
      const event = next.value;
      if (event.type === 'content') {
        trace.addCompletionText(event.text);
        if (onComplete) text.push(event.text);
        if (event.text !== '') yield write.content(event.text);
      } else if (event.type === 'tool_call') {
        trace.addCompletionText(event.name);
        calls[event.index] = { id: event.id, name: event.name, arguments: '' };
        yield write.toolCall(event.index, event.id, event.name);
      } else if (event.type === 'tool_arguments') {
        trace.addCompletionText(event.text);
        const call = calls[event.index];
        if (call) call.arguments += event.text;
        yield write.toolArguments(event.index, event.text);
      } else {
        trace.setUsage(event.usage);
        const toolCalls = calls.filter((call) => call !== undefined);
        onComplete?.({
          content: text.join(''),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          finishReason: event.finishReason,
          usage: event.usage,
        });
        yield write.finish(event.finishReason);
        if (write.includeUsage && event.usage) yield write.usage(event.usage);
        yield SSE_DONE;
        completed = true;
        return;
      }
      next = await stream.next();
    }
    throw new ProviderError('connection', 'stream ended without a finish event');
  } catch (err) {
    failure = err;
    if (err instanceof ProviderError && err.kind === 'canceled') return;
    if (!(err instanceof ProviderError)) log.error({ err }, 'stream failed unexpectedly');
    const error = err instanceof ProviderError ? toGatewayError(err) : internalError;
    trace.setError(error.code);
    yield write.error(error);
  } finally {
    // Not completed and no failure means the client went away while we waited to write.
    const outcome =
      completed || failure !== undefined
        ? failure
        : new ProviderError('canceled', 'client closed the stream');
    if (outcome instanceof ProviderError && outcome.kind === 'canceled') {
      trace.setError(toGatewayError(outcome).code);
    }
    stream.close(outcome);
    onEnd();
  }
}

export function upstreamFailure(err: unknown): unknown {
  return err instanceof ProviderError ? toGatewayError(err) : err;
}

export function registerChatCompletions(app: FastifyInstance, options: ChatRouteOptions): void {
  const {
    registry,
    clock,
    verifier,
    events,
    admission,
    routing,
    cache = null,
    coalescer = null,
    semanticCache = null,
    idempotency = null,
    routeOverrides = null,
    guardrailsEnabled = false,
    metrics,
  } = options;
  app.decorateRequest('apiKey', null);
  app.decorateRequest('trace', null);

  /** Hands the finished trace to the event bus; publish() never blocks the response. */
  const emit = (trace: RequestTrace, httpStatus: number) => {
    const event = trace.finish(httpStatus);
    if (!event) return;
    events.publish(event);
    metrics?.requestFinished(event);
  };

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/chat/completions',
    {
      // Before body validation, so unauthenticated callers learn nothing about the payload.
      onRequest: apiKeyAuth(verifier),
      onError: (request, _reply, err, done) => {
        request.trace?.setError(err instanceof GatewayError ? err.code : 'internal_error');
        done();
      },
      // Streams finish their own trace when the body ends; everything else finishes here.
      onResponse: (request, reply, done) => {
        if (request.trace && !request.trace.streaming) emit(request.trace, reply.statusCode);
        done();
      },
      schema: {
        tags: ['chat'],
        security: [{ apiKey: [] }],
        summary: 'Create a chat completion (OpenAI-compatible)',
        description:
          'With `stream: true` the response is `text/event-stream`: `chat.completion.chunk` ' +
          'events, ending with `data: [DONE]`.',
        body: chatCompletionRequestSchema,
        response: { 200: chatCompletionSchema, '4xx': errorBodySchema, '5xx': errorBodySchema },
      },
    },
    async (request, reply) => {
      // Replaced by the masked request when this project's guardrails mask a value (ADR 035).
      let body = request.body;
      const apiKey = request.apiKey;
      if (!apiKey) throw internalError; // The onRequest hook guarantees it.
      let base = toBaseRequest(body);
      const trace = new RequestTrace(
        {
          requestId: request.id,
          projectId: apiKey.projectId,
          apiKeyId: apiKey.apiKeyId,
          model: body.model,
          stream: body.stream === true,
          // Tools, tool calls, schemas and images count too (ADR 028).
          estimatedPromptTokens: estimateChatPromptTokens(base),
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
      const modelRoute =
        fileRoute && routeOverrides ? routeOverrides.apply(apiKey.projectId, fileRoute) : fileRoute;
      if (!modelRoute) {
        throw new GatewayError('model_not_found', `The model \`${body.model}\` does not exist.`, {
          httpStatus: 404,
          param: 'model',
        });
      }
      if (modelRoute.type !== 'chat') {
        throw new GatewayError(
          'model_endpoint_mismatch',
          `The model \`${body.model}\` is an embeddings model: send it to /v1/embeddings.`,
          { httpStatus: 400, param: 'model' },
        );
      }
      // Only deployments that can serve tools, JSON output or images, as the request needs
      // (ADR 028); none left is a 400 before any provider call or budget reservation.
      const fitted = fitRoute(modelRoute, needsOf(base));
      const route = fitted.route;
      if (!route) {
        const missing = fitted.missing!;
        throw new GatewayError(
          'model_capability_unsupported',
          `No deployment of the model \`${body.model}\` supports ${missing.what}.`,
          { httpStatus: 400, param: missing.param },
        );
      }

      const clientMaxTokens = body.max_completion_tokens ?? body.max_tokens ?? undefined;
      const deployments = route.targets.map((t) => t.deployment);
      // A malformed Idempotency-Key is a 400 before limits are spent (ADR 032).
      const idemKey = idempotency?.settings.enabled
        ? parseIdempotencyKey(request.headers[IDEMPOTENCY_HEADER])
        : undefined;
      // Limits and budget (M4): throws the 429/503 the client sees, before any provider call.
      const settlement = await admission.admit({
        key: apiKey,
        trace,
        deployments,
        clientMaxTokens,
        log: request.log,
      });
      // On every successful reply: what the key's or project's RPM and TPM limits have left.
      const limitHeaders = () => setRateLimitHeaders(reply, settlement.rateLimits);
      // From here the settlement is released exactly once: by the stream when it ends, or below.
      let streamOwnsSettlement = false;
      const disconnect = watchDisconnect(reply.raw);
      /** The request holding its Idempotency-Key, which completes it with the answer or fails it. */
      let lead: IdempotentLead | undefined;
      try {
        // Guardrails before the model (ADR 035): after authentication and admission, and before
        // the idempotency fingerprint, the cache key, coalescing and routing, so nothing stored
        // or sent upstream holds a value this project masks.
        const guard = guardrailsEnabled ? apiKey.guardrails : undefined;
        const findings = new Findings();
        trace.guardrails = findings;
        if (guard) {
          const cap = guard.maxPromptTokens;
          if (cap !== null && trace.estimatedPromptTokens > cap) {
            findings.add('input', 'prompt_size', 'block');
            throw promptTooLarge(trace.estimatedPromptTokens, cap);
          }
          body = scanChatInput(body, guard, findings);
          const refusal = blockingError(findings);
          if (refusal) throw refusal;
          base = toBaseRequest(body);
        }
        const outputGuard = guard && checksOutput(guard) ? guard : undefined;
        const meta: ResponseMeta = {
          id: `chatcmpl-${request.id}`,
          created: Math.floor(clock.now() / 1000),
          model: body.model,
        };
        const deadlineAt =
          routing.deadlineMs === undefined ? undefined : trace.startedAt + routing.deadlineMs;
        /** Answers with a complete answer the request did not call for: a hit, a flight's or a replay. */
        const replay = (answer: ChatResult, m: ResponseMeta = meta) => {
          trace.markFirstToken();
          trace.setUsage(answer.usage);
          trace.addCompletionText(answer.content);
          limitHeaders();
          return respond(answer, m);
        };
        /** The answer as JSON, or replayed as a stream when the client asked for one. */
        const respond = (answer: ChatResult, m: ResponseMeta = meta) => {
          if (body.stream !== true) return toChatCompletion(m, answer);
          const write = chunkWriter(m, body.stream_options?.include_usage === true);
          const chunks = [
            write.role(),
            ...(answer.content !== '' || !answer.toolCalls?.length
              ? [write.content(answer.content)]
              : []),
            ...(answer.toolCalls ?? []).flatMap((call, index) => [
              write.toolCall(index, call.id, call.name),
              write.toolArguments(index, call.arguments),
            ]),
            write.finish(answer.finishReason),
            ...(write.includeUsage && answer.usage ? [write.usage(answer.usage)] : []),
            SSE_DONE,
          ];
          void reply
            .header('content-type', 'text/event-stream; charset=utf-8')
            .header('cache-control', 'no-cache');
          return reply.send(Readable.from(chunks, { objectMode: false }) as never);
        };

        // Idempotency-Key (ADR 032): a repeat is answered with the first request's answer, waits
        // for it on this instance, or gets 409 / 422; the first request leads.
        if (idempotency && idemKey !== undefined) {
          const replayStored = (stored: StoredResponse) => {
            if (stored.body === null) throw answerNotStored();
            const kept = storedChatSchema.safeParse(stored.body);
            if (!kept.success) throw internalError;
            trace.replayed = true;
            for (const [name, value] of Object.entries(stored.headers)) {
              void reply.header(name, value);
            }
            void reply.header(REPLAYED_HEADER, 'true');
            return replay(kept.data.answer, kept.data.meta);
          };
          let claim: Claim;
          try {
            claim = await inSpan(
              'db.idempotency_claim',
              trace.traceContext,
              () =>
                idempotency.claim({
                  projectId: apiKey.projectId,
                  endpoint: 'chat',
                  key: idemKey,
                  fingerprint: requestFingerprint(body),
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
        /** Stores the answer under the key, with the routing headers a replay repeats. */
        const keep = async (answer: ChatResult) => {
          await lead?.complete({
            status: 200,
            headers: replayHeaders(reply),
            body: { meta, answer },
          });
        };

        const routed = {
          route,
          trace,
          clock,
          clientSignal: disconnect.signal,
          log: request.log,
          stream: body.stream === true,
          maxTokens: clientMaxTokens ?? Math.max(...deployments.map((d) => d.maxOutputTokens)),
          budget: settlement.budget,
          unfit: fitted.unfit,
        };
        // Each deployment gets its own model name and, unless the client set one, output cap.
        // The last attempt started is the one that answered when runRouted resolves.
        let served: AttemptContext | undefined;
        const requestFor = (ctx: AttemptContext) => {
          served = ctx;
          return {
            ...base,
            model: ctx.deployment.providerModel,
            maxTokens: clientMaxTokens ?? ctx.deployment.maxOutputTokens,
          };
        };

        // Exact-match cache (ADR 013), after admission so hits still count toward RPM. The same
        // key coalesces identical requests in flight (ADR 031), whether the cache is on or not.
        const header = request.headers[CACHE_HEADER];
        const reusable = cacheable(body, typeof header === 'string' ? header : undefined);
        const key =
          reusable && (cache || coalescer?.enabled) ? cacheKey(apiKey.projectId, body) : null;
        if (cache && key) {
          const hit = await inSpan('cache.lookup', trace.traceContext, async (span) => {
            const found = await cache.get(key);
            span.set({ 'gateway.cache_hit': found !== null });
            return found;
          });
          metrics?.cacheLookup(hit !== null);
          void reply.header(CACHE_HEADER, hit ? 'hit' : 'miss');
          if (hit) {
            trace.cacheHit = true;
            await keep(hit);
            return replay(hit);
          }
        }
        const store = cache && key ? (result: ChatResult) => cache.set(key, result) : undefined;

        // Identical requests in flight share one upstream call (ADR 031): a follower waits for
        // the leader's answer (or error) within its own deadline, and is replayed it like a hit.
        const joined = coalescer?.enabled && key ? coalescer.join<ChatResult>(`chat:${key}`) : null;
        if (joined && !joined.leader) {
          trace.coalesced = true;
          metrics?.coalesced('chat');
          void reply.header(CACHE_HEADER, 'coalesced');
          let answer: ChatResult;
          try {
            answer = await inSpan('coalesce.wait', trace.traceContext, () =>
              follow(joined.flight, {
                clock,
                clientSignal: disconnect.signal,
                deadlineAt,
              }),
            );
          } catch (err) {
            throw upstreamFailure(err);
          }
          await keep(answer);
          return replay(answer);
        }
        const flight = joined?.flight;
        // The leader takes part in its flight until its client leaves or its request ends; the
        // upstream call follows the flight's signal, which aborts only when nobody waits. With an
        // Idempotency-Key, the client leaving cancels nothing: the call finishes within its
        // timeouts and the deadline, and its answer is stored for the retry (ADR 032).
        const leaveFlight = flight?.enter('leader');
        if (leaveFlight && !lead) {
          if (disconnect.signal.aborted) leaveFlight();
          else disconnect.signal.addEventListener('abort', leaveFlight, { once: true });
        }
        const callSignal = flight?.signal ?? (lead ? new AbortController().signal : undefined);
        const call = callSignal ? { ...routed, clientSignal: callSignal } : routed;

        // Semantic cache (ADR 040): requests the exact cache would take, after its miss, by the
        // flight's leader only (followers wait for its answer), where the project's mode and the
        // request's header ask for it. Any failure leaves a normal miss.
        const semanticHeader = request.headers[SEMANTIC_HEADER];
        const semanticPolicy = apiKey.semanticCache;
        const semantic =
          semanticCache &&
          reusable &&
          semanticPolicy &&
          semanticRequested(
            semanticPolicy,
            typeof semanticHeader === 'string' ? semanticHeader : undefined,
          )
            ? await inSpan('semantic_cache.lookup', trace.traceContext, async (span) => {
                const found = await semanticCache.lookup({
                  body,
                  policy: semanticPolicy,
                  call: {
                    requestId: request.id,
                    projectId: apiKey.projectId,
                    apiKeyId: apiKey.apiKeyId,
                    traceContext: trace.traceContext,
                    clientSignal: call.clientSignal,
                    log: request.log,
                    deadlineAt,
                  },
                });
                if (found) span.set({ 'gateway.semantic_cache': found.record.outcome });
                return found;
              })
            : null;
        if (semantic) {
          trace.semanticCache = semantic.record;
          metrics?.semanticLookup(semantic.record.outcome);
          if (semantic.hit) {
            trace.cacheHit = true;
            void reply.header(CACHE_HEADER, 'semantic');
            void reply.header(SIMILARITY_HEADER, (semantic.record.similarity ?? 0).toFixed(4));
            flight?.resolve(semantic.hit);
            leaveFlight?.();
            await keep(semantic.hit);
            return replay(semantic.hit);
          }
        }
        /** Who made the answer: the deployment that served it, for the cost a later hit avoids. */
        const answeredBy = (): AnsweredBy | null =>
          served
            ? {
                provider: served.deployment.providerName,
                providerModel: served.deployment.providerModel,
                billing: served.deployment.billing,
              }
            : null;
        const remember = semantic?.store
          ? (result: ChatResult) => void semantic.store?.(result, answeredBy())
          : undefined;

        /**
         * Checks after the model (ADR 035): a JSON answer against its schema (flag, or retry once
         * on the route's next deployment, then 502), then the detectors' masks.
         */
        const checkAnswer = async (first: ChatResult, plain: typeof call): Promise<ChatResult> => {
          if (!outputGuard) return first;
          let answer = first;
          const schema = outputGuard.output.schema;
          if (schema !== 'off' && !answerMatchesFormat(body.response_format, answer)) {
            if (schema === 'flag') {
              findings.add('output', 'schema', 'flag');
            } else {
              findings.add('output', 'schema', 'retry');
              const tried = served?.deployment.id;
              const rest = route.targets.filter((t) => t.deployment.id !== tried);
              if (rest.length === 0) {
                findings.add('output', 'schema', 'fail');
                throw outputFailed();
              }
              answer = await runRouted(
                routing,
                { ...plain, route: { ...route, targets: rest }, unfit: undefined },
                (ctx) => runChat(ctx, requestFor(ctx)),
              );
              if (!answerMatchesFormat(body.response_format, answer)) {
                findings.add('output', 'schema', 'fail');
                throw outputFailed();
              }
            }
          }
          return scanAnswer(answer, outputGuard, findings);
        };
        /** A streamed answer's schema, checked when the stream has ended: recorded only. */
        const flagSchema = (answer: ChatResult) => {
          if (outputGuard && outputGuard.output.schema !== 'off') {
            if (!answerMatchesFormat(body.response_format, answer)) {
              findings.add('output', 'schema', 'flag');
            }
          }
        };
        // A streamed request whose schema check may retry needs the whole answer before its first
        // byte: it is called without streaming and replayed as a stream (ADR 035).
        const wholeAnswer =
          body.stream !== true ||
          (outputGuard?.output.schema === 'retry' &&
            (body.response_format?.type === 'json_schema' ||
              body.response_format?.type === 'json_object'));

        if (wholeAnswer) {
          const plain = body.stream === true ? { ...call, stream: false } : call;
          try {
            const result = await checkAnswer(
              await runRouted(routing, plain, (ctx) => runChat(ctx, requestFor(ctx))),
              plain,
            );
            flight?.resolve(result);
            routingHeaders(reply, served);
            limitHeaders();
            trace.setUsage(result.usage);
            trace.addCompletionText(result.content);
            for (const toolCall of result.toolCalls ?? []) {
              trace.addCompletionText(`${toolCall.name} ${toolCall.arguments}`);
            }
            store?.(result);
            remember?.(result);
            await keep(result);
            if ((flight || lead) && disconnect.signal.aborted) {
              // Its client left while followers or its Idempotency-Key kept the call going:
              // recorded as cancelled, with the call's attempt, usage and cost, since nothing
              // else carries them (ADR 031, ADR 032).
              trace.setError('client_closed_request');
              emit(trace, 499);
            }
            if (body.stream === true) trace.markFirstToken();
            return respond(result);
          } catch (err) {
            flight?.reject(err);
            throw upstreamFailure(err);
          } finally {
            leaveFlight?.();
          }
        }

        let stream: OpenStream;
        try {
          stream = await runRouted(routing, call, (ctx) => openStream(ctx, requestFor(ctx)));
        } catch (err) {
          flight?.reject(err);
          leaveFlight?.();
          throw upstreamFailure(err);
        }
        // Answers are scanned as they stream, holding back what a match could still need, so
        // followers, the cache and the stored answer get the masked text too (ADR 035).
        if (outputGuard) stream = scanStream(stream, outputGuard, findings);
        /** The whole streamed answer: its schema flagged, then cached. */
        const answered = (result: ChatResult) => {
          flagSchema(result);
          store?.(result);
          remember?.(result);
        };
        // Followers get the whole answer; a leader whose client leaves is read to the end for
        // them, or for its Idempotency-Key, and its record waits for that (ADR 031, ADR 032).
        const holder = lead;
        const shared =
          flight || holder
            ? shareStream(stream, flight, trace, {
                onAnswer: (result) => {
                  answered(result);
                  void keep(result);
                },
                onFailure: (err) => void holder?.fail(err),
                keepReading: holder !== undefined,
              })
            : undefined;
        if (shared) stream = shared;
        trace.markFirstToken();
        routingHeaders(reply, served);
        limitHeaders();
        const write = chunkWriter(meta, body.stream_options?.include_usage === true);
        void reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-cache')
          .header('x-accel-buffering', 'no');
        trace.streaming = true;
        let ended = false;
        const onEnd = () => {
          if (ended) return;
          ended = true;
          const done = () => {
            leaveFlight?.();
            disconnect.dispose();
            settlement.release();
            emit(trace, 200);
          };
          if (shared) shared.whenClosed(done);
          else done();
        };
        const sse = Readable.from(
          sseBody(stream, write, request.log, trace, onEnd, shared ? undefined : answered),
          { objectMode: false },
        );
        streamOwnsSettlement = true;
        reply.raw.once('close', () => {
          // A body generator that never started never runs its cleanup (a client that left
          // before the first chunk), so end the stream here; give a started one a tick first.
          setImmediate(() => {
            if (ended) return;
            const canceled = new ProviderError('canceled', 'client closed the stream');
            trace.setError(toGatewayError(canceled).code);
            stream.close(canceled);
            onEnd();
          });
        });
        // The typed reply expects the JSON schema's shape; Fastify pipes streams without serializing.
        return reply.send(sse as never);
      } catch (err) {
        // A key whose request failed is released, so the client may retry with it (ADR 032).
        if (lead && !streamOwnsSettlement) await lead.fail(err);
        throw err;
      } finally {
        if (!streamOwnsSettlement) {
          disconnect.dispose();
          settlement.release();
        }
        // Every path above completes or fails the key; this only guards against a missed one.
        if (lead && !lead.done && !streamOwnsSettlement) await lead.fail(internalError);
      }
    },
  );
}
