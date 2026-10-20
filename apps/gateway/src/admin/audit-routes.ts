import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireProjectRole } from './access.js';
import { auditEntrySchema, errorResponses, iso, projectParams, type AdminDeps } from './schemas.js';

export function registerAuditRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  app.withTypeProvider<ZodTypeProvider>().get(
    '/admin/projects/:projectId/audit-logs',
    {
      schema: {
        tags: ['admin'],
        summary: "The project's audit log, newest first (admin)",
        description: 'Pass the last `id` of a page as `before` to get the next page.',
        security: [{ session: [] }],
        params: projectParams,
        querystring: z
          .object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
            before: z.uuid().optional(),
          })
          .strict(),
        response: {
          200: z.object({ data: z.array(auditEntrySchema), nextBefore: z.string().nullable() }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const { limit, before } = request.query;
      await requireProjectRole(db, request, projectId, 'admin');
      // UUIDv7 ids sort by creation time, so the id is the keyset cursor.
      let query = db
        .selectFrom('audit_logs')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('id', 'desc')
        .limit(limit);
      if (before) query = query.where('id', '<', before);
      const rows = await query.execute();
      return {
        data: rows.map((r) => ({
          id: r.id,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          actorType: r.actor_type,
          actorUserId: r.actor_user_id,
          details: r.details as Record<string, unknown>,
          requestId: r.request_id,
          createdAt: iso(r.created_at),
        })),
        nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      };
    },
  );
}
