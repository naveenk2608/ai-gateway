import { uuidv7, type Clock } from '@ai-gateway/shared';
import type { Db, Logger, SqsApi, SqsMessage } from '@ai-gateway/shared/node';
import {
  eventIdOf,
  isTransientDbError,
  IngestTrace,
  parse,
  SimulatedCrash,
  type ConsumerStats,
  type EventConsumer,
  type Parsed,
} from './consumer.js';
import { ingestEvents } from './ingest.js';
import type { WorkerMetrics } from './metrics.js';
import type { DeadLetterAlerts } from './alerts/detect.js';
import { maintainPartitions, type PartitionSettings } from './partitions.js';
import { pruneIdempotencyKeys, pruneRollups, type RollupRetention } from './retention.js';

export interface SqsConsumerOptions {
  sqs: SqsApi;
  queueUrl: string;
  dlqUrl: string;
  db: Db;
  logger: Logger;
  clock: Clock;
  /** Messages inserted per transaction; SQS hands over at most 10 per receive. */
  batchSize: number;
  /** Long-poll wait of the first receive of a batch, 0 to 20 s; a stop cancels it. */
  waitSeconds: number;
  /** How long a received message stays hidden from other consumers before it is delivered again. */
  visibilitySeconds: number;
  maxDeliveries: number;
  retention?: RollupRetention & { intervalMs: number };
  /**
   * Monthly partitions of the raw request tables (ADR 039), kept on the retention schedule:
   * months ahead created, months past RAW_RETENTION_MONTHS dropped. Omitted: left alone.
   */
  partitions?: PartitionSettings | undefined;
  metrics?: WorkerMetrics;
  /**
   * Webhook alerts (ADR 033): queue budget alerts in the ingest transaction, and a dead-letter
   * alert when events are dead-lettered. Omitted: no alerts.
   */
  alerts?: { budget: boolean; deadLetters?: DeadLetterAlerts } | undefined;
  /** Test-only fault injection, as for the Redis consumer. */
  faults?: { crash?(point: 'before-commit' | 'after-commit'): void };
}

const MAX_BACKOFF_MS = 30_000;

type Received = Parsed & { message: SqsMessage };

/**
 * Consumes usage events from an SQS queue (ADR 023), with the same guarantees as the Redis
 * consumer (ADR 014):
 *
 * - receives up to `batchSize` messages and inserts them in one Postgres transaction;
 * - deletes (acknowledges) them only after the commit, so a crash means re-delivery, which the
 *   idempotent inserts make harmless; SQS itself may also deliver a message twice;
 * - a message not deleted becomes visible again after `visibilitySeconds`, which replaces the
 *   Redis consumer's claiming of a dead consumer's entries;
 * - moves a message received more than `maxDeliveries` times to the dead-letter queue and the
 *   failed_events table; the queue's redrive policy is only a backstop (Terraform sets it higher);
 * - retries in place while Postgres is unreachable, keeping the batch hidden meanwhile, so an
 *   outage does not use up deliveries.
 */
export class SqsUsageConsumer implements EventConsumer {
  readonly #o: SqsConsumerOptions;
  readonly #stop = new AbortController();
  readonly #lastErrors = new Map<string, string>();
  readonly #queueName: string;
  #running: Promise<void> | undefined;
  #nextPruneAt = 0;
  #pruning: Promise<void> | undefined;
  readonly #stats: ConsumerStats = { processed: 0, deadLettered: 0, reclaimed: 0 };

  constructor(options: SqsConsumerOptions) {
    this.#o = options;
    this.#queueName = `sqs:${new URL(options.queueUrl).pathname.split('/').pop() ?? ''}`;
  }

  get stats(): ConsumerStats {
    return { ...this.#stats };
  }

  get done(): Promise<void> {
    return this.#running ?? Promise.resolve();
  }

  async start(): Promise<void> {
    // Fails fast on a wrong URL, region or missing permission, rather than inside the loop.
    await this.#o.sqs.depth(this.#o.queueUrl);
    this.#o.logger.info({ queue: this.#queueName }, 'usage consumer started');
    this.#running = this.#loop();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#running;
    await this.#pruning;
  }

  get #stopping(): boolean {
    return this.#stop.signal.aborted;
  }

  async #sleep(ms: number): Promise<void> {
    await this.#o.clock.sleep(ms, this.#stop.signal).catch(() => undefined);
  }

  async #loop(): Promise<void> {
    let backoffMs = 500;
    while (!this.#stopping) {
      try {
        const now = this.#o.clock.now();
        if (this.#o.retention && now >= this.#nextPruneAt && !this.#pruning) {
          this.#nextPruneAt = now + this.#o.retention.intervalMs;
          this.#pruning = this.#prune(this.#o.retention, now).finally(() => {
            this.#pruning = undefined;
          });
        }
        const messages = await this.#receive();
        if (messages.length > 0) await this.#process(messages);
        backoffMs = 500;
      } catch (err) {
        if (err instanceof SimulatedCrash) {
          this.#o.logger.warn({ err }, 'usage consumer crashed (simulated)');
          return;
        }
        if (this.#stopping) return;
        this.#o.metrics?.loopError();
        this.#o.logger.error({ err, retryInMs: backoffMs }, 'usage consumer error');
        await this.#sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** One long poll, then quick receives while full batches keep coming, up to batchSize. */
  async #receive(): Promise<SqsMessage[]> {
    const options = { visibilitySeconds: this.#o.visibilitySeconds };
    const messages: SqsMessage[] = [];
    let waitSeconds = this.#o.waitSeconds;
    while (messages.length < this.#o.batchSize && !this.#stopping) {
      const want = Math.min(10, this.#o.batchSize - messages.length);
      const got = await this.#o.sqs.receive(
        this.#o.queueUrl,
        { ...options, max: want, waitSeconds },
        this.#stop.signal,
      );
      messages.push(...got);
      if (got.length < want) break;
      waitSeconds = 0;
    }
    return messages;
  }

  async #process(messages: SqsMessage[]): Promise<void> {
    const redelivered = messages.filter((m) => m.receiveCount > 1).length;
    if (redelivered > 0) {
      this.#stats.reclaimed += redelivered;
      this.#o.metrics?.reclaimed(redelivered);
    }
    const received: Received[] = messages.map((message) => ({
      ...parse({ id: message.messageId, raw: message.body }),
      message,
    }));
    const poison = received.filter((r) => r.message.receiveCount > this.#o.maxDeliveries);
    for (const r of poison) await this.#deadLetter(r);
    const rest = received.filter((r) => r.message.receiveCount <= this.#o.maxDeliveries);
    for (const r of rest) {
      if (!r.ok) {
        // Left undeleted: it comes back after the visibility timeout, until it is dead-lettered.
        this.#lastErrors.set(r.message.messageId, r.error);
        this.#o.logger.warn(
          { messageId: r.message.messageId, error: r.error },
          'invalid usage event',
        );
      }
    }
    const valid = rest.filter((r): r is Received & { ok: true } => r.ok);
    if (valid.length === 0) return;
    try {
      await this.#insertAndDelete(valid);
    } catch (err) {
      if (err instanceof SimulatedCrash || this.#stopping) throw err;
      // As in the Redis consumer: one event the database refuses must not hold back the others.
      this.#o.logger.warn(
        { err, count: valid.length },
        'batch insert failed, inserting one by one',
      );
      for (const r of valid) {
        try {
          await this.#insertAndDelete([r]);
        } catch (single) {
          if (single instanceof SimulatedCrash || this.#stopping) throw single;
          const message = single instanceof Error ? single.message : String(single);
          this.#lastErrors.set(r.message.messageId, `database rejected the event: ${message}`);
          this.#o.logger.warn(
            { err: single, messageId: r.message.messageId },
            'usage event insert failed',
          );
        }
      }
    }
  }

  async #insertAndDelete(batch: (Received & { ok: true })[]): Promise<void> {
    const metrics = this.#o.metrics;
    const handles = batch.map((r) => r.message.receiptHandle);
    const traced = new IngestTrace(batch.map((r) => r.event));
    await this.#retryWhileDbDown(handles, async () => {
      const started = performance.now();
      await this.#o.db.transaction().execute(async (trx) => {
        await ingestEvents(
          trx,
          batch.map((r) => r.event),
          metrics && ((seconds) => metrics.rollup(seconds)),
          { budgetAlerts: this.#o.alerts?.budget === true },
        );
        this.#o.faults?.crash?.('before-commit');
      });
      metrics?.batch((performance.now() - started) / 1000);
    }).catch((err: unknown) => {
      traced.failed();
      throw err;
    });
    this.#o.faults?.crash?.('after-commit');
    const notDeleted = await this.#o.sqs.deleteBatch(this.#o.queueUrl, handles);
    if (notDeleted.length > 0) {
      // They come back after the visibility timeout and are inserted again as no-ops.
      this.#o.logger.warn({ count: notDeleted.length }, 'stored usage events not deleted from SQS');
    }
    for (const r of batch) this.#lastErrors.delete(r.message.messageId);
    this.#stats.processed += batch.length;
    metrics?.consumed(batch.length);
    traced.stored(this.#o.logger);
  }

  /**
   * Retries `work` while Postgres is unreachable, extending the messages' visibility before each
   * wait so they are not delivered again meanwhile. Other errors are thrown at once.
   */
  async #retryWhileDbDown<T>(handles: string[], work: () => Promise<T>): Promise<T> {
    let backoffMs = 500;
    for (;;) {
      try {
        return await work();
      } catch (err) {
        if (!isTransientDbError(err) || this.#stopping) throw err;
        this.#o.logger.warn({ err, retryInMs: backoffMs }, 'postgres unavailable, retrying batch');
        // Hidden through the wait and the next attempt.
        const seconds = this.#o.visibilitySeconds + Math.ceil(backoffMs / 1000);
        await this.#o.sqs
          .extendVisibility(this.#o.queueUrl, handles, seconds)
          .catch((extendErr: unknown) =>
            this.#o.logger.warn({ err: extendErr }, 'could not extend message visibility'),
          );
        await this.#sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** Records the message in failed_events and the dead-letter queue, then deletes it. */
  async #deadLetter(r: Received): Promise<void> {
    const { message } = r;
    const error =
      this.#lastErrors.get(message.messageId) ??
      (r.ok ? 'not processed after repeated deliveries' : r.error);
    await this.#retryWhileDbDown([message.receiptHandle], () =>
      this.#o.db
        .insertInto('failed_events')
        .values({
          id: uuidv7(),
          stream: this.#queueName,
          stream_message_id: message.messageId,
          event_id: eventIdOf(message.body),
          payload: message.body,
          error,
          delivery_count: message.receiveCount,
        })
        .onConflict((oc) => oc.columns(['stream', 'stream_message_id']).doNothing())
        .execute(),
    );
    await this.#o.sqs.send(this.#o.dlqUrl, message.body, {
      source_message_id: message.messageId,
      error: error.slice(0, 1_000),
      deliveries: String(message.receiveCount),
    });
    await this.#o.sqs.deleteBatch(this.#o.queueUrl, [message.receiptHandle]);
    this.#lastErrors.delete(message.messageId);
    this.#stats.deadLettered++;
    this.#o.metrics?.deadLettered();
    void this.#o.alerts?.deadLetters?.deadLettered();
    this.#o.logger.error(
      { messageId: message.messageId, deliveries: message.receiveCount, error },
      'usage event moved to the dead-letter queue',
    );
  }

  async #prune(retention: RollupRetention, now: number): Promise<void> {
    try {
      const started = performance.now();
      const deleted = await pruneRollups(this.#o.db, now, retention);
      this.#o.metrics?.pruned((performance.now() - started) / 1000, deleted);
      if (deleted.minute + deleted.hour + deleted.day > 0) {
        this.#o.logger.info({ deleted }, 'expired rollup rows deleted');
      }
    } catch (err) {
      this.#o.logger.warn({ err }, 'rollup retention failed');
    }
    try {
      const keys = await pruneIdempotencyKeys(this.#o.db, now);
      if (keys > 0) this.#o.logger.info({ deleted: keys }, 'expired idempotency keys deleted');
    } catch (err) {
      this.#o.logger.warn({ err }, 'idempotency key retention failed');
    }
    if (this.#o.partitions) {
      try {
        const done = await maintainPartitions(this.#o.db, now, this.#o.partitions);
        if (done.created + done.dropped + done.defaultDeleted > 0) {
          this.#o.logger.info(done, 'raw table partitions maintained');
        }
      } catch (err) {
        this.#o.logger.warn({ err }, 'raw table partition maintenance failed');
      }
    }
  }
}
