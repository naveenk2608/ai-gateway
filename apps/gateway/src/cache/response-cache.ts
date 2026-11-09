import { createHash } from 'node:crypto';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import { z } from 'zod';
import type { ChatResult } from '../providers/types.js';
import type { ChatCompletionMessage, ChatCompletionRequest } from '../proxy/schema.js';
import type { MemoryGuard, SkipReason } from './memory-guard.js';

/** `x-gateway-cache: on` opts a request in; `off` keeps it out even at temperature 0. */
export const CACHE_HEADER = 'x-gateway-cache';

/**
 * Whether a request may be answered from, and stored in, the cache (ADR 013). Only requests that
 * should give the same answer each time: temperature 0, or the caller says so explicitly.
 */
export function cacheable(body: ChatCompletionRequest, header: string | undefined): boolean {
  const choice = header?.trim().toLowerCase();
  if (choice === 'off') return false;
  if (choice === 'on') return true;
  return body.temperature === 0;
}

/**
 * A message's content for the key: its text, with text parts joined as before tools existed
 * (so `"hi"` and `[{type: "text", text: "hi"}]` match), or every part in order when it has images.
 */
function keyContent(content: ChatCompletionMessage['content']): unknown {
  if (content === null || content === undefined || typeof content === 'string') {
    return content ?? null;
  }
  if (!content.some((part) => part.type === 'image_url')) {
    return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  }
  return content.map((part) =>
    part.type === 'text'
      ? ['text', part.text]
      : ['image', part.image_url.url, part.image_url.detail ?? 'auto'],
  );
}

function keyMessage(m: ChatCompletionMessage): unknown[] {
  return [
    m.role,
    'name' in m ? (m.name ?? null) : null,
    keyContent(m.content),
    m.role === 'assistant'
      ? (m.tool_calls ?? []).map((c) => [c.id, c.function.name, c.function.arguments])
      : null,
    m.role === 'tool' ? m.tool_call_id : null,
  ];
}

/**
 * The cache key: SHA-256 over the project, the logical model and every field that can change the
 * answer, in a fixed order. The project comes first, so two projects never share an entry. Fields
 * that do not change the answer (`stream`, `stream_options`, `user`) are left out, so a streamed
 * and a non-streamed request share one. Version 2 (M13) adds tools, tool choice, parallel tool
 * calls, the response format, image parts, tool calls and tool results.
 */
export function cacheKey(projectId: string, body: ChatCompletionRequest): string {
  const stop = body.stop ?? null;
  const choice = body.tool_choice ?? null;
  const format = body.response_format ?? null;
  const canonical = JSON.stringify([
    'v2',
    projectId,
    body.model,
    body.messages.map(keyMessage),
    body.max_completion_tokens ?? body.max_tokens ?? null,
    body.temperature ?? null,
    body.top_p ?? null,
    typeof stop === 'string' ? [stop] : stop,
    body.presence_penalty ?? null,
    body.frequency_penalty ?? null,
    body.seed ?? null,
    (body.tools ?? []).map((t) => [
      t.function.name,
      t.function.description ?? null,
      t.function.parameters ?? null,
      t.function.strict ?? null,
    ]),
    typeof choice === 'object' && choice !== null ? ['function', choice.function.name] : choice,
    body.parallel_tool_calls ?? null,
    // `text` is the default: the same answer as no response format.
    format?.type === 'text' ? null : format,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const entrySchema = z.object({
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
});

/**
 * The key of an embeddings answer (ADR 029): the project, the logical model, the inputs in
 * order, the requested dimensions and the encoding. Embeddings of one input never vary, so there
 * is no temperature to check.
 */
export function embeddingsCacheKey(
  projectId: string,
  model: string,
  input: readonly string[],
  dimensions: number | null,
  encoding: 'float' | 'base64',
): string {
  const canonical = JSON.stringify(['emb-v1', projectId, model, input, dimensions, encoding]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** A cached embeddings answer: the data as sent to the client, and the provider's usage. */
export interface CachedEmbeddings {
  data: (number[] | string)[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

const embeddingsEntrySchema = z.object({
  data: z.array(z.union([z.array(z.number()), z.string()])).min(1),
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
      totalTokens: z.number().int().min(0),
    })
    .nullable(),
});

export interface ResponseCacheOptions {
  redis: Redis;
  logger: Logger;
  ttlSeconds: number;
  /** Larger responses are not stored. */
  maxEntryBytes: number;
  prefix?: string;
  /** Stores only while Redis has room (M15); without it, every store goes ahead. */
  guard?: MemoryGuard | undefined;
  /** A store that was skipped, and why (the metric). */
  onSkip?: ((reason: SkipReason | 'too_large') => void) | undefined;
}

/**
 * Exact-match responses in Redis (ADR 013). The cache is an optimisation: a Redis error is a miss,
 * never a failed request, and a store that is skipped (too large, or Redis near its memory cap) or
 * fails never fails one either. Lookups do not depend on the memory guard.
 */
export class ResponseCache {
  readonly #o: ResponseCacheOptions;
  readonly #prefix: string;

  constructor(options: ResponseCacheOptions) {
    this.#o = options;
    this.#prefix = options.prefix ?? 'gw:cache:';
  }

  async get(key: string): Promise<ChatResult | null> {
    try {
      const raw = await this.#o.redis.get(this.#prefix + key);
      if (raw === null) return null;
      const parsed = entrySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.#o.logger.warn({ err }, 'response cache read failed; treating as a miss');
      return null;
    }
  }

  async getEmbeddings(key: string): Promise<CachedEmbeddings | null> {
    return this.#read(key, embeddingsEntrySchema);
  }

  /** Stores an embeddings answer; failures are logged and ignored. */
  setEmbeddings(key: string, entry: CachedEmbeddings): void {
    this.#write(key, JSON.stringify(entry));
  }

  async #read<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    try {
      const raw = await this.#o.redis.get(this.#prefix + key);
      if (raw === null) return null;
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.#o.logger.warn({ err }, 'response cache read failed; treating as a miss');
      return null;
    }
  }

  /** Stores `value` unless it is too large or Redis is near its memory cap; never throws. */
  #write(key: string, value: string): void {
    if (Buffer.byteLength(value) > this.#o.maxEntryBytes) {
      this.#o.onSkip?.('too_large');
      return;
    }
    void this.#store(key, value);
  }

  /** The store itself; resolves once it is done or skipped (tests await it through `set`). */
  async #store(key: string, value: string): Promise<void> {
    try {
      const verdict = (await this.#o.guard?.check()) ?? { ok: true };
      if (!verdict.ok) {
        this.#o.onSkip?.(verdict.reason);
        return;
      }
      await this.#o.redis.set(this.#prefix + key, value, 'EX', this.#o.ttlSeconds);
    } catch (err) {
      this.#o.logger.warn({ err }, 'response cache write failed');
    }
  }

  /** Stores a completed response; failures are logged and ignored. */
  set(key: string, result: ChatResult): void {
    this.#write(
      key,
      JSON.stringify({
        content: result.content,
        ...(result.toolCalls && result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        finishReason: result.finishReason,
        usage: result.usage,
      }),
    );
  }
}
