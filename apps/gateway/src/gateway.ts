import { systemClock, type Clock, type Env } from '@ai-gateway/shared';
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
import type { ModelsConfig } from './models-config.js';
import { createRegistry, type ProviderRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';
import { drainAndClose, type DrainOutcome } from './shutdown.js';

export interface Gateway {
  app: App;
  registry: ProviderRegistry;
  start(): Promise<void>;
  /** Drains in-flight requests, then closes the Postgres pool and Redis client. */
  shutdown(): Promise<DrainOutcome>;
}

export interface GatewayDeps {
  models: ModelsConfig;
  clock?: Clock;
  /** Source of provider API keys; defaults to process.env. */
  env?: Env;
}

export function createGateway(config: GatewayConfig, logger: Logger, deps: GatewayDeps): Gateway {
  const clock = deps.clock ?? systemClock;
  const pool = createPgPool(config.DATABASE_URL, logger);
  const redis = createRedis(config.REDIS_URL, logger);
  const registry = createRegistry(deps.models, {
    clock,
    logger,
    env: deps.env ?? process.env,
    ollamaBaseUrl: config.OLLAMA_BASE_URL,
  });

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
  registerChatCompletions(app, { registry, clock });

  // onClose runs after in-flight requests finish, so nothing is still using the pools.
  app.addHook('onClose', async () => {
    await Promise.allSettled([pool.end(), closeRedis(redis), registry.close()]);
  });

  return {
    app,
    registry,
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
