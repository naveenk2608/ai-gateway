import type { Clock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { z } from 'zod';
import type { AuthInvalidation } from '../auth/invalidation.js';
import { errorBodySchema } from '../proxy/schema.js';

export interface AdminDeps {
  db: Db;
  clock: Clock;
  invalidation: AuthInvalidation;
  pepper: string;
  sessionTtlSeconds: number;
  secureCookie: boolean;
  rotationGraceSeconds: number;
}

export const roleSchema = z.enum(['owner', 'admin', 'viewer']);
export const projectParams = z.object({ projectId: z.uuid() });

/** Response codes every admin route can return, in the OpenAI error shape. */
export const errorResponses = { '4xx': errorBodySchema, '5xx': errorBodySchema } as const;

export const userSchema = z.object({ id: z.string(), email: z.string() });

export const modelListSchema = z.array(z.string().min(1).max(256)).max(500);

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** null: every configured model is allowed. */
  allowedModels: z.array(z.string()).nullable(),
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
