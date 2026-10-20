import { createHash } from 'node:crypto';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import { z } from 'zod';
import { messageText, type ChatResult } from '../providers/types.js';
import type { ChatCompletionRequest } from '../proxy/schema.js';

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
 * The cache key: SHA-256 over the project, the logical model and every field that can change the
 * answer, in a fixed order. The project comes first, so two projects never share an entry. Fields
 * that do not change the answer (`stream`, `stream_options`, `user`) are left out, so a streamed
 * and a non-streamed request share one.
 */
export function cacheKey(projectId: string, body: ChatCompletionRequest): string {
  const stop = body.stop ?? null;
  const canonical = JSON.stringify([
    'v1',
    projectId,
    body.model,
    body.messages.map((m) => [m.role, m.name ?? null, messageText(m.content)]),
    body.max_completion_tokens ?? body.max_tokens ?? null,
    body.temperature ?? null,
    body.top_p ?? null,
    typeof stop === 'string' ? [stop] : stop,
    body.presence_penalty ?? null,
    body.frequency_penalty ?? null,
    body.seed ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

const entrySchema = z.object({
  content: z.string(),
  finishReason: z.enum(['stop', 'length', 'content_filter']),
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
}

/**
 * Exact-match responses in Redis (ADR 013). The cache is an optimisation: a Redis error is a miss,
 * never a failed request.
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

  /** Stores a completed response; failures are logged and ignored. */
  set(key: string, result: ChatResult): void {
    const value = JSON.stringify({
      content: result.content,
      finishReason: result.finishReason,
      usage: result.usage,
    });
    if (Buffer.byteLength(value) > this.#o.maxEntryBytes) return;
    this.#o.redis
      .set(this.#prefix + key, value, 'EX', this.#o.ttlSeconds)
      .catch((err: unknown) => this.#o.logger.warn({ err }, 'response cache write failed'));
  }
}
