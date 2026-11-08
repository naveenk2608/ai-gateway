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
import { fitRoute, needsOf } from '../routing/capabilities.js';
import { runRouted, type RoutingDeps } from '../routing/routed.js';
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
import { estimateChatPromptTokens } from './estimate.js';
import {
  chatCompletionRequestSchema,
  chatCompletionSchema,
  errorBodySchema,
  type ChatCompletion,
  type ChatCompletionMessage,
  type ChatCompletionRequest,
} from './schema.js';
import { setRateLimitHeaders } from './rate-limit-headers.js';
import { routingHeaders } from './routing-headers.js';
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
      const base = toBaseRequest(body);
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
      const modelRoute = registry.route(body.model);
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
      try {
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
            limitHeaders();
            if (body.stream !== true) return toChatCompletion(meta, hit);
            const write = chunkWriter(meta, body.stream_options?.include_usage === true);
            const chunks = [
              write.role(),
              ...(hit.content !== '' || !hit.toolCalls?.length ? [write.content(hit.content)] : []),
              ...(hit.toolCalls ?? []).flatMap((call, index) => [
                write.toolCall(index, call.id, call.name),
                write.toolArguments(index, call.arguments),
              ]),
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
            routingHeaders(reply, served);
            limitHeaders();
            trace.setUsage(result.usage);
            trace.addCompletionText(result.content);
            for (const call of result.toolCalls ?? []) {
              trace.addCompletionText(`${call.name} ${call.arguments}`);
            }
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
