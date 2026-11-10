import { ANALYTICS_RANGES, rangeWindow } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
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

const money = z.object({ listMicroUsd: z.number(), billedMicroUsd: z.number() });

export const semanticSummarySchema = z.object({
  range: z.enum(ANALYTICS_RANGES),
  /** Requests that made a lookup, by outcome (error: the embedding call or the query failed). */
  lookups: z.object({ hit: z.number(), miss: z.number(), error: z.number() }),
  /** The mean cosine similarity of the hits; null without hits. */
  hitSimilarity: z.number().nullable(),
  /** Every lookup's embedding call, hits and misses alike; `unpriced`: calls with no list price. */
  embedding: money.extend({ tokens: z.number(), unpriced: z.number() }),
  /** What the hits' stored answers cost at their models' prices; `unpriced`: hits with none. */
  avoided: money.extend({ unpriced: z.number() }),
  /** Avoided minus embedding cost: negative when the lookups cost more than the hits saved. */
  net: money,
});
export type SemanticSummaryResponse = z.output<typeof semanticSummarySchema>;

/**
 * The semantic cache's per-project settings (M18, ADR 040): read by viewers, set by admins
 * (audited, and applied on every instance through the key cache's invalidation); and its summary,
 * which counts the embedding calls of hits and misses against the cost the hits avoided.
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

  routes.get(
    '/admin/projects/:projectId/semantic-cache/summary',
    {
      schema: {
        tags: ['admin'],
        summary: 'Semantic cache hits, misses, embedding cost and the cost hits avoided (viewer)',
        description:
          'Every lookup pays for its embedding call, hit or miss; `net` is the cost the hits ' +
          "avoided (their stored answers' tokens at the answering model's price) less that.",
        security,
        params: projectParams,
        querystring: z.object({ range: z.enum(ANALYTICS_RANGES).default('24h') }).strict(),
        response: { 200: semanticSummarySchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const { range } = request.query;
      await requireProjectRole(db, request, projectId, 'viewer');
      const window = rangeWindow(range, clock.now());
      const { rows } = await sql<Record<string, string | null>>`
        SELECT count(*) FILTER (WHERE semantic_cache = 'hit') AS hit,
               count(*) FILTER (WHERE semantic_cache = 'miss') AS miss,
               count(*) FILTER (WHERE semantic_cache = 'error') AS error,
               avg(semantic_similarity) FILTER (WHERE semantic_cache = 'hit') AS hit_similarity,
               coalesce(sum(embedding_tokens), 0) AS embedding_tokens,
               coalesce(sum(embedding_cost_micro_usd), 0) AS embedding_list,
               coalesce(sum(embedding_billed_cost_micro_usd), 0) AS embedding_billed,
               count(*) FILTER (WHERE embedding_deployment IS NOT NULL
                                  AND embedding_cost_micro_usd IS NULL) AS embedding_unpriced,
               coalesce(sum(semantic_avoided_cost_micro_usd), 0) AS avoided_list,
               coalesce(sum(semantic_avoided_billed_cost_micro_usd), 0) AS avoided_billed,
               count(*) FILTER (WHERE semantic_cache = 'hit'
                                  AND semantic_avoided_cost_micro_usd IS NULL) AS avoided_unpriced
          FROM request_records
         WHERE project_id = ${projectId}
           AND started_at >= ${new Date(window.from)}
           AND started_at < ${new Date(window.to)}
           AND semantic_cache IS NOT NULL`.execute(db);
      const r = rows[0] ?? {};
      const n = (key: string) => Number(r[key] ?? 0);
      const embedding = {
        listMicroUsd: n('embedding_list'),
        billedMicroUsd: n('embedding_billed'),
      };
      const avoided = { listMicroUsd: n('avoided_list'), billedMicroUsd: n('avoided_billed') };
      return {
        range,
        lookups: { hit: n('hit'), miss: n('miss'), error: n('error') },
        hitSimilarity:
          r.hit_similarity === null || r.hit_similarity === undefined
            ? null
            : Number(r.hit_similarity),
        embedding: {
          ...embedding,
          tokens: n('embedding_tokens'),
          unpriced: n('embedding_unpriced'),
        },
        avoided: { ...avoided, unpriced: n('avoided_unpriced') },
        net: {
          listMicroUsd: avoided.listMicroUsd - embedding.listMicroUsd,
          billedMicroUsd: avoided.billedMicroUsd - embedding.billedMicroUsd,
        },
      };
    },
  );
}
