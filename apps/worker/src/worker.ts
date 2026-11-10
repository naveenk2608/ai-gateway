import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemClock, uuidv7, type Clock } from '@ai-gateway/shared';
import {
  closeRedis,
  createDb,
  createMetricsRegistry,
  createPgPool,
  createRedis,
  alertsKey,
  createSqsClient,
  migrateDatabase,
  sqsApi,
  startMetricsServer,
  type Db,
  type Logger,
  type MetricsServer,
  type Registry,
  type SqsApi,
} from '@ai-gateway/shared/node';
import type { ConsumerSettings, WorkerConfig } from './config.js';
import { UsageConsumer, type ConsumerOptions, type EventConsumer } from './consumer.js';
import { watchPipeline, WorkerMetrics } from './metrics.js';
import { readPipelineState, readSqsPipelineState, type PipelineReader } from './pipeline.js';
import { SqsUsageConsumer } from './sqs-consumer.js';
import { DeadLetterAlerts } from './alerts/detect.js';
import { AlertDispatcher } from './alerts/dispatcher.js';

/** src/ and dist/ both sit three levels below the repository root, where db/migrations lives. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
);

export type StopOutcome = 'stopped' | 'timeout';

export interface Worker {
  consumer: EventConsumer;
  /** The metrics listener's port once started. */
  metricsPort(): number | undefined;
  /** Applies migrations (if enabled), then starts consuming. */
  start(): Promise<void>;
  /** Stops consuming, then closes the Postgres pool and Redis client, within SHUTDOWN_TIMEOUT_MS. */
  stop(): Promise<StopOutcome>;
}

export interface UsageConsumerDeps {
  settings: ConsumerSettings;
  /** Needed when Redis carries the events (EVENT_BUS=redis). */
  redisUrl?: string;
  /** The SQS calls (EVENT_BUS=sqs); made from the settings when omitted. */
  sqs?: SqsApi;
  db: Db;
  logger: Logger;
  clock?: Clock;
  faults?: ConsumerOptions['faults'];
  /** Where the consumer's metrics go (ADR 017). */
  metricsRegistry?: Registry;
  /** The key for alert destinations (ADR 033); null or omitted: alerts are queued, not sent. */
  alertsKey?: Buffer | null;
  /** A number in [0, 1), for the alert retry jitter. */
  random?: () => number;
}

/** The SQS calls for EVENT_BUS=sqs, with a function that releases the client's sockets. */
export function sqsFromSettings(settings: ConsumerSettings): {
  sqs: SqsApi;
  close: () => void;
} {
  if (settings.AWS_REGION === undefined) throw new Error('AWS_REGION is required for SQS');
  const client = createSqsClient({ region: settings.AWS_REGION, endpoint: settings.SQS_ENDPOINT });
  return { sqs: sqsApi(client), close: () => client.destroy() };
}

/** The queues of EVENT_BUS=sqs; the config schema has already required them. */
export function sqsQueues(settings: ConsumerSettings): { queueUrl: string; dlqUrl: string } {
  if (settings.SQS_QUEUE_URL === undefined || settings.SQS_DLQ_URL === undefined) {
    throw new Error('SQS_QUEUE_URL and SQS_DLQ_URL are required for SQS');
  }
  return { queueUrl: settings.SQS_QUEUE_URL, dlqUrl: settings.SQS_DLQ_URL };
}

/**
 * The usage consumer for the configured bus: on SQS, or on its own Redis connection, named
 * uniquely for this process.
 */
export function createUsageConsumer(deps: UsageConsumerDeps): {
  consumer: EventConsumer;
  /** Sends queued webhook alerts (ADR 033); start it after the consumer. */
  alerts: AlertDispatcher;
  close: () => Promise<void>;
} {
  const { settings, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const alerts = new AlertDispatcher(
    {
      enabled: settings.ALERTS_ENABLED,
      pollIntervalMs: settings.ALERTS_POLL_INTERVAL_MS,
      maxAttempts: settings.ALERTS_MAX_ATTEMPTS,
      sendTimeoutMs: settings.ALERTS_SEND_TIMEOUT_MS,
      retentionDays: settings.ALERTS_DELIVERY_RETENTION_DAYS,
    },
    {
      db: deps.db,
      clock,
      logger: logger.child({ component: 'alerts' }),
      random: deps.random ?? Math.random,
      key: deps.alertsKey ?? null,
    },
  );
  const alerting = settings.ALERTS_ENABLED
    ? {
        budget: true,
        deadLetters: new DeadLetterAlerts({
          db: deps.db,
          clock,
          logger,
          intervalMs: settings.ALERTS_DEAD_LETTER_INTERVAL_MS,
        }),
      }
    : undefined;
  const metrics = deps.metricsRegistry ? new WorkerMetrics(deps.metricsRegistry) : undefined;
  const retention = {
    minuteHours: settings.ROLLUP_RETENTION_MINUTE_HOURS,
    hourDays: settings.ROLLUP_RETENTION_HOUR_DAYS,
    dayDays: settings.ROLLUP_RETENTION_DAY_DAYS,
    intervalMs: settings.ROLLUP_RETENTION_INTERVAL_MS,
  };
  const partitions = {
    enabled: settings.RAW_PARTITIONS_ENABLED,
    aheadMonths: settings.RAW_PARTITIONS_AHEAD_MONTHS,
    retentionMonths: settings.RAW_RETENTION_MONTHS,
  };
  if (settings.EVENT_BUS === 'sqs') {
    const own = deps.sqs ? undefined : sqsFromSettings(settings);
    const consumer = new SqsUsageConsumer({
      sqs: deps.sqs ?? own!.sqs,
      ...sqsQueues(settings),
      db: deps.db,
      logger: logger.child({ component: 'usage-consumer' }),
      clock,
      batchSize: settings.WORKER_BATCH_SIZE,
      // SQS long polls for whole seconds, at most 20.
      waitSeconds: Math.min(20, Math.ceil(settings.WORKER_BLOCK_MS / 1000)),
      visibilitySeconds: Math.ceil(settings.WORKER_CLAIM_IDLE_MS / 1000),
      maxDeliveries: settings.WORKER_MAX_DELIVERIES,
      retention,
      partitions,
      metrics,
      alerts: alerting,
      faults: deps.faults,
    });
    return { consumer, alerts, close: () => Promise.resolve(own?.close()) };
  }
  if (deps.redisUrl === undefined) throw new Error('REDIS_URL is required for the Redis consumer');
  const redis = createRedis(deps.redisUrl, logger, { offlineQueue: true, role: 'usage-consumer' });
  const consumer = new UsageConsumer({
    redis,
    db: deps.db,
    logger: logger.child({ component: 'usage-consumer' }),
    clock,
    stream: settings.EVENTS_STREAM,
    dlqStream: settings.EVENTS_DLQ_STREAM,
    group: settings.EVENTS_CONSUMER_GROUP,
    consumer: `${hostname()}-${process.pid}-${uuidv7().slice(-8)}`,
    batchSize: settings.WORKER_BATCH_SIZE,
    blockMs: settings.WORKER_BLOCK_MS,
    claimIdleMs: settings.WORKER_CLAIM_IDLE_MS,
    maxDeliveries: settings.WORKER_MAX_DELIVERIES,
    trimIntervalMs: settings.WORKER_TRIM_INTERVAL_MS,
    retention,
    partitions,
    metrics,
    alerts: alerting,
    faults: deps.faults,
  });
  return { consumer, alerts, close: () => closeRedis(redis) };
}

/** The worker process: config, connections, migrations and the usage consumer. */
export function createWorker(config: WorkerConfig, logger: Logger): Worker {
  // Batch transactions can take longer than the default 5 s client-side query cap.
  const pool = createPgPool(config.DATABASE_URL, logger, { max: 5, queryTimeoutMs: 30_000 });
  const db = createDb(pool);
  const registry = createMetricsRegistry();
  let readPipeline: PipelineReader;
  let closeState: () => Promise<void>;
  let sqs: SqsApi | undefined;
  if (config.EVENT_BUS === 'sqs') {
    const own = sqsFromSettings(config);
    const queues = sqsQueues(config);
    sqs = own.sqs;
    readPipeline = () => readSqsPipelineState(own.sqs, queues);
    closeState = () => Promise.resolve(own.close());
  } else {
    // The consumer's own connection is held by its blocking read; scrapes read on this one.
    const stateRedis = createRedis(config.REDIS_URL!, logger, { role: 'metrics' });
    readPipeline = () =>
      readPipelineState(stateRedis, systemClock, {
        stream: config.EVENTS_STREAM,
        dlqStream: config.EVENTS_DLQ_STREAM,
        group: config.EVENTS_CONSUMER_GROUP,
      });
    closeState = () => closeRedis(stateRedis);
  }
  watchPipeline(registry, readPipeline);
  const { consumer, alerts, close } = createUsageConsumer({
    settings: config,
    redisUrl: config.REDIS_URL,
    sqs,
    db,
    logger,
    metricsRegistry: registry,
    alertsKey: alertsKey(config),
  });
  let metricsServer: MetricsServer | undefined;

  return {
    consumer,
    metricsPort: () => metricsServer?.port,
    async start() {
      if (config.MIGRATE_ON_START) {
        await migrateDatabase({
          databaseUrl: config.DATABASE_URL,
          dir: config.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
          logger,
        });
      }
      await consumer.start();
      alerts.start();
      metricsServer = await startMetricsServer({
        registry,
        host: config.METRICS_HOST,
        port: config.WORKER_METRICS_PORT,
        token: config.METRICS_TOKEN,
        logger,
      });
      logger.info('worker started');
    },
    async stop() {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), config.SHUTDOWN_TIMEOUT_MS);
      });
      const stopped = Promise.all([consumer.stop(), alerts.stop()])
        .catch((err: unknown) => logger.error({ err }, 'usage consumer stop failed'))
        .then(() => Promise.allSettled([pool.end(), close(), closeState(), metricsServer?.close()]))
        .then(() => 'stopped' as const);
      const outcome = await Promise.race([stopped, timedOut]);
      clearTimeout(timer);
      // Past the timeout, drop the connection so a blocked read cannot hold the process open.
      if (outcome === 'timeout') await Promise.allSettled([close(), metricsServer?.close()]);
      logger.info({ outcome }, 'worker stopped');
      return outcome;
    },
  };
}
