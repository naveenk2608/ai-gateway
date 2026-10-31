import { USAGE_STREAM } from '@ai-gateway/shared';
import type { Redis } from '@ai-gateway/shared/node';
import { BufferedEventBus, type BufferedBusOptions } from './buffered.js';

export interface RedisStreamBusOptions extends BufferedBusOptions {
  redis: Redis;
  stream?: string;
  /** Approximate cap on the stream length (XADD MAXLEN ~), so Redis memory stays bounded. */
  streamMaxLen: number;
}

/**
 * EventBus over a Redis Stream (ADR 005): buffered batches written with pipelined XADDs,
 * retried with backoff while Redis is down.
 */
export class RedisStreamBus extends BufferedEventBus {
  readonly #options: RedisStreamBusOptions;
  readonly #stream: string;

  constructor(options: RedisStreamBusOptions) {
    super(options);
    this.#options = options;
    this.#stream = options.stream ?? USAGE_STREAM;
  }

  protected async write(batch: string[]): Promise<string[]> {
    const pipeline = this.#options.redis.pipeline();
    for (const event of batch) {
      pipeline.xadd(this.#stream, 'MAXLEN', '~', this.#options.streamMaxLen, '*', 'event', event);
    }
    try {
      const results = (await pipeline.exec()) ?? [];
      const firstFailure = results.findIndex(([err]) => err !== null);
      if (firstFailure === -1) return [];
      this.#options.logger.warn({ err: results[firstFailure]?.[0] }, 'usage event write failed');
      // Everything from the first failure on is written again; duplicates are harmless (ADR 014).
      return batch.slice(firstFailure);
    } catch (err) {
      this.#options.logger.warn({ err, batch: batch.length }, 'usage event write failed');
      return batch;
    }
  }
}
