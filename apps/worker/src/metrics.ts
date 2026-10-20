import type { Registry } from '@ai-gateway/shared/node';
import { Counter, Gauge, Histogram } from 'prom-client';
import type { PipelineState } from './pipeline.js';

/**
 * The usage consumer's Prometheus metrics (ADR 017). They go on the worker's registry, or on the
 * gateway's when the consumer runs in the gateway process. No label carries an event or request ID.
 * Stream state that any process can read is in `watchPipeline` below.
 */

/** Seconds: a small batch insert up to a slow rollup or prune. */
const DB_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type RollupTable = 'minute' | 'hour' | 'day';

export class WorkerMetrics {
  readonly registry: Registry;
  readonly #consumed: Counter;
  readonly #deadLettered: Counter;
  readonly #reclaimed: Counter;
  readonly #errors: Counter;
  readonly #batch: Histogram;
  readonly #rollup: Histogram;
  readonly #prune: Histogram;
  readonly #pruned: Counter<'table'>;

  constructor(registry: Registry) {
    this.registry = registry;
    const registers = [registry];
    this.#consumed = new Counter({
      name: 'worker_events_consumed_total',
      help: 'Usage events stored in Postgres and acknowledged (re-deliveries of stored events included).',
      registers,
    });
    this.#deadLettered = new Counter({
      name: 'worker_events_dead_lettered_total',
      help: 'Usage events moved to the dead-letter stream after too many deliveries.',
      registers,
    });
    this.#reclaimed = new Counter({
      name: 'worker_events_reclaimed_total',
      help: 'Pending usage events claimed from a consumer that left them idle too long.',
      registers,
    });
    this.#errors = new Counter({
      name: 'worker_consumer_errors_total',
      help: 'Consumer loop failures (Redis or Postgres errors); the loop backs off and retries.',
      registers,
    });
    this.#batch = new Histogram({
      name: 'worker_batch_duration_seconds',
      help: 'One batch insert transaction, rollups included.',
      buckets: DB_BUCKETS,
      registers,
    });
    this.#rollup = new Histogram({
      name: 'worker_rollup_duration_seconds',
      help: 'The rollup statement inside a batch transaction (ADR 015).',
      buckets: DB_BUCKETS,
      registers,
    });
    this.#prune = new Histogram({
      name: 'worker_prune_duration_seconds',
      help: 'One rollup retention pass over the minute, hour and day tables.',
      buckets: DB_BUCKETS,
      registers,
    });
    this.#pruned = new Counter({
      name: 'worker_rollup_rows_pruned_total',
      help: 'Expired rollup rows deleted, by table.',
      labelNames: ['table'],
      registers,
    });
  }

  consumed(count: number): void {
    this.#consumed.inc(count);
  }

  deadLettered(): void {
    this.#deadLettered.inc();
  }

  reclaimed(count: number): void {
    this.#reclaimed.inc(count);
  }

  loopError(): void {
    this.#errors.inc();
  }

  batch(seconds: number): void {
    this.#batch.observe(seconds);
  }

  rollup(seconds: number): void {
    this.#rollup.observe(seconds);
  }

  pruned(seconds: number, deleted: Record<RollupTable, number>): void {
    this.#prune.observe(seconds);
    for (const [table, rows] of Object.entries(deleted)) this.#pruned.inc({ table }, rows);
  }
}

/**
 * The usage pipeline's state in Redis, read at scrape time: stream lag, pending entries and the
 * dead-letter stream. Both the worker and the gateway register these, so the lag stays visible
 * while the worker is down; dashboards take the max across them. When Redis does not answer,
 * `usage_stream_up` is 0 and the others are NaN (unknown), never a stale or made-up value.
 */
export function watchPipeline(registry: Registry, read: () => Promise<PipelineState>): void {
  const registers = [registry];
  // Every gauge below is collected in the same scrape; one read serves them all.
  let reading: Promise<PipelineState | null> | undefined;
  const state = () =>
    (reading ??= read()
      .catch(() => null)
      .finally(() => {
        reading = undefined;
      }));
  const gauge = (name: string, help: string, pick: (s: PipelineState) => number | null) =>
    new Gauge({
      name,
      help,
      registers,
      async collect() {
        const current = await state();
        this.set((current === null ? null : pick(current)) ?? Number.NaN);
      },
    });
  new Gauge({
    name: 'usage_stream_up',
    help: 'Whether the usage stream state could be read from Redis during this scrape.',
    registers,
    async collect() {
      this.set((await state()) === null ? 0 : 1);
    },
  });
  gauge('usage_stream_lag', 'Usage events no consumer has read yet.', (s) => s.unreadEvents);
  gauge(
    'usage_stream_pending',
    'Usage events read but not yet acknowledged.',
    (s) => s.pendingEvents,
  );
  gauge(
    'usage_stream_oldest_pending_age_seconds',
    'Age of the oldest unacknowledged usage event; 0 when none is pending.',
    (s) => (s.oldestPendingAgeMs ?? 0) / 1000,
  );
  gauge('usage_stream_length', 'Entries in the usage stream.', (s) => s.streamLength);
  gauge('usage_dlq_length', 'Entries in the dead-letter stream.', (s) => s.deadLetterLength);
  gauge('usage_stream_consumers', 'Consumers in the usage consumer group.', (s) => s.consumers);
}
