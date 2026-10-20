import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemClock, uuidv7, type Clock } from '@ai-gateway/shared';
import {
  closeRedis,
  createDb,
  createMetricsRegistry,
  createPgPool,
  createRedis,
  migrateDatabase,
  startMetricsServer,
  type Db,
  type Logger,
  type MetricsServer,
  type Redis,
  type Registry,
} from '@ai-gateway/shared/node';
import type { ConsumerSettings, WorkerConfig } from './config.js';
import { UsageConsumer, type ConsumerOptions } from './consumer.js';
import { WorkerMetrics } from './metrics.js';
import { readPipelineState } from './pipeline.js';

/** src/ and dist/ both sit three levels below the repository root, where db/migrations lives. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
);

export type StopOutcome = 'stopped' | 'timeout';

export interface Worker {
  consumer: UsageConsumer;
  /** The metrics listener's port once started. */
  metricsPort(): number | undefined;
  /** Applies migrations (if enabled), then starts consuming. */
  start(): Promise<void>;
  /** Stops consuming, then closes the Postgres pool and Redis client, within SHUTDOWN_TIMEOUT_MS. */
  stop(): Promise<StopOutcome>;
}

export interface UsageConsumerDeps {
  settings: ConsumerSettings;
  redisUrl: string;
  db: Db;
  logger: Logger;
  clock?: Clock;
  faults?: ConsumerOptions['faults'];
  /**
   * Where the consumer's metrics go (ADR 017), and a connection to read the stream's state at
   * scrape time: the consumer's own connection is held by its blocking read.
   */
  metrics?: { registry: Registry; redis: Redis };
}

/** A consumer on its own Redis connection, named uniquely for this process. */
export function createUsageConsumer(deps: UsageConsumerDeps): {
  consumer: UsageConsumer;
  close: () => Promise<void>;
} {
  const { settings, logger } = deps;
  const clock = deps.clock ?? systemClock;
  const redis = createRedis(deps.redisUrl, logger, { offlineQueue: true, role: 'usage-consumer' });
  let metrics: WorkerMetrics | undefined;
  if (deps.metrics) {
    const { redis: stateRedis, registry } = deps.metrics;
    metrics = new WorkerMetrics(registry);
    metrics.watchPipeline(() =>
      readPipelineState(stateRedis, clock, {
        stream: settings.EVENTS_STREAM,
        dlqStream: settings.EVENTS_DLQ_STREAM,
        group: settings.EVENTS_CONSUMER_GROUP,
      }),
    );
  }
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
    retention: {
      minuteHours: settings.ROLLUP_RETENTION_MINUTE_HOURS,
      hourDays: settings.ROLLUP_RETENTION_HOUR_DAYS,
      dayDays: settings.ROLLUP_RETENTION_DAY_DAYS,
      intervalMs: settings.ROLLUP_RETENTION_INTERVAL_MS,
    },
    metrics,
    faults: deps.faults,
  });
  return { consumer, close: () => closeRedis(redis) };
}

/** The worker process: config, connections, migrations and the usage consumer. */
export function createWorker(config: WorkerConfig, logger: Logger): Worker {
  // Batch transactions can take longer than the default 5 s client-side query cap.
  const pool = createPgPool(config.DATABASE_URL, logger, { max: 5, queryTimeoutMs: 30_000 });
  const db = createDb(pool);
  const registry = createMetricsRegistry();
  const stateRedis = createRedis(config.REDIS_URL, logger, { role: 'metrics' });
  const { consumer, close } = createUsageConsumer({
    settings: config,
    redisUrl: config.REDIS_URL,
    db,
    logger,
    metrics: { registry, redis: stateRedis },
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
      const stopped = consumer
        .stop()
        .catch((err: unknown) => logger.error({ err }, 'usage consumer stop failed'))
        .then(() =>
          Promise.allSettled([pool.end(), close(), closeRedis(stateRedis), metricsServer?.close()]),
        )
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
