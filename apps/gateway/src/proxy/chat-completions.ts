import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Clock } from '@ai-gateway/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { GatewayError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ChatRequest, ChatResult, FinishReason, Usage } from '../providers/types.js';
import { ClientClosedError, openStream, runChat, type OpenStream } from './attempt.js';
import {
  chatCompletionRequestSchema,
  chatCompletionSchema,
  errorBodySchema,
  type ChatCompletion,
  type ChatCompletionRequest,
} from './schema.js';
import { toGatewayError } from './upstream-errors.js';

export interface ChatRouteOptions {
  registry: ProviderRegistry;
  clock: Clock;
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

function toProviderRequest(body: ChatCompletionRequest, model: string): ChatRequest {
  const stop = body.stop ?? undefined;
  return {
    model,
    messages: body.messages,
    maxTokens: body.max_completion_tokens ?? body.max_tokens ?? undefined,
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
  onEnd: () => void,
): AsyncGenerator<string> {
  let completed = false;
  let failure: unknown;
  try {
    yield write.role();
    let next = stream.first;
    while (!next.done) {
      const event = next.value;
      if (event.type === 'content') {
        if (event.text !== '') yield write.content(event.text);
      } else {
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
    yield write.error(err instanceof ProviderError ? toGatewayError(err) : internalError);
  } finally {
    // Not completed and no failure means the client went away while we waited to write.
    const outcome =
      completed || failure !== undefined
        ? failure
        : new ProviderError('canceled', 'client closed the stream');
    stream.close(outcome);
    onEnd();
  }
}

function upstreamFailure(err: unknown): unknown {
  return err instanceof ProviderError ? toGatewayError(err) : err;
}

export function registerChatCompletions(app: FastifyInstance, options: ChatRouteOptions): void {
  const { registry, clock } = options;

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/chat/completions',
    {
      schema: {
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
      const deployment = registry.resolve(body.model);
      if (!deployment) {
        throw new GatewayError('model_not_found', `The model \`${body.model}\` does not exist.`, {
          httpStatus: 404,
          param: 'model',
        });
      }

      const disconnect = watchDisconnect(reply.raw);
      const ctx = { deployment, clock, clientSignal: disconnect.signal, log: request.log };
      const providerRequest = toProviderRequest(body, deployment.providerModel);
      const meta: ResponseMeta = {
        id: `chatcmpl-${request.id}`,
        created: Math.floor(clock.now() / 1000),
        model: body.model,
      };

      if (body.stream !== true) {
        try {
          return toChatCompletion(meta, await runChat(ctx, providerRequest));
        } catch (err) {
          throw upstreamFailure(err);
        } finally {
          disconnect.dispose();
        }
      }

      let stream: OpenStream;
      try {
        stream = await openStream(ctx, providerRequest);
      } catch (err) {
        disconnect.dispose();
        throw upstreamFailure(err);
      }
      const write = chunkWriter(meta, body.stream_options?.include_usage === true);
      void reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache')
        .header('x-accel-buffering', 'no');
      const sse = Readable.from(sseBody(stream, write, request.log, disconnect.dispose), {
        objectMode: false,
      });
      // The typed reply expects the JSON schema's shape; Fastify pipes streams without serializing.
      return reply.send(sse as never);
    },
  );
}
