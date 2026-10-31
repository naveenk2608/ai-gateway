import { uuidv7 } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { generateApiKey, hashSecret, maskedKey } from '../auth/api-keys.js';
import { GatewayError } from '../errors.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import {
  apiKeySchema,
  errorResponses,
  iso,
  isoOrNull,
  limitsPatchSchema,
  limitUpdates,
  projectParams,
  toLimits,
  type AdminDeps,
  type LimitColumns,
} from './schemas.js';

const keyParams = projectParams.extend({ apiKeyId: z.uuid() });
/** The longest lifetime a new key may be given: one year. */
const MAX_KEY_LIFETIME_SECONDS = 365 * 24 * 3600;
const security = [{ session: [] }];
const keyColumns = [
  'id',
  'key_id',
  'name',
  'created_at',
  'expires_at',
  'revoked_at',
  'rotated_to',
  'rpm_limit',
  'tpm_limit',
  'concurrency_limit',
] as const;

interface KeyRow extends LimitColumns {
  id: string;
  key_id: string;
  name: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  rotated_to: string | null;
}

function toApiKey(row: KeyRow, now: number) {
  const status = row.revoked_at
    ? 'revoked'
    : row.expires_at === null
      ? 'active'
      : row.expires_at.getTime() <= now
        ? 'expired'
        : 'expiring';
  return {
    id: row.id,
    name: row.name,
    maskedKey: maskedKey(row.key_id),
    status,
    limits: toLimits(row),
    createdAt: iso(row.created_at),
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    rotatedTo: row.rotated_to,
  } as const;
}

function keyNotFound(): GatewayError {
  return new GatewayError('api_key_not_found', 'API key not found.', { httpStatus: 404 });
}

function conflict(code: string, message: string): GatewayError {
  return new GatewayError(code, message, { httpStatus: 409 });
}

/** Inserts a fresh key; the plaintext leaves this function once and is never stored. */
async function insertKey(
  trx: Db,
  projectId: string,
  name: string,
  userId: string,
  pepper: string,
  limits: Partial<LimitColumns> = {},
  expiresAt: Date | null = null,
) {
  const key = generateApiKey();
  const row = await trx
    .insertInto('api_keys')
    .values({
      id: uuidv7(),
      project_id: projectId,
      key_id: key.keyId,
      secret_hash: hashSecret(key.secret, pepper),
      name,
      created_by: userId,
      expires_at: expiresAt,
      ...limits,
    })
    .returning(keyColumns)
    .executeTakeFirstOrThrow();
  return { row, plaintext: key.plaintext };
}

/** The key, locked for update, only if it belongs to the project in the path. */
async function lockKey(trx: Db, projectId: string, apiKeyId: string): Promise<KeyRow> {
  const row = await trx
    .selectFrom('api_keys')
    .select(keyColumns)
    .where('id', '=', apiKeyId)
    .where('project_id', '=', projectId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw keyNotFound();
  return row;
}

export function registerApiKeyRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock, pepper } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects/:projectId/api-keys',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's API keys (never the secrets)",
        security,
        params: projectParams,
        response: { 200: z.object({ data: z.array(apiKeySchema) }), ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const rows = await db
        .selectFrom('api_keys')
        .select(keyColumns)
        .where('project_id', '=', projectId)
        .orderBy('id', 'desc')
        .execute();
      const now = clock.now();
      return { data: rows.map((row) => toApiKey(row, now)) };
    },
  );

  routes.post(
    '/admin/projects/:projectId/api-keys',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create an API key (admin); the full key is returned only in this response',
        description:
          'With `expiresInSeconds`, the key stops working that long after it is created (the ' +
          'dashboard Playground uses one-hour keys); without it, the key never expires.',
        security,
        params: projectParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(100),
            limits: limitsPatchSchema.optional(),
            expiresInSeconds: z.number().int().min(60).max(MAX_KEY_LIFETIME_SECONDS).optional(),
          })
          .strict(),
        response: {
          201: z.object({ apiKey: apiKeySchema, key: z.string() }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const { name, limits, expiresInSeconds } = request.body;
      const expiresAt =
        expiresInSeconds === undefined ? null : new Date(clock.now() + expiresInSeconds * 1000);
      const created = await db.transaction().execute(async (trx) => {
        const result = await insertKey(
          trx,
          projectId,
          name,
          user.id,
          pepper,
          limitUpdates(limits ?? {}),
          expiresAt,
        );
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'api_key.create',
          targetType: 'api_key',
          targetId: result.row.id,
          details: {
            keyId: result.row.key_id,
            name: result.row.name,
            limits: toLimits(result.row),
            expiresAt: isoOrNull(result.row.expires_at),
          },
          requestId: request.id,
        });
        return result;
      });
      void reply.header('cache-control', 'no-store');
      return reply
        .code(201)
        .send({ apiKey: toApiKey(created.row, clock.now()), key: created.plaintext });
    },
  );

  routes.patch(
    '/admin/projects/:projectId/api-keys/:apiKeyId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Rename an API key or change its limits (admin)',
        description:
          'Key limits apply on top of the project limits. `null` removes a limit; a field left ' +
          'out stays as it is.',
        security,
        params: keyParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(100).optional(),
            limits: limitsPatchSchema.optional(),
          })
          .strict()
          .refine((b) => b.name !== undefined || b.limits !== undefined, {
            message: 'nothing to change',
          }),
        response: { 200: apiKeySchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, apiKeyId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const { name, limits } = request.body;
      const row = await db.transaction().execute(async (trx) => {
        await lockKey(trx, projectId, apiKeyId);
        const updated = await trx
          .updateTable('api_keys')
          .set({ ...(name === undefined ? {} : { name }), ...limitUpdates(limits ?? {}) })
          .where('id', '=', apiKeyId)
          .returning(keyColumns)
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'api_key.update',
          targetType: 'api_key',
          targetId: apiKeyId,
          details: { keyId: updated.key_id, changes: request.body },
          requestId: request.id,
        });
        return updated;
      });
      // Cached copies of the key hold its old limits.
      await deps.invalidation.publish({ kind: 'api_key', keyId: row.key_id });
      return toApiKey(row, clock.now());
    },
  );

  routes.post(
    '/admin/projects/:projectId/api-keys/:apiKeyId/revoke',
    {
      schema: {
        tags: ['admin'],
        summary: 'Revoke an API key (admin)',
        description:
          'Takes effect at once on this instance, on others when the invalidation message ' +
          'arrives, and everywhere within API_KEY_CACHE_TTL_MS.',
        security,
        params: keyParams,
        response: { 200: apiKeySchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, apiKeyId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const row = await db.transaction().execute(async (trx) => {
        const current = await lockKey(trx, projectId, apiKeyId);
        if (current.revoked_at) throw conflict('api_key_revoked', 'The key is already revoked.');
        const revoked = await trx
          .updateTable('api_keys')
          .set({ revoked_at: new Date(clock.now()) })
          .where('id', '=', apiKeyId)
          .returning(keyColumns)
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'api_key.revoke',
          targetType: 'api_key',
          targetId: apiKeyId,
          details: { keyId: revoked.key_id },
          requestId: request.id,
        });
        return revoked;
      });
      await deps.invalidation.publish({ kind: 'api_key', keyId: row.key_id });
      return toApiKey(row, clock.now());
    },
  );

  routes.post(
    '/admin/projects/:projectId/api-keys/:apiKeyId/rotate',
    {
      schema: {
        tags: ['admin'],
        summary:
          'Rotate an API key (admin): a new key now, the old one expires after a grace period',
        security,
        params: keyParams,
        body: z
          .object({
            gracePeriodSeconds: z
              .number()
              .int()
              .min(0)
              .max(30 * 24 * 3600)
              .optional(),
          })
          .strict()
          .optional(),
        response: {
          201: z.object({ apiKey: apiKeySchema, key: z.string(), previous: apiKeySchema }),
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const { projectId, apiKeyId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const grace = request.body?.gracePeriodSeconds ?? deps.rotationGraceSeconds;
      const now = clock.now();
      const result = await db.transaction().execute(async (trx) => {
        const old = await lockKey(trx, projectId, apiKeyId);
        if (old.revoked_at) throw conflict('api_key_revoked', 'A revoked key cannot be rotated.');
        if (old.rotated_to) {
          throw conflict('api_key_already_rotated', 'The key has already been rotated.');
        }
        if (old.expires_at && old.expires_at.getTime() <= now) {
          throw conflict('api_key_expired', 'An expired key cannot be rotated.');
        }
        // The new key keeps the old one's name and limits.
        const created = await insertKey(trx, projectId, old.name, user.id, pepper, {
          rpm_limit: old.rpm_limit,
          tpm_limit: old.tpm_limit,
          concurrency_limit: old.concurrency_limit,
        });
        const graceEnd = now + grace * 1000;
        const expiresAt = new Date(
          old.expires_at ? Math.min(old.expires_at.getTime(), graceEnd) : graceEnd,
        );
        const previous = await trx
          .updateTable('api_keys')
          .set({ expires_at: expiresAt, rotated_to: created.row.id })
          .where('id', '=', apiKeyId)
          .returning(keyColumns)
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'api_key.rotate',
          targetType: 'api_key',
          targetId: apiKeyId,
          details: {
            keyId: previous.key_id,
            newApiKeyId: created.row.id,
            newKeyId: created.row.key_id,
            gracePeriodSeconds: grace,
            oldKeyExpiresAt: iso(expiresAt),
          },
          requestId: request.id,
        });
        return { created, previous };
      });
      // Cached copies of the old key do not know their new expiry yet.
      await deps.invalidation.publish({ kind: 'api_key', keyId: result.previous.key_id });
      void reply.header('cache-control', 'no-store');
      return reply.code(201).send({
        apiKey: toApiKey(result.created.row, now),
        key: result.created.plaintext,
        previous: toApiKey(result.previous, now),
      });
    },
  );
}
