import type { Clock } from '@ai-gateway/shared';
import { Agent } from 'undici';
import { z } from 'zod';
import { ProviderError } from './errors.js';
import { MAX_RESPONSE_BYTES, networkError, parseJson, postJson, readText } from './http.js';
import { parseSse } from './line-stream.js';
import type {
  ChatRequest,
  ChatResult,
  FinishReason,
  Provider,
  StreamEvent,
  Usage,
} from './types.js';

export interface OpenAICompatibleOptions {
  /** API root, e.g. https://api.openai.com/v1; `/chat/completions` is appended. */
  baseUrl: string;
  apiKey: string;
  clock: Clock;
  maxResponseBytes?: number;
}

const wireUsage = z.object({
  prompt_tokens: z.number().int().min(0),
  completion_tokens: z.number().int().min(0),
  total_tokens: z.number().int().min(0).optional(),
});

// Upstream payloads are untrusted: validate only the fields we use and ignore the rest.
const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: wireUsage.nullish(),
});

const chunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .default([]),
  usage: wireUsage.nullish(),
});

const streamErrorSchema = z.object({ error: z.unknown() });

function toUsage(usage: z.output<typeof wireUsage> | null | undefined): Usage | null {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
  };
}

function toFinishReason(reason: string | null | undefined): FinishReason {
  return reason === 'length' || reason === 'content_filter' ? reason : 'stop';
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProviderError('invalid_response', 'upstream response has an unexpected shape', {
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Any server that speaks OpenAI's chat-completions API (ADR 004: undici, one AbortSignal per
 * attempt). Streams ask for usage in the final chunk via `stream_options.include_usage`.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly kind = 'openai-compatible' as const;
  readonly #url: string;
  readonly #apiKey: string;
  readonly #clock: Clock;
  readonly #maxResponseBytes: number;
  readonly #agent = new Agent({ connect: { timeout: 10_000 } });

  constructor(options: OpenAICompatibleOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.#apiKey = options.apiKey;
    this.#clock = options.clock;
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  async chat(req: ChatRequest, signal: AbortSignal): Promise<ChatResult> {
    const response = await this.#post(req, false, signal);
    let text: string;
    try {
      text = await readText(response.body, this.#maxResponseBytes);
    } catch (err) {
      throw networkError(err, signal);
    }
    const completion = validate(completionSchema, parseJson(text));
    const choice = completion.choices[0]!;
    return {
      content: choice.message.content ?? '',
      finishReason: toFinishReason(choice.finish_reason),
      usage: toUsage(completion.usage),
    };
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const response = await this.#post(req, true, signal);
    let finishReason: FinishReason | undefined;
    let usage: Usage | null = null;
    try {
      for await (const { data } of parseSse(response.body)) {
        if (data === '[DONE]') break;
        const payload = parseJson(data);
        if (streamErrorSchema.safeParse(payload).success) {
          throw new ProviderError('server_error', 'upstream reported an error mid-stream');
        }
        const chunk = validate(chunkSchema, payload);
        usage = toUsage(chunk.usage) ?? usage;
        const choice = chunk.choices[0];
        const text = choice?.delta?.content;
        if (text) yield { type: 'content', text };
        if (choice?.finish_reason) finishReason = toFinishReason(choice.finish_reason);
      }
    } catch (err) {
      throw networkError(err, signal);
    } finally {
      // Releases the connection if we stop early (error, abort or consumer gone).
      response.body.destroy();
    }
    if (finishReason === undefined) {
      throw new ProviderError('connection', 'upstream stream ended before a finish_reason');
    }
    yield { type: 'finish', finishReason, usage };
  }

  async close(): Promise<void> {
    await this.#agent.close();
  }

  #post(req: ChatRequest, stream: boolean, signal: AbortSignal) {
    const body = {
      model: req.model,
      messages: req.messages,
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      top_p: req.topP,
      stop: req.stop,
      presence_penalty: req.presencePenalty,
      frequency_penalty: req.frequencyPenalty,
      seed: req.seed,
      user: req.user,
    };
    return postJson(this.#url, body, {
      agent: this.#agent,
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        accept: stream ? 'text/event-stream' : 'application/json',
      },
      signal,
      clock: this.#clock,
    });
  }
}
