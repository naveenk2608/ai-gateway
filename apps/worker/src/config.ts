import {
  checkEventBusConfig,
  commonConfigShape,
  eventBusConfigShape,
  metricsConfigShape,
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
  /** Redis Stream (default) or SQS (ADR 023); the SQS_* settings apply to the latter. */
  ...eventBusConfigShape,
  /** Stream the gateway writes usage events to. */
  EVENTS_STREAM: z.string().min(1).default(USAGE_STREAM),
  /** Where events go after WORKER_MAX_DELIVERIES failed deliveries (also stored in failed_events). */
  EVENTS_DLQ_STREAM: z.string().min(1).default(USAGE_DLQ_STREAM),
  EVENTS_CONSUMER_GROUP: z.string().min(1).default(USAGE_CONSUMER_GROUP),
  /** Events read and inserted per transaction (SQS hands them over 10 at a time). */
  WORKER_BATCH_SIZE: positiveInt.max(1_000).default(100),
  /**
   * How long one read waits for new events; also how quickly a stop is noticed. SQS long polls
   * for whole seconds (at most 20) and a stop cancels the wait.
   */
  WORKER_BLOCK_MS: positiveInt.max(60_000).default(2_000),
  /**
   * An event unacknowledged this long (its consumer died or failed) is delivered again: claimed
   * from the stream, or visible again on the SQS queue (its visibility timeout, in whole seconds).
   */
  WORKER_CLAIM_IDLE_MS: positiveInt.max(43_200_000).default(60_000),
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
  /**
   * Webhook alerts (M15, ADR 033): budget thresholds, breakers opening, dead letters growing. On
   * by default; nothing is sent until a project adds a destination. ALERTS_ENCRYPTION_KEY (32
   * bytes, base64) encrypts destination URLs; unset, a key is derived from API_KEY_PEPPER.
   * Deliveries are retried on the Standard Webhooks schedule (5 s to 24 h) up to
   * ALERTS_MAX_ATTEMPTS (10: the schedule's length); a breaker alerts at most once per deployment
   * per ALERTS_BREAKER_INTERVAL_MS, dead letters at most once per
   * ALERTS_DEAD_LETTER_INTERVAL_MS.
   */
  ALERTS_ENABLED: z.stringbool().default(true),
  ALERTS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, '32 bytes, base64')
    .optional(),
  ALERTS_POLL_INTERVAL_MS: positiveInt.min(100).max(600_000).default(5_000),
  ALERTS_MAX_ATTEMPTS: positiveInt.max(10).default(10),
  ALERTS_SEND_TIMEOUT_MS: positiveInt.min(100).max(30_000).default(5_000),
  ALERTS_BREAKER_INTERVAL_MS: positiveInt.min(1_000).default(900_000),
  ALERTS_DEAD_LETTER_INTERVAL_MS: positiveInt.min(1_000).default(3_600_000),
  ALERTS_DELIVERY_RETENTION_DAYS: positiveInt.max(3_650).default(30),
  /**
   * Monthly partitions of request_records, provider_attempts and usage_events (M17, ADR 039),
   * kept on the rollup retention schedule (ROLLUP_RETENTION_INTERVAL_MS): the current month and
   * RAW_PARTITIONS_AHEAD_MONTHS more always exist, and months older than RAW_RETENTION_MONTHS
   * before the current one are dropped (0 keeps every month). Neon's free plan holds 1 GB per
   * project; rollups keep the analytics for longer (ADR 015).
   */
  RAW_PARTITIONS_ENABLED: z.stringbool().default(true),
  RAW_PARTITIONS_AHEAD_MONTHS: z.coerce.number().int().min(1).max(24).default(3),
  RAW_RETENTION_MONTHS: z.coerce.number().int().min(0).max(120).default(6),
};

export const consumerSettingsSchema = z.object(consumerSettingsShape);
export type ConsumerSettings = z.output<typeof consumerSettingsSchema>;

export const workerConfigSchema = z
  .object({
    ...commonConfigShape,
    /** Not needed when SQS carries the events (EVENT_BUS=sqs). */
    REDIS_URL: commonConfigShape.REDIS_URL.optional(),
    ...consumerSettingsShape,
    /** Apply pending migrations at startup, under the same advisory lock as the gateway. */
    MIGRATE_ON_START: z.stringbool().default(true),
    MIGRATIONS_DIR: z.string().min(1).optional(),
    /**
     * Prometheus metrics (ADR 017) on WORKER_METRICS_PORT, bound to METRICS_HOST (loopback by
     * default); scrapes need METRICS_TOKEN as a bearer token when it is set.
     */
    ...metricsConfigShape,
    WORKER_METRICS_PORT: z.coerce.number().int().min(0).max(65_535).default(9465),
    /**
     * Only to derive the alert encryption key when ALERTS_ENCRYPTION_KEY is unset: the same value
     * as the gateway's. Without either, alerts are queued but not sent.
     */
    API_KEY_PEPPER: z.string().min(32).optional(),
  })
  .superRefine((config, ctx) => {
    checkEventBusConfig(config, ctx);
    if (config.EVENT_BUS === 'redis' && config.REDIS_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'is required' });
    }
  });

export type WorkerConfig = z.output<typeof workerConfigSchema>;
