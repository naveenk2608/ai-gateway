import { USAGE_STREAM, type Clock, type UsageEvent } from '@ai-gateway/shared';
import type { Logger, Redis } from '@ai-gateway/shared/node';
import type { EventBus, EventBusStats } from './bus.js';

export interface RedisStreamBusOptions {
  redis: Redis;
  logger: Logger;
  clock: Clock;
  stream?: string;
  /** Events held in memory while Redis is unreachable; beyond it, new events are dropped. */
  bufferMax: number;
  /** Approximate cap on the stream length (XADD MAXLEN ~), so Redis memory stays bounded. */
  streamMaxLen: number;
  /** Events per XADD pipeline. */
  batchSize?: number;
}

const MAX_BACKOFF_MS = 5_000;

/**
 * EventBus over a Redis Stream. Events go into a bounded in-memory buffer and a background loop
 * writes them with pipelined XADDs, retrying with backoff while Redis is down. If the buffer fills
 * during a long outage, new events are dropped and counted: the documented limit until a
 * transactional outbox exists.
 */
export class RedisStreamBus implements EventBus {
  readonly #options: RedisStreamBusOptions;
  readonly #stream: string;
  readonly #buffer: string[] = [];
  #published = 0;
  #dropped = 0;
  #flushing: Promise<void> | undefined;
  #closed = false;
  readonly #stop = new AbortController();

  constructor(options: RedisStreamBusOptions) {
    this.#options = options;
    this.#stream = options.stream ?? USAGE_STREAM;
  }

  publish(event: UsageEvent): void {
    if (this.#buffer.length >= this.#options.bufferMax) {
      this.#dropped++;
      // Log the first drop and then every 1000th, not every event.
      if (this.#dropped % 1_000 === 1) {
        this.#options.logger.error(
          { dropped: this.#dropped, bufferMax: this.#options.bufferMax },
          'usage event buffer full, dropping events',
        );
      }
      return;
    }
    this.#buffer.push(JSON.stringify(event));
    if (!this.#closed)
      this.#flushing ??= this.#flushLoop().finally(() => (this.#flushing = undefined));
  }

  stats(): EventBusStats {
    return { buffered: this.#buffer.length, published: this.#published, dropped: this.#dropped };
  }

  async close(timeoutMs: number): Promise<void> {
    this.#closed = true;
    this.#flushing ??= this.#flushLoop().finally(() => (this.#flushing = undefined));
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.#flushing, timedOut]);
    clearTimeout(timer);
    this.#stop.abort();
    if (this.#buffer.length > 0) {
      this.#options.logger.error(
        { lost: this.#buffer.length },
        'usage events still buffered at shutdown were lost',
      );
    }
  }

  async #flushLoop(): Promise<void> {
    let backoffMs = 100;
    while (this.#buffer.length > 0 && !this.#stop.signal.aborted) {
      const batch = this.#buffer.slice(0, this.#options.batchSize ?? 100);
      const written = await this.#write(batch);
      // Written events leave the front of the buffer; the rest are retried in order.
      this.#buffer.splice(0, written);
      this.#published += written;
      if (written === batch.length) {
        backoffMs = 100;
        continue;
      }
      try {
        await this.#options.clock.sleep(backoffMs, this.#stop.signal);
      } catch {
        return;
      }
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  /** Writes a batch; returns how many leading events were stored. */
  async #write(batch: string[]): Promise<number> {
    const pipeline = this.#options.redis.pipeline();
    for (const event of batch) {
      pipeline.xadd(this.#stream, 'MAXLEN', '~', this.#options.streamMaxLen, '*', 'event', event);
    }
    try {
      const results = (await pipeline.exec()) ?? [];
      const firstFailure = results.findIndex(([err]) => err !== null);
      if (firstFailure === -1) return batch.length;
      this.#options.logger.warn({ err: results[firstFailure]?.[0] }, 'usage event write failed');
      return firstFailure;
    } catch (err) {
      this.#options.logger.warn({ err, buffered: this.#buffer.length }, 'usage event write failed');
      return 0;
    }
  }
}
