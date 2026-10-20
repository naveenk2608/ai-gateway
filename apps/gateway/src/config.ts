import { commonConfigShape } from '@ai-gateway/shared';
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
    /** JSON file mapping logical model names to deployments; defaults to config/models.json. */
    MODELS_CONFIG_PATH: z.string().min(1).optional(),
    /** Default server for Ollama deployments that do not set baseUrl. */
    OLLAMA_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:11434'),

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
