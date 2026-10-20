import {
  commonConfigShape,
  USAGE_CONSUMER_GROUP,
  USAGE_DLQ_STREAM,
  USAGE_STREAM,
} from '@ai-gateway/shared';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();

/**
 * Usage-consumer settings. Shared with the gateway, which can run the consumer in-process
 * (RUN_WORKER_IN_PROCESS) on hosts without background workers.
 */
export const consumerSettingsShape = {
  /** Stream the gateway writes usage events to. */
  EVENTS_STREAM: z.string().min(1).default(USAGE_STREAM),
  /** Where events go after WORKER_MAX_DELIVERIES failed deliveries (also stored in failed_events). */
  EVENTS_DLQ_STREAM: z.string().min(1).default(USAGE_DLQ_STREAM),
  EVENTS_CONSUMER_GROUP: z.string().min(1).default(USAGE_CONSUMER_GROUP),
  /** Events read and inserted per transaction. */
  WORKER_BATCH_SIZE: positiveInt.max(1_000).default(100),
  /** How long one read waits for new events; also how quickly a stop is noticed. */
  WORKER_BLOCK_MS: positiveInt.max(60_000).default(2_000),
  /** An event unacknowledged this long (its consumer died or failed) is claimed again. */
  WORKER_CLAIM_IDLE_MS: positiveInt.default(60_000),
  /** Deliveries before an event is moved to the dead-letter stream. */
  WORKER_MAX_DELIVERIES: positiveInt.max(100).default(5),
  /** How often fully processed events are trimmed from the stream. */
  WORKER_TRIM_INTERVAL_MS: positiveInt.default(60_000),
  /**
   * Rollup retention (ADR 015). The analytics ranges need minute rows for 24 h, hourly rows for
   * 7 days and daily rows for 30 days, so shorter values are refused.
   */
  ROLLUP_RETENTION_MINUTE_HOURS: positiveInt.min(25).default(48),
  ROLLUP_RETENTION_HOUR_DAYS: positiveInt.min(8).default(35),
  ROLLUP_RETENTION_DAY_DAYS: positiveInt.min(31).default(400),
  /** How often expired rollup rows are deleted. */
  ROLLUP_RETENTION_INTERVAL_MS: positiveInt.default(3_600_000),
};

export const consumerSettingsSchema = z.object(consumerSettingsShape);
export type ConsumerSettings = z.output<typeof consumerSettingsSchema>;

export const workerConfigSchema = z.object({
  ...commonConfigShape,
  ...consumerSettingsShape,
  /** Apply pending migrations at startup, under the same advisory lock as the gateway. */
  MIGRATE_ON_START: z.stringbool().default(true),
  MIGRATIONS_DIR: z.string().min(1).optional(),
});

export type WorkerConfig = z.output<typeof workerConfigSchema>;
