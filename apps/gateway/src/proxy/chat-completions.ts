import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { apiKeyAuth } from '../auth/api-key-auth.js';
import type { KeyVerifier } from '../auth/key-verifier.js';
import { GatewayError } from '../errors.js';
import { CACHE_HEADER, cacheable, cacheKey, type ResponseCache } from '../cache/response-cache.js';
import type { EventBus } from '../events/bus.js';
import type { AdmissionControl } from '../limits/admission.js';
import type { GatewayMetrics } from '../metrics.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { runRouted, type RoutingDeps } from '../routing/routed.js';
import type { ChatRequest, ChatResult, FinishReason, Usage } from '../providers/types.js';
import {
  ClientClosedError,
  openStream,
  runChat,
  type AttemptContext,
  type OpenStream,
} from './attempt.js';
import {
  chatCompletionRequestSchema,
  chatCompletionSchema,
  errorBodySchema,
  type ChatCompletion,
  type ChatCompletionRequest,
} from './schema.js';
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

/** An abort signal that fires if the client disconnects before the response is complete. */
function watchDisconnect(res: ServerResponse) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort(new ClientClosedError());
  };
  res.once('close', onClose);
  return { signal: controller.signal, dispose: () => res.off('close', onClose) };
}

function toProviderRequest(
  body: ChatCompletionRequest,
  model: string,
  maxTokens: number,
): ChatRequest {
  const stop = body.stop ?? undefined;
  return {
    model,
    messages: body.messages,
    maxTokens,
    temperature: body.temperature ?? undefined,
    topP: body.top_p ?? undefined,
    stop: typeof stop === 'string' ? [stop] : stop,
    presencePenalty: body.presence_penalty ?? undefined,
    frequencyPenalty: body.frequency_penalty ?? undefined,
    seed: body.seed ?? undefined,
    user: body.user ?? undefined,
  };
}

function wireUsage(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

function toChatCompletion(meta: ResponseMeta, result: ChatResult): ChatCompletion {
  return {
    ...meta,
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content, refusal: null },
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
  try {
    yield write.role();
    let next = stream.first;
    while (!next.done) {
      const event = next.value;
      if (event.type === 'content') {
        trace.addCompletionText(event.text);
        if (onComplete) text.push(event.text);
        if (event.text !== '') yield write.content(event.text);
      } else {
        trace.setUsage(event.usage);
        onComplete?.({
          content: text.join(''),
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

function upstreamFailure(err: unknown): unknown {
  return err instanceof ProviderError ? toGatewayError(err) : err;
}

export function registerChatCompletions(app: FastifyInstance, options: ChatRouteOptions): void {
  const { registry, clock, verifier, events, admission, routing, cache = null, metrics } = options;
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
      const body = request.body;
      const apiKey = request.apiKey;
      if (!apiKey) throw internalError; // The onRequest hook guarantees it.
      const trace = new RequestTrace(
        {
          requestId: request.id,
          projectId: apiKey.projectId,
          apiKeyId: apiKey.apiKeyId,
          model: body.model,
          stream: body.stream === true,
          messages: body.messages,
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
      const route = registry.route(body.model);
      if (!route) {
        throw new GatewayError('model_not_found', `The model \`${body.model}\` does not exist.`, {
          httpStatus: 404,
          param: 'model',
        });
      }

      const clientMaxTokens = body.max_completion_tokens ?? body.max_tokens ?? undefined;
      const deployments = route.targets.map((t) => t.deployment);
      // Limits and budget (M4): throws the 429/503 the client sees, before any provider call.
      const settlement = await admission.admit({
        key: apiKey,
        trace,
        deployments,
        clientMaxTokens,
        log: request.log,
      });
      // From here the settlement is released exactly once: by the stream when it ends, or below.
      let streamOwnsSettlement = false;
      const disconnect = watchDisconnect(reply.raw);
      try {
        const routed = {
          route,
          trace,
          clock,
          clientSignal: disconnect.signal,
          log: request.log,
          maxTokens: clientMaxTokens ?? Math.max(...deployments.map((d) => d.maxOutputTokens)),
        };
        // Each deployment gets its own model name and, unless the client set one, output cap.
        const requestFor = (ctx: AttemptContext) =>
          toProviderRequest(
            body,
            ctx.deployment.providerModel,
            clientMaxTokens ?? ctx.deployment.maxOutputTokens,
          );
        const meta: ResponseMeta = {
          id: `chatcmpl-${request.id}`,
          created: Math.floor(clock.now() / 1000),
          model: body.model,
        };

        // Exact-match cache (ADR 013), after admission so hits still count toward RPM.
        const header = request.headers[CACHE_HEADER];
        const key =
          cache && cacheable(body, typeof header === 'string' ? header : undefined)
            ? cacheKey(apiKey.projectId, body)
            : null;
        if (cache && key) {
          const hit = await cache.get(key);
          metrics?.cacheLookup(hit !== null);
          void reply.header(CACHE_HEADER, hit ? 'hit' : 'miss');
          if (hit) {
            trace.cacheHit = true;
            trace.markFirstToken();
            trace.setUsage(hit.usage);
            trace.addCompletionText(hit.content);
            if (body.stream !== true) return toChatCompletion(meta, hit);
            const write = chunkWriter(meta, body.stream_options?.include_usage === true);
            const chunks = [
              write.role(),
              write.content(hit.content),
              write.finish(hit.finishReason),
              ...(write.includeUsage && hit.usage ? [write.usage(hit.usage)] : []),
              SSE_DONE,
            ];
            void reply
              .header('content-type', 'text/event-stream; charset=utf-8')
              .header('cache-control', 'no-cache');
            return reply.send(Readable.from(chunks, { objectMode: false }) as never);
          }
        }
        const store = cache && key ? (result: ChatResult) => cache.set(key, result) : undefined;

        if (body.stream !== true) {
          try {
            const result = await runRouted(routing, routed, (ctx) => runChat(ctx, requestFor(ctx)));
            trace.setUsage(result.usage);
            trace.addCompletionText(result.content);
            store?.(result);
            return toChatCompletion(meta, result);
          } catch (err) {
            throw upstreamFailure(err);
          }
        }

        let stream: OpenStream;
        try {
          stream = await runRouted(routing, routed, (ctx) => openStream(ctx, requestFor(ctx)));
        } catch (err) {
          throw upstreamFailure(err);
        }
        trace.markFirstToken();
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
          disconnect.dispose();
          settlement.release();
          emit(trace, 200);
        };
        const sse = Readable.from(sseBody(stream, write, request.log, trace, onEnd, store), {
          objectMode: false,
        });
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
      } finally {
        if (!streamOwnsSettlement) {
          disconnect.dispose();
          settlement.release();
        }
      }
    },
  );
}
