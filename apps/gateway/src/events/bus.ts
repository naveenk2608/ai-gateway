import type { UsageEvent } from '@ai-gateway/shared';

export interface EventBusStats {
  /** Events waiting in memory to be written. */
  buffered: number;
  published: number;
  /** Events lost because the buffer was full (the event bus was unreachable for too long). */
  dropped: number;
}

/**
 * The event seam (ADR 005): Redis Streams now, SQS in M10. `publish` never blocks and never
 * throws, so emitting usage cannot slow or fail a client request.
 */
export interface EventBus {
  publish(event: UsageEvent): void;
  stats(): EventBusStats;
  /** Flushes what it can within `timeoutMs`, then stops. */
  close(timeoutMs: number): Promise<void>;
}
