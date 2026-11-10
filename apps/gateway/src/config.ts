import { checkEventBusConfig, commonConfigShape, metricsConfigShape } from '@ai-gateway/shared';
import { consumerSettingsShape } from '@ai-gateway/worker';
import { z } from 'zod';
import { API_KEY_PATTERN } from './auth/api-keys.js';

const flag = z.stringbool();

const listItems = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim().replace(/\/$/, ''))
    .filter((item) => item !== '');

/** An exact web origin: http(s), host and optional port, nothing else (no path, no wildcard). */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

export const gatewayConfigSchema = z
  .object({
    ...commonConfigShape,
    /** Loopback by default; the container image sets 0.0.0.0. */
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
    READY_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
    /**
     * Prometheus metrics (ADR 017). With METRICS_TOKEN set, `GET /metrics` on PORT needs it as a
     * bearer token. METRICS_PORT adds a separate listener on METRICS_HOST (loopback by default)
     * that needs the token only if one is set.
     */
    ...metricsConfigShape,
    METRICS_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
    /**
     * Proxies in front of the gateway whose X-Forwarded-For entries are trusted, counted from the
     * right; the client IP is the entry before them. 0 uses the TCP peer address.
     */
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    /** JSON file mapping logical model names to deployments; defaults to config/models.json. */
    MODELS_CONFIG_PATH: z.string().min(1).optional(),
    /**
     * The built dashboard (`apps/dashboard/dist`), served at /dashboard/ on the gateway's origin;
     * GET / then redirects there. Unset: not served (use the Vite dev server). The image sets it.
     */
    DASHBOARD_DIR: z.string().min(1).optional(),
    /** Default server for Ollama deployments that do not set baseUrl. */
    OLLAMA_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:11434'),
    /**
     * Browser origins allowed to call /v1 across origins (CORS, ADR 021), comma-separated, e.g.
     * `https://app.example.com`. Empty: none. The admin API never allows other origins.
     */
    ALLOWED_ORIGINS: z
      .string()
      .default('')
      .refine((value) => listItems(value).every(isOrigin), {
        message:
          'use comma-separated origins such as https://app.example.com (scheme, host and an ' +
          'optional port; no path and no *)',
      })
      .transform(listItems),

    /**
     * Run the usage consumer inside the gateway process, for hosts with no background workers
     * (Render's free plan). Off by default: normally the worker process consumes. Uses the same
     * EVENTS_* and WORKER_* settings as the worker.
     */
    RUN_WORKER_IN_PROCESS: flag.default(false),
    ...consumerSettingsShape,
    /** Usage events held in memory while Redis is unreachable; beyond it, events are dropped. */
    EVENTS_BUFFER_MAX: z.coerce.number().int().positive().default(10_000),
    /** Approximate cap on the usage stream's length, so Redis memory stays bounded. */
    EVENTS_STREAM_MAXLEN: z.coerce.number().int().positive().default(100_000),

    /**
     * When Redis cannot be reached: `closed` rejects requests that have limits or a budget with a
     * 503 (ADR 010); `open` admits them unchecked and logs it.
     */
    LIMITS_FAIL_MODE: z.enum(['closed', 'open']).default('closed'),
    /**
     * How long a concurrency lease or budget reservation lives without renewal: how soon a crashed
     * request's slot and reservation are freed. Running requests renew every third of it.
     */
    LIMITS_LEASE_TTL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
    /** How often expired budget reservations are released and recorded as expired. */
    BUDGET_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
    /** How often model prices are reloaded from Postgres for budget reservations. */
    PRICES_REFRESH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

    /**
     * Retries and fallback (ADR 011): attempts per request across deployments, attempts on one
     * deployment before falling back, and the full-jitter backoff between retries.
     */
    RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    RETRY_PER_DEPLOYMENT: z.coerce.number().int().min(1).max(5).default(2),
    RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(100),
    RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
    /**
     * A retry budget per deployment (ADR 011, note of 2026-11-08): within RETRY_BUDGET_WINDOW_MS,
     * retries on a deployment may be at most RETRY_BUDGET_RATIO of its first tries, or
     * RETRY_BUDGET_MIN_RETRIES, whichever is more. Ratio and floor are Envoy's defaults (20%, 3);
     * the window is Linkerd's 10 s. Off, only RETRY_MAX_ATTEMPTS and RETRY_PER_DEPLOYMENT apply.
     */
    RETRY_BUDGET_ENABLED: flag.default(true),
    RETRY_BUDGET_RATIO: z.coerce.number().min(0).max(10).default(0.2),
    RETRY_BUDGET_MIN_RETRIES: z.coerce.number().int().min(0).max(10_000).default(3),
    RETRY_BUDGET_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(10_000),
    /**
     * The most a request may take until its response starts (a stream's first event): no try,
     * retry or fallback starts after it, a running try is cut at it, and the client gets 504
     * `upstream_timeout`. Below a deployment's own `timeoutMs`, it also cuts a single try.
     */
    REQUEST_DEADLINE_MS: z.coerce.number().int().min(100).max(600_000).default(50_000),
    /**
     * The `peak_ewma` routing policy (ADR 030). Off, its routes are ordered as `lowest_latency`.
     * The decay is the time constant of the latency estimate (Finagle's `decayTime` default,
     * 10 s); the default estimate is what a deployment with no sample yet is scored with (tower's
     * documented default of 1 s), so a new deployment gets some traffic but not all of it.
     */
    PEAK_EWMA_ENABLED: flag.default(true),
    PEAK_EWMA_DECAY_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),
    PEAK_EWMA_DEFAULT_MS: z.coerce.number().int().min(1).max(600_000).default(1_000),
    /**
     * M15 (ADR 030 note of 2026-11-09): a try that failed because the deployment could not serve
     * (rate limited, server error, connection, invalid response, auth, not found) records its
     * `timeoutMs` as a penalty sample, so a deployment that always fails fast does not look fast.
     */
    PEAK_EWMA_FAILURE_PENALTY: flag.default(true),
    /**
     * Routing edited from the dashboard (M15, ADR 034): a project admin may override a model's
     * policy and targets for their project, using only the deployments the models file lists for
     * it. Every instance reloads a project's overrides when one changes (the invalidation channel)
     * and all of them every ROUTE_OVERRIDES_REFRESH_MS, in case a message was lost.
     */
    ROUTE_OVERRIDES_ENABLED: flag.default(true),
    /**
     * Guardrails (M16, ADR 035): each project's checks before and after the model. Every check is
     * off until a project admin turns it on; false skips them for every project.
     */
    GUARDRAILS_ENABLED: flag.default(true),
    ROUTE_OVERRIDES_REFRESH_MS: z.coerce.number().int().min(500).max(3_600_000).default(30_000),
    /**
     * M15: without new samples, estimates move toward PEAK_EWMA_DEFAULT_MS instead of toward zero
     * (a penalty fades to the default, not below it). Off: tower's decay toward zero, which also
     * re-tries idle deployments faster than the default in light, sequential traffic.
     */
    PEAK_EWMA_DECAY_TO_DEFAULT: flag.default(true),
    /** Circuit breakers (ADR 012): consecutive failures that open one, and how long it stays open. */
    BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(5),
    BREAKER_OPEN_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
    /** How often open breakers' deployments are health-checked, and each check's timeout. */
    HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
    /**
     * The least time between two `chat` health checks of one deployment (ADR 026): each is a real
     * request for one token, so it runs far less often than the free `models` check.
     */
    HEALTH_CHECK_CHAT_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
    /** The longest wait between `chat` checks of a deployment whose checks keep failing. */
    HEALTH_CHECK_CHAT_MAX_INTERVAL_MS: z.coerce.number().int().min(100).default(3_600_000),
    /**
     * Cooldown after an upstream 429 that sent no Retry-After (ADR 025): every instance skips the
     * deployment for this long. 0 starts none without a Retry-After.
     */
    PROVIDER_COOLDOWN_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),

    /**
     * Exact-match response cache (ADR 013): for temperature-0 requests and those sent with
     * `x-gateway-cache: on`. Off by default, because it keeps completions in Redis (prompts only
     * as a hash). Entries live CACHE_TTL_SECONDS; larger responses are not stored.
     */
    CACHE_ENABLED: flag.default(false),
    CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(30 * 24 * 3600)
      .default(3_600),
    CACHE_MAX_ENTRY_BYTES: z.coerce.number().int().min(1_024).max(10_000_000).default(262_144),
    /**
     * M15: the cache stores only while Redis has room. Before a store it reads `INFO memory` (at
     * most once per CACHE_MEMORY_CHECK_INTERVAL_MS) and stores while `used_memory` is below
     * CACHE_MAX_MEMORY_SHARE of `maxmemory`, or below CACHE_MAX_MEMORY_BYTES when `maxmemory` is 0
     * (no limit). If INFO fails or is not allowed, nothing is stored. Lookups are unaffected.
     * The share leaves the other half for limits, budgets, quotas and the usage stream, which fail
     * closed when Redis refuses writes (ADR 010); 64 MiB bounds a Redis with no limit set.
     */
    CACHE_MEMORY_GUARD_ENABLED: flag.default(true),
    CACHE_MEMORY_CHECK_INTERVAL_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
    CACHE_MAX_MEMORY_SHARE: z.coerce.number().gt(0).max(1).default(0.5),
    CACHE_MAX_MEMORY_BYTES: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .default(64 * 1_048_576),
    /**
     * Request coalescing (ADR 031): identical requests the cache would take (chat at temperature
     * 0 or with `x-gateway-cache: on`; embeddings unless `off`) that arrive while one of them is
     * upstream wait for its answer instead of calling the provider again, on this instance. On by
     * default: it keeps nothing beyond the requests themselves, whether CACHE_ENABLED is on or not.
     */
    COALESCE_ENABLED: flag.default(true),
    /**
     * Semantic cache (M18, ADR 040): a request the exact cache would take, after its miss, is
     * answered from the most similar earlier request of the same project, logical model and
     * context, where the project opts in (each project starts off). Off by default: it stores
     * answers in Postgres and makes an embedding call per lookup with
     * SEMANTIC_CACHE_EMBEDDING_MODEL, an embeddings model of the models file, checked at startup.
     * Its default, nomic-embed-text, is the free local model the default threshold was measured
     * with. Needs pgvector (migration 0018); without it the gateway logs that it is unavailable.
     */
    SEMANTIC_CACHE_ENABLED: flag.default(false),
    SEMANTIC_CACHE_EMBEDDING_MODEL: z.string().trim().min(1).max(256).default('nomic-embed-text'),
    /**
     * Idempotency-Key on POST /v1/chat/completions and /v1/embeddings (M15, ADR 032): a retry with
     * the same key and body gets the first answer instead of a second call. On by default: it acts
     * only on requests that send the header, and keeps small rows in Postgres that expire after
     * IDEMPOTENCY_KEY_TTL_HOURS (24: Stripe keeps keys at least 24 hours,
     * docs.stripe.com/error-low-level, checked 2026-11-09). A running request holds its key for
     * IDEMPOTENCY_LOCK_MS before another instance may take it over (a crashed holder); answers
     * larger than IDEMPOTENCY_MAX_BODY_BYTES are not kept (a repeat then gets 409).
     */
    IDEMPOTENCY_ENABLED: flag.default(true),
    IDEMPOTENCY_KEY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
    IDEMPOTENCY_LOCK_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
    IDEMPOTENCY_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(10_000_000).default(262_144),

    /** Apply pending migrations at startup, under an advisory lock (safe with several instances). */
    MIGRATE_ON_START: flag.default(true),
    /** Defaults to db/migrations in the repository; the container image sets its own path. */
    MIGRATIONS_DIR: z.string().min(1).optional(),

    /** Server secret mixed into API-key hashes (ADR 006). Changing it invalidates every key. */
    API_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),
    /** How long a verified key stays cached; the upper bound for a revocation to take effect. */
    API_KEY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
    /** Default time an old key keeps working after a rotation. */
    API_KEY_ROTATION_GRACE_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 3600)
      .default(24 * 3600),
    /**
     * API key IDs that do not exist one client IP may send per minute before its requests get 429
     * without a database lookup (M12). Key IDs found in the database are never limited.
     */
    UNKNOWN_KEYS_PER_MINUTE_PER_IP: z.coerce.number().int().positive().default(30),
    /** How long a key ID the database does not have is remembered in Redis. */
    UNKNOWN_KEY_CACHE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),

    /** Admin login attempts allowed per minute for one email address, and from one client IP. */
    LOGIN_ATTEMPTS_PER_MINUTE: z.coerce.number().int().positive().default(10),
    LOGIN_ATTEMPTS_PER_MINUTE_PER_IP: z.coerce.number().int().positive().default(30),

    /** Admin session lifetime. */
    SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(30 * 24 * 3600)
      .default(12 * 3600),
    /** Mark the session cookie Secure (HTTPS only). Defaults to true when NODE_ENV=production. */
    SESSION_COOKIE_SECURE: flag.optional(),

    /**
     * First-run setup from environment settings alone (hosts with no shell). Each item is created
     * only if missing; existing users, keys and passwords are never changed.
     */
    BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12, 'must be at least 12 characters').optional(),
    BOOTSTRAP_API_KEY: z
      .string()
      .regex(API_KEY_PATTERN, 'must look like gw_<16 hex>_<64 hex>; run `pnpm key:generate`')
      .optional(),
    BOOTSTRAP_PROJECT_NAME: z.string().min(1).max(100).default('Default project'),
  })
  .superRefine((config, ctx) => {
    checkEventBusConfig(config, ctx);
    if (
      (config.BOOTSTRAP_ADMIN_EMAIL === undefined) !==
      (config.BOOTSTRAP_ADMIN_PASSWORD === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_ADMIN_PASSWORD'],
        message: 'set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD together',
      });
    }
  });

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
