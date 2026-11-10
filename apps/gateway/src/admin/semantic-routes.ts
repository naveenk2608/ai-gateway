import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  DEFAULT_SEMANTIC_THRESHOLD,
  parseSemanticPolicy,
  semanticPolicySchema,
} from '../semantic/policy.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import { errorResponses, projectParams, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];

const settingsResponse = z.object({
  /** SEMANTIC_CACHE_ENABLED: false means no project's lookups run. */
  enabled: z.boolean(),
  /** Whether Postgres has the entries table (pgvector); false while enabled means it cannot run. */
  available: z.boolean(),
  /** SEMANTIC_CACHE_EMBEDDING_MODEL: the embeddings model every lookup calls. */
  embeddingModel: z.string(),
  /** The threshold of a project that sets none. */
  defaultThreshold: z.number(),
  policy: semanticPolicySchema,
});

/**
 * The semantic cache's per-project settings (M18, ADR 040): read by viewers, set by admins
 * (audited, and applied on every instance through the key cache's invalidation).
 */
export function registerSemanticRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const status = async () => ({
    enabled: deps.semanticCache?.enabled === true,
    available: deps.semanticCache ? await deps.semanticCache.available() : false,
    embeddingModel: deps.semanticCache?.embeddingModel ?? '',
    defaultThreshold: DEFAULT_SEMANTIC_THRESHOLD,
  });

  routes.get(
    '/admin/projects/:projectId/semantic-cache',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's semantic cache settings (viewer)",
        security,
        params: projectParams,
        response: { 200: settingsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const row = await db
        .selectFrom('projects')
        .select('semantic_cache')
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      return { ...(await status()), policy: parseSemanticPolicy(row.semantic_cache) };
    },
  );

  routes.put(
    '/admin/projects/:projectId/semantic-cache',
    {
      schema: {
        tags: ['admin'],
        summary: "Set the project's semantic cache settings (admin)",
        description:
          'Mode: off, header (only requests sending `x-gateway-semantic-cache: on`) or all ' +
          '(every eligible request unless it sends `off`); the cosine similarity a hit needs ' +
          '(null: the measured default), how long answers are kept, and how many per project.',
        security,
        params: projectParams,
        body: semanticPolicySchema,
        response: { 200: settingsResponse, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const user = currentUser(request);
      await requireProjectRole(db, request, projectId, 'admin');
      const policy = request.body;
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('projects')
          .set({ semantic_cache: JSON.stringify(policy), updated_at: new Date(clock.now()) })
          .where('id', '=', projectId)
          .execute();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'project.semantic_cache',
          targetType: 'project',
          targetId: projectId,
          details: { ...policy },
          requestId: request.id,
        });
      });
      // Cached keys carry the settings: every instance reads them again.
      await deps.invalidation.publish({ kind: 'project', projectId });
      return { ...(await status()), policy };
    },
  );
}
