import { closeRedis, createPgPool, createRedis, type Logger } from '@ai-gateway/shared/node';
import type { WorkerConfig } from './config.js';

export type StopOutcome = 'stopped' | 'timeout';

export interface Worker {
  start(): void;
  /** Closes the Postgres pool and Redis client, giving up after SHUTDOWN_TIMEOUT_MS. */
  stop(): Promise<StopOutcome>;
}

/**
 * The worker process shell: config, logging, connections and shutdown. The usage-event consumer
 * (M3) runs inside it; until then the open Redis connection keeps the process alive.
 */
export function createWorker(config: WorkerConfig, logger: Logger): Worker {
  const pool = createPgPool(config.DATABASE_URL, logger, { max: 5 });
  const redis = createRedis(config.REDIS_URL, logger);

  return {
    start() {
      logger.info('worker started');
    },
    async stop() {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), config.SHUTDOWN_TIMEOUT_MS);
      });
      const closed = Promise.allSettled([pool.end(), closeRedis(redis)]).then(
        () => 'stopped' as const,
      );
      const outcome = await Promise.race([closed, timedOut]);
      clearTimeout(timer);
      logger.info({ outcome }, 'worker stopped');
      return outcome;
    },
  };
}
