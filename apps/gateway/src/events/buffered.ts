import type { Clock, UsageEvent } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';
import type { EventBus, EventBusStats } from './bus.js';

export interface BufferedBusOptions {
  logger: Logger;
  clock: Clock;
  /** Events held in memory while the transport is unreachable; beyond it, new events are dropped. */
  bufferMax: number;
  /** Events per write. */
  batchSize?: number;
}

const MAX_BACKOFF_MS = 5_000;

/**
 * The buffering every EventBus adapter shares (ADR 005). Events go into a bounded in-memory
 * buffer and a background loop hands them to the transport in batches, retrying with backoff
 * while it is down. If the buffer fills during a long outage, new events are dropped and counted:
 * the documented limit until a transactional outbox exists.
 */
export abstract class BufferedEventBus implements EventBus {
  readonly #options: BufferedBusOptions;
  readonly #buffer: string[] = [];
  #published = 0;
  #dropped = 0;
  #flushing: Promise<void> | undefined;
  #closed = false;
  readonly #stop = new AbortController();

  constructor(options: BufferedBusOptions) {
    this.#options = options;
  }

  /**
   * Stores a batch of serialized events; resolves with those not stored, in order, to be retried.
   * Implementations log their own failures and never throw.
   */
  protected abstract write(batch: string[]): Promise<string[]>;

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
      const unsent = await this.write(batch);
      // The batch leaves the front of the buffer; what was not stored goes back, in order.
      this.#buffer.splice(0, batch.length, ...unsent);
      this.#published += batch.length - unsent.length;
      if (unsent.length === 0) {
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
}
