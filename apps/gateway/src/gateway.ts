import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { systemClock, uuidv7, type Clock, type Env } from '@ai-gateway/shared';
import {
  alertsKey,
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
import { processInstanceProbe } from './admin/instance.js';
import { modelCatalog } from './admin/model-routes.js';
import { ResponseCache } from './cache/response-cache.js';
import { Coalescer } from './proxy/coalesce.js';
import { buildApp, type App } from './app.js';
import { bootstrap } from './auth/bootstrap.js';
import { AuthInvalidation } from './auth/invalidation.js';
import { databaseKeyLoader, KeyVerifier } from './auth/key-verifier.js';
import { UnknownKeyGuard } from './auth/unknown-keys.js';
import type { GatewayConfig } from './config.js';
import type { DashboardFiles } from './dashboard.js';
import type { EventBus } from './events/bus.js';
import { RedisStreamBus } from './events/redis-stream.js';
import { SqsBus } from './events/sqs.js';
import { AdmissionControl } from './limits/admission.js';
import { databaseSpendLoader, ReservationSweeper } from './limits/ledger.js';
import { Limiter } from './limits/limiter.js';
import { LoginThrottle } from './limits/login-throttle.js';
import { GatewayMetrics } from './metrics.js';
import { databasePriceLoader, PriceBook } from './limits/prices.js';
import type { ModelsConfig } from './models-config.js';
import { createRegistry, type ProviderRegistry } from './providers/registry.js';
import { registerChatCompletions } from './proxy/chat-completions.js';
import { registerEmbeddings } from './proxy/embeddings.js';
import { registerModels } from './proxy/models.js';
import { BreakerBoard } from './routing/breaker.js';
import { HealthChecker, HealthReporter } from './routing/health.js';
import type { RoutingDeps } from './routing/routed.js';
import { PeakEwma } from './routing/peak-ewma.js';
import { MemoryGuard } from './cache/memory-guard.js';
import { IdempotencyGate } from './proxy/idempotency.js';
import { BreakerAlerts } from './routing/breaker-alerts.js';
import { RouteOverrides } from './routing/overrides.js';
import { QuotaBoard, quotaUsedShare } from './routing/quota.js';
import { RetryBudget } from './routing/retry-budget.js';
import { LatencyTracker } from './routing/router.js';
import { drainAndClose, type DrainOutcome } from './shutdown.js';
import {
  createUsageConsumer,
  readPipelineState,
  readSqsPipelineState,
  sqsFromSettings,
  sqsQueues,
  watchPipeline,
  type EventConsumer,
  type PipelineReader,
} from '@ai-gateway/worker';

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
  consumer: EventConsumer | undefined;
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
  /** The built dashboard to serve at /dashboard/ (read from DASHBOARD_DIR by main). */
  dashboard?: DashboardFiles;
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
      provider: d.providerName,
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
    unknownKeys: new UnknownKeyGuard({
      redis,
      clock,
      logger,
      perMinutePerIp: config.UNKNOWN_KEYS_PER_MINUTE_PER_IP,
      cacheMs: config.UNKNOWN_KEY_CACHE_MS,
      onResult: (result) => metrics.unknownApiKey(result),
    }),
  });
  // Per-project route overrides (ADR 034), reloaded through the invalidation channel.
  const routeOverrides = new RouteOverrides(
    { enabled: config.ROUTE_OVERRIDES_ENABLED, refreshMs: config.ROUTE_OVERRIDES_REFRESH_MS },
    { db, logger, clock },
  );
  const invalidation = new AuthInvalidation({
    onRoutes: (projectId) =>
      void (projectId === null
        ? routeOverrides.reloadAll()
        : routeOverrides.reloadProject(projectId)),
    verifier,
    redis,
    redisUrl: config.REDIS_URL,
    logger,
    channel: deps.invalidationChannel,
  });

  // Usage events go to a Redis Stream, or to SQS on AWS (ADR 023); the pipeline state shown on
  // the Infrastructure page and in metrics is read from the same place.
  const sqs = config.EVENT_BUS === 'sqs' ? sqsFromSettings(config) : undefined;
  let events: EventBus;
  let readPipeline: PipelineReader;
  if (sqs) {
    const queues = sqsQueues(config);
    events = new SqsBus({
      sqs: sqs.sqs,
      queueUrl: queues.queueUrl,
      logger,
      clock,
      bufferMax: config.EVENTS_BUFFER_MAX,
    });
    readPipeline = () => readSqsPipelineState(sqs.sqs, queues);
  } else {
    events = new RedisStreamBus({
      redis,
      logger,
      clock,
      stream: config.EVENTS_STREAM,
      bufferMax: config.EVENTS_BUFFER_MAX,
      streamMaxLen: config.EVENTS_STREAM_MAXLEN,
    });
    readPipeline = () =>
      readPipelineState(redis, clock, {
        stream: config.EVENTS_STREAM,
        dlqStream: config.EVENTS_DLQ_STREAM,
        group: config.EVENTS_CONSUMER_GROUP,
      });
  }

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

  /** This process, in health reports and as the holder of Idempotency-Key locks. */
  const instanceId = `${hostname()}-${process.pid}-${uuidv7().slice(-8)}`;
  const reporter = new HealthReporter({
    redis,
    db,
    logger,
    instanceId,
  });
  const deployments = registry.deployments();
  // Webhook alerts (ADR 033): the key for destination URLs, and breaker-opened alerts.
  const alertKey = alertsKey(config);
  const breakerAlerts = new BreakerAlerts({
    db,
    clock,
    logger,
    intervalMs: config.ALERTS_BREAKER_INTERVAL_MS,
    enabled: config.ALERTS_ENABLED,
    provider: (id) => registry.deployment(id)?.providerName,
  });
  const breakers = new BreakerBoard(
    deployments.map((d) => d.id),
    { failureThreshold: config.BREAKER_FAILURE_THRESHOLD, openMs: config.BREAKER_OPEN_MS },
    clock,
    (t) => {
      reporter.report(t);
      metrics.breakerTransition(t);
      if (t.to === 'open') void breakerAlerts.opened(t.deployment);
    },
  );
  const quotas = new QuotaBoard({
    redis,
    clock,
    logger,
    defaultCooldownMs: config.PROVIDER_COOLDOWN_MS,
    onSkip: (deployment, kind) => metrics.providerSkipped(deployment, kind),
    onCooldown: (deployment) => metrics.cooldownStarted(deployment),
  });
  const healthChecker = new HealthChecker({
    breakers,
    deployments,
    clock,
    logger,
    intervalMs: config.HEALTH_CHECK_INTERVAL_MS,
    timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
    chatIntervalMs: config.HEALTH_CHECK_CHAT_INTERVAL_MS,
    chatMaxIntervalMs: config.HEALTH_CHECK_CHAT_MAX_INTERVAL_MS,
    quotas,
  });
  const quotaUsage = () => quotas.usage(deployments);
  const peakEwma = new PeakEwma(
    {
      enabled: config.PEAK_EWMA_ENABLED,
      decayMs: config.PEAK_EWMA_DECAY_MS,
      defaultMs: config.PEAK_EWMA_DEFAULT_MS,
      failurePenalty: config.PEAK_EWMA_FAILURE_PENALTY,
      decayToDefault: config.PEAK_EWMA_DECAY_TO_DEFAULT,
    },
    clock,
  );
  const routing: RoutingDeps = {
    breakers,
    latency: new LatencyTracker(),
    peakEwma,
    prices,
    quotas,
    random: deps.random ?? Math.random,
    retry: {
      maxAttempts: config.RETRY_MAX_ATTEMPTS,
      perDeployment: config.RETRY_PER_DEPLOYMENT,
      baseDelayMs: config.RETRY_BASE_DELAY_MS,
      maxDelayMs: config.RETRY_MAX_DELAY_MS,
    },
    retryBudget: new RetryBudget(
      {
        enabled: config.RETRY_BUDGET_ENABLED,
        ratio: config.RETRY_BUDGET_RATIO,
        minRetries: config.RETRY_BUDGET_MIN_RETRIES,
        windowMs: config.RETRY_BUDGET_WINDOW_MS,
      },
      clock,
      (deployment) => metrics.retryBudgetSkipped(deployment),
    ),
    deadlineMs: config.REQUEST_DEADLINE_MS,
  };

  const cache = config.CACHE_ENABLED
    ? new ResponseCache({
        redis,
        logger,
        ttlSeconds: config.CACHE_TTL_SECONDS,
        maxEntryBytes: config.CACHE_MAX_ENTRY_BYTES,
        guard: new MemoryGuard(
          {
            enabled: config.CACHE_MEMORY_GUARD_ENABLED,
            intervalMs: config.CACHE_MEMORY_CHECK_INTERVAL_MS,
            maxShare: config.CACHE_MAX_MEMORY_SHARE,
            maxBytesWhenUnlimited: config.CACHE_MAX_MEMORY_BYTES,
          },
          {
            info: () => redis.info('memory'),
            clock,
            logger,
            onReading: (r, cap) => metrics.cacheMemoryReading(r.usedBytes, cap),
          },
        ),
        onSkip: (reason) => metrics.cacheStoreSkipped(reason),
      })
    : null;
  const coalescer = new Coalescer(config.COALESCE_ENABLED);
  const idempotency = new IdempotencyGate(
    {
      enabled: config.IDEMPOTENCY_ENABLED,
      ttlMs: config.IDEMPOTENCY_KEY_TTL_HOURS * 3_600_000,
      lockMs: config.IDEMPOTENCY_LOCK_MS,
      maxBodyBytes: config.IDEMPOTENCY_MAX_BODY_BYTES,
    },
    { db, clock, logger, instanceId },
  );

  metrics.watch({
    breakers,
    peakEwma,
    events,
    pool,
    checks,
    timeoutMs: config.READY_CHECK_TIMEOUT_MS,
    quotas: async () =>
      (await quotaUsage()).map((u) => ({ deployment: u.deployment, share: quotaUsedShare(u) })),
  });
  const processProbe = processInstanceProbe(() => events.stats());
  // The pipeline state stays visible here while the worker is down (stream lag rising).
  watchPipeline(metrics.registry, readPipeline);

  const inProcess = config.RUN_WORKER_IN_PROCESS
    ? createUsageConsumer({
        settings: config,
        redisUrl: config.REDIS_URL,
        sqs: sqs?.sqs,
        db,
        logger,
        clock,
        metricsRegistry: metrics.registry,
        alertsKey: alertKey,
        random: deps.random ?? Math.random,
      })
    : undefined;

  const app = buildApp({
    logger,
    trustProxy: config.TRUST_PROXY,
    metrics,
    metricsToken: config.METRICS_TOKEN,
    allowedOrigins: config.ALLOWED_ORIGINS,
    dashboard: deps.dashboard,
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
      coalescer,
      idempotency,
      routeOverrides,
      guardrailsEnabled: config.GUARDRAILS_ENABLED,
      metrics,
    });
    registerEmbeddings(instance, {
      registry,
      clock,
      verifier,
      events,
      admission,
      routing,
      cache,
      coalescer,
      idempotency,
      routeOverrides,
      guardrailsEnabled: config.GUARDRAILS_ENABLED,
      metrics,
    });
    registerModels(instance, { registry, verifier, clock });
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
        pipeline: readPipeline,
        deployments: deployments.map((d) => d.id),
        checks,
        instance: () => processProbe.read(),
      }),
      models: modelCatalog(deps.models, registry),
      quotas: quotaUsage,
      alerts: { enabled: config.ALERTS_ENABLED, key: alertKey },
      routeOverrides,
    }),
  );

  // onClose runs after in-flight requests finish, so nothing is still using the pools.
  app.addHook('onClose', async () => {
    // Flush buffered usage events while Redis is still open, then let the consumer finish its
    // batch; whatever it leaves pending is claimed by the next worker.
    prices.stop();
    processProbe.stop();
    await Promise.all([sweeper.stop(), healthChecker.stop(), routeOverrides.stop()]);
    await events.close(Math.min(2_000, config.SHUTDOWN_TIMEOUT_MS));
    if (inProcess) {
      await Promise.all([inProcess.consumer.stop(), inProcess.alerts.stop()]);
      await inProcess.close();
    }
    sqs?.close();
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
      // The first load runs in the background: if Postgres is down, the models file applies.
      routeOverrides.start();
      invalidation.start();
      if (inProcess) {
        await inProcess.consumer.start();
        inProcess.alerts.start();
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
