import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemClock, uuidv7, type Clock, type Env } from '@ai-gateway/shared';
import {
  closeRedis,
  createDb,
  createPgPool,
  createMetricsRegistry,
  createRedis,
  migrateDatabase,
  pingPostgres,
  pingRedis,
  startMetricsServer,
  type Db,
  type Logger,
  type MetricsServer,
} from '@ai-gateway/shared/node';
import { registerAdminApi } from './admin/index.js';
import { redisInfraProbe } from './admin/infra.js';
import { modelCatalog } from './admin/model-routes.js';
import { ResponseCache } from './cache/response-cache.js';
import { buildApp, type App } from './app.js';
import { bootstrap } from './auth/bootstrap.js';
import { AuthInvalidation } from './auth/invalidation.js';
import { databaseKeyLoader, KeyVerifier } from './auth/key-verifier.js';
import type { GatewayConfig } from './config.js';
import type { EventBus } from './events/bus.js';
import { RedisStreamBus } from './events/redis-stream.js';
import { AdmissionControl } from './limits/admission.js';
import { databaseSpendLoader, ReservationSweeper } from './limits/ledger.js';
import { Limiter } from './limits/limiter.js';
import { LoginThrottle } from './limits/login-throttle.js';
import { GatewayMetrics } from './metrics.js';
import { databasePriceLoader, PriceBook } from './limits/prices.js';
import type { ModelsConfig } from './models-config.js';
import { createRegistry, type ProviderRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';
import { BreakerBoard } from './routing/breaker.js';
import { HealthChecker, HealthReporter } from './routing/health.js';
import type { RoutingDeps } from './routing/routed.js';
import { LatencyTracker } from './routing/router.js';
import { drainAndClose, type DrainOutcome } from './shutdown.js';
import { createUsageConsumer, type UsageConsumer } from '@ai-gateway/worker';

/** src/ and dist/ both sit three levels below the repository root, where db/migrations lives. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../db/migrations', import.meta.url),
);

export interface Gateway {
  app: App;
  db: Db;
  registry: ProviderRegistry;
  verifier: KeyVerifier;
  invalidation: AuthInvalidation;
  events: EventBus;
  limiter: Limiter;
  prices: PriceBook;
  sweeper: ReservationSweeper;
  breakers: BreakerBoard;
  healthChecker: HealthChecker;
  /** This process's Prometheus metrics. */
  metrics: GatewayMetrics;
  /** The private metrics listener's port once started, when METRICS_PORT is set. */
  metricsPort(): number | undefined;
  /** The in-process usage consumer, when RUN_WORKER_IN_PROCESS is on. */
  consumer: UsageConsumer | undefined;
  /** Applies pending migrations (if enabled), then listens. */
  start(): Promise<void>;
  /** Drains in-flight requests, then closes the Postgres pool and Redis client. */
  shutdown(): Promise<DrainOutcome>;
}

export interface GatewayDeps {
  models: ModelsConfig;
  clock?: Clock;
  /** Source of provider API keys; defaults to process.env. */
  env?: Env;
  /** Pub/sub channel for key invalidations; tests isolate instances with their own channel. */
  invalidationChannel?: string;
  /** Randomness for weighted routing and retry jitter; tests make it repeatable. */
  random?: () => number;
}

export function createGateway(config: GatewayConfig, logger: Logger, deps: GatewayDeps): Gateway {
  const clock = deps.clock ?? systemClock;
  const pool = createPgPool(config.DATABASE_URL, logger);
  const db = createDb(pool);
  const redis = createRedis(config.REDIS_URL, logger);
  const checks = { postgres: () => pingPostgres(pool), redis: () => pingRedis(redis) };
  const registry = createRegistry(deps.models, {
    clock,
    logger,
    env: deps.env ?? process.env,
    ollamaBaseUrl: config.OLLAMA_BASE_URL,
  });
  // One registry per process (ADR 017); tests build several gateways, each with its own.
  const metrics = new GatewayMetrics(createMetricsRegistry(), {
    deployments: registry.deployments().map((d) => ({
      id: d.id,
      provider: d.provider.kind,
      providerModel: d.providerModel,
    })),
    models: registry.modelNames(),
  });
  let metricsServer: MetricsServer | undefined;

  const verifier = new KeyVerifier({
    load: databaseKeyLoader(db),
    pepper: config.API_KEY_PEPPER,
    clock,
    ttlMs: config.API_KEY_CACHE_TTL_MS,
  });
  const invalidation = new AuthInvalidation({
    verifier,
    redis,
    redisUrl: config.REDIS_URL,
    logger,
    channel: deps.invalidationChannel,
  });

  const events = new RedisStreamBus({
    redis,
    logger,
    clock,
    stream: config.EVENTS_STREAM,
    bufferMax: config.EVENTS_BUFFER_MAX,
    streamMaxLen: config.EVENTS_STREAM_MAXLEN,
  });

  const prices = new PriceBook({
    load: databasePriceLoader(db),
    clock,
    logger,
    refreshMs: config.PRICES_REFRESH_INTERVAL_MS,
  });
  const limiter = new Limiter({
    redis,
    clock,
    logger,
    loadSpend: databaseSpendLoader(db),
    leaseTtlMs: config.LIMITS_LEASE_TTL_MS,
  });
  const sweeper = new ReservationSweeper({
    limiter,
    db,
    clock,
    logger,
    intervalMs: config.BUDGET_SWEEP_INTERVAL_MS,
  });
  const admission = new AdmissionControl({
    limiter,
    prices,
    failMode: config.LIMITS_FAIL_MODE,
  });

  const reporter = new HealthReporter({
    redis,
    db,
    logger,
    instanceId: `${hostname()}-${process.pid}-${uuidv7().slice(-8)}`,
  });
  const deployments = registry.deployments();
  const breakers = new BreakerBoard(
    deployments.map((d) => d.id),
    { failureThreshold: config.BREAKER_FAILURE_THRESHOLD, openMs: config.BREAKER_OPEN_MS },
    clock,
    (t) => {
      reporter.report(t);
      metrics.breakerTransition(t);
    },
  );
  const healthChecker = new HealthChecker({
    breakers,
    deployments,
    clock,
    logger,
    intervalMs: config.HEALTH_CHECK_INTERVAL_MS,
    timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
  });
  const routing: RoutingDeps = {
    breakers,
    latency: new LatencyTracker(),
    prices,
    random: deps.random ?? Math.random,
    retry: {
      maxAttempts: config.RETRY_MAX_ATTEMPTS,
      perDeployment: config.RETRY_PER_DEPLOYMENT,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      maxDelayMs: config.RETRY_MAX_DELAY_MS,
    },
  };

  const cache = config.CACHE_ENABLED
    ? new ResponseCache({
        redis,
        logger,
        ttlSeconds: config.CACHE_TTL_SECONDS,
        maxEntryBytes: config.CACHE_MAX_ENTRY_BYTES,
      })
    : null;

  metrics.watch({ breakers, events, pool, checks, timeoutMs: config.READY_CHECK_TIMEOUT_MS });

  const inProcess = config.RUN_WORKER_IN_PROCESS
    ? createUsageConsumer({ settings: config, redisUrl: config.REDIS_URL, db, logger, clock })
    : undefined;

  const app = buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    metrics,
    metricsToken: config.METRICS_TOKEN,
    readiness: {
      checks,
      timeoutMs: config.READY_CHECK_TIMEOUT_MS,
    },
  });
  void app.register((instance, _opts, done) => {
    registerChatCompletions(instance, {
      registry,
      clock,
      verifier,
      events,
      admission,
      routing,
      cache,
      metrics,
    });
    done();
  });
  void app.register((instance) =>
    registerAdminApi(instance, {
      db,
      clock,
      invalidation,
      pepper: config.API_KEY_PEPPER,
      sessionTtlSeconds: config.SESSION_TTL_SECONDS,
      secureCookie: config.SESSION_COOKIE_SECURE ?? config.NODE_ENV === 'production',
      rotationGraceSeconds: config.API_KEY_ROTATION_GRACE_SECONDS,
      loginThrottle: new LoginThrottle({
        limiter,
        perEmail: config.LOGIN_ATTEMPTS_PER_MINUTE,
        perIp: config.LOGIN_ATTEMPTS_PER_MINUTE_PER_IP,
        failMode: config.LIMITS_FAIL_MODE,
      }),
      infra: redisInfraProbe({
        redis,
        clock,
        stream: config.EVENTS_STREAM,
        dlqStream: config.EVENTS_DLQ_STREAM,
        group: config.EVENTS_CONSUMER_GROUP,
        deployments: deployments.map((d) => d.id),
        checks,
      }),
      models: modelCatalog(deps.models, registry),
    }),
  );

  // onClose runs after in-flight requests finish, so nothing is still using the pools.
  app.addHook('onClose', async () => {
    // Flush buffered usage events while Redis is still open, then let the consumer finish its
    // batch; whatever it leaves pending is claimed by the next worker.
    prices.stop();
    await Promise.all([sweeper.stop(), healthChecker.stop()]);
    await events.close(Math.min(2_000, config.SHUTDOWN_TIMEOUT_MS));
    if (inProcess) {
      await inProcess.consumer.stop();
      await inProcess.close();
    }
    await Promise.allSettled([
      pool.end(),
      closeRedis(redis),
      invalidation.close(),
      registry.close(),
      metricsServer?.close(),
    ]);
  });

  return {
    app,
    db,
    registry,
    verifier,
    invalidation,
    events,
    limiter,
    prices,
    sweeper,
    breakers,
    healthChecker,
    metrics,
    metricsPort: () => metricsServer?.port,
    consumer: inProcess?.consumer,
    async start() {
      if (config.MIGRATE_ON_START) {
        await migrateDatabase({
          databaseUrl: config.DATABASE_URL,
          dir: config.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
          logger,
        });
      }
      const admin =
        config.BOOTSTRAP_ADMIN_EMAIL && config.BOOTSTRAP_ADMIN_PASSWORD
          ? { email: config.BOOTSTRAP_ADMIN_EMAIL, password: config.BOOTSTRAP_ADMIN_PASSWORD }
          : undefined;
      const boot = await bootstrap(
        db,
        { projectName: config.BOOTSTRAP_PROJECT_NAME, admin, apiKey: config.BOOTSTRAP_API_KEY },
        config.API_KEY_PEPPER,
        logger,
      );
      if (boot) logger.info(boot, 'bootstrap settings applied');
      await prices.start();
      sweeper.start();
      healthChecker.start();
      invalidation.start();
      if (inProcess) {
        await inProcess.consumer.start();
        logger.info('usage consumer running in the gateway process');
      }
      await app.listen({ host: config.HOST, port: config.PORT });
      if (config.METRICS_PORT !== undefined) {
        metricsServer = await startMetricsServer({
          registry: metrics.registry,
          host: config.METRICS_HOST,
          port: config.METRICS_PORT,
          token: config.METRICS_TOKEN,
          logger,
        });
      } else if (config.METRICS_TOKEN === undefined) {
        logger.info('metrics are off: set METRICS_TOKEN or METRICS_PORT to serve /metrics');
      }
    },
    async shutdown() {
      const outcome = await drainAndClose(app, config.SHUTDOWN_TIMEOUT_MS);
      logger.info({ outcome }, 'gateway stopped');
      return outcome;
    },
  };
}
