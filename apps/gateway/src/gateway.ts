import {
  closeRedis,
  createPgPool,
  createRedis,
  pingPostgres,
  pingRedis,
  type Logger,
} from '@ai-gateway/shared/node';
import { buildApp, type App } from './app.js';
import type { GatewayConfig } from './config.js';
import { drainAndClose, type DrainOutcome } from './shutdown.js';

export interface Gateway {
  app: App;
  start(): Promise<void>;
  /** Drains in-flight requests, then closes the Postgres pool and Redis client. */
  shutdown(): Promise<DrainOutcome>;
}

export function createGateway(config: GatewayConfig, logger: Logger): Gateway {
  const pool = createPgPool(config.DATABASE_URL, logger);
  const redis = createRedis(config.REDIS_URL, logger);

  const app = buildApp({
    logger,
    readiness: {
      checks: {
        postgres: () => pingPostgres(pool),
        redis: () => pingRedis(redis),
      },
      timeoutMs: config.READY_CHECK_TIMEOUT_MS,
    },
  });

  // onClose runs after in-flight requests finish, so nothing is still using the pools.
  app.addHook('onClose', async () => {
    await Promise.allSettled([pool.end(), closeRedis(redis)]);
  });

  return {
    app,
    async start() {
      await app.listen({ host: config.HOST, port: config.PORT });
    },
    async shutdown() {
      const outcome = await drainAndClose(app, config.SHUTDOWN_TIMEOUT_MS);
      logger.info({ outcome }, 'gateway stopped');
      return outcome;
    },
  };
}
