import { commonConfigShape, metricsConfigShape } from '@ai-gateway/shared';
import { consumerSettingsShape } from '@ai-gateway/worker';
import { z } from 'zod';
import { API_KEY_PATTERN } from './auth/api-keys.js';

const flag = z.stringbool();

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
    /** Default server for Ollama deployments that do not set baseUrl. */
    OLLAMA_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:11434'),

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
    /** Circuit breakers (ADR 012): consecutive failures that open one, and how long it stays open. */
    BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(5),
    BREAKER_OPEN_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
    /** How often open breakers' deployments are health-checked, and each check's timeout. */
    HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
    HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

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
