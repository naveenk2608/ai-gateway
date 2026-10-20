import type { Clock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { z } from 'zod';
import type { AuthInvalidation } from '../auth/invalidation.js';
import type { LoginThrottle } from '../limits/login-throttle.js';
import type { InfraProbe } from './infra.js';
import { errorBodySchema } from '../proxy/schema.js';

export interface AdminDeps {
  db: Db;
  clock: Clock;
  invalidation: AuthInvalidation;
  pepper: string;
  sessionTtlSeconds: number;
  secureCookie: boolean;
  rotationGraceSeconds: number;
  loginThrottle: Pick<LoginThrottle, 'check'>;
  /** Pipeline, breaker and dependency state for the analytics API. */
  infra: InfraProbe;
}

export const roleSchema = z.enum(['owner', 'admin', 'viewer']);
export const projectParams = z.object({ projectId: z.uuid() });

/** Response codes every admin route can return, in the OpenAI error shape. */
export const errorResponses = { '4xx': errorBodySchema, '5xx': errorBodySchema } as const;

export const userSchema = z.object({ id: z.string(), email: z.string() });

export const modelListSchema = z.array(z.string().min(1).max(256)).max(500);

/** Limits of a key or project (ADR 008). null means no limit. */
export const limitsSchema = z.object({
  requestsPerMinute: z.number().int().positive().max(1_000_000).nullable(),
  /** Estimated prompt plus max output tokens, reconciled to actual usage. */
  tokensPerMinute: z.number().int().positive().max(1_000_000_000).nullable(),
  concurrentRequests: z.number().int().positive().max(100_000).nullable(),
});
/** A change to limits: fields left out stay as they are. */
export const limitsPatchSchema = limitsSchema.partial().strict();

/** A project's budget (ADR 009), in micro-dollars ($1 = 1,000,000). null means none. */
export const budgetSchema = z.object({
  /** Spend allowed per UTC calendar month. */
  monthlyLimitMicroUsd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  /** The most one request may cost in the worst case (its prompt estimate plus max_tokens). */
  maxRequestCostMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export const budgetPatchSchema = budgetSchema.partial().strict();

export interface LimitColumns {
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
}

export function toLimits(row: LimitColumns): z.output<typeof limitsSchema> {
  return {
    requestsPerMinute: row.rpm_limit,
    tokensPerMinute: row.tpm_limit,
    concurrentRequests: row.concurrency_limit,
  };
}

/** The columns a limits change sets; fields left out are not touched. */
export function limitUpdates(patch: z.output<typeof limitsPatchSchema>): Partial<LimitColumns> {
  return {
    ...(patch.requestsPerMinute === undefined ? {} : { rpm_limit: patch.requestsPerMinute }),
    ...(patch.tokensPerMinute === undefined ? {} : { tpm_limit: patch.tokensPerMinute }),
    ...(patch.concurrentRequests === undefined
      ? {}
      : { concurrency_limit: patch.concurrentRequests }),
  };
}

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** null: every configured model is allowed. */
  allowedModels: z.array(z.string()).nullable(),
  limits: limitsSchema,
  budget: budgetSchema,
  role: roleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  role: roleSchema,
  createdAt: z.string(),
});

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `gw_<keyId>_…`: identifies the key without revealing it. */
  maskedKey: z.string(),
  status: z.enum(['active', 'expiring', 'expired', 'revoked']),
  limits: limitsSchema,
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  rotatedTo: z.string().nullable(),
});

export const auditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  actorType: z.enum(['user', 'system']),
  actorUserId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});

export const iso = (date: Date) => date.toISOString();
export const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);
