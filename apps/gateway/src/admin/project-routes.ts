import { uuidv7 } from '@ai-gateway/shared';
import type { Role } from '@ai-gateway/shared/node';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { currentUser, projectNotFound, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import {
  errorResponses,
  iso,
  modelListSchema,
  projectParams,
  projectSchema,
  type AdminDeps,
} from './schemas.js';

interface ProjectRow {
  id: string;
  name: string;
  allowed_models: string[] | null;
  created_at: Date;
  updated_at: Date;
}

function toProject(row: ProjectRow, role: Role) {
  return {
    id: row.id,
    name: row.name,
    allowedModels: row.allowed_models,
    role,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const projectColumns = ['id', 'name', 'allowed_models', 'created_at', 'updated_at'] as const;
const security = [{ session: [] }];

export function registerProjectRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects',
    {
      schema: {
        tags: ['admin'],
        summary: 'Projects the caller belongs to',
        security,
        response: { 200: z.object({ data: z.array(projectSchema) }), ...errorResponses },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const rows = await db
        .selectFrom('projects')
        .innerJoin('project_members', 'project_members.project_id', 'projects.id')
        .select([...projectColumns.map((c) => `projects.${c}` as const), 'project_members.role'])
        .where('project_members.user_id', '=', user.id)
        .orderBy('projects.id')
        .execute();
      return { data: rows.map((row) => toProject(row, row.role)) };
    },
  );

  routes.post(
    '/admin/projects',
    {
      schema: {
        tags: ['admin'],
        summary: 'Create a project; the caller becomes its owner',
        security,
        body: z
          .object({
            name: z.string().trim().min(1).max(100),
            allowedModels: modelListSchema.nullish(),
          })
          .strict(),
        response: { 201: projectSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const id = uuidv7();
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto('projects')
          .values({
            id,
            name: request.body.name,
            allowed_models: request.body.allowedModels ?? null,
          })
          .returning(projectColumns)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('project_members')
          .values({ project_id: id, user_id: user.id, role: 'owner' })
          .execute();
        await writeAudit(trx, {
          projectId: id,
          actor: { type: 'user', userId: user.id },
          action: 'project.create',
          targetType: 'project',
          targetId: id,
          details: { name: created.name, allowedModels: created.allowed_models },
          requestId: request.id,
        });
        return created;
      });
      return reply.code(201).send(toProject(row, 'owner'));
    },
  );

  routes.get(
    '/admin/projects/:projectId',
    {
      schema: {
        tags: ['admin'],
        summary: 'One project',
        security,
        params: projectParams,
        response: { 200: projectSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const role = await requireProjectRole(db, request, projectId, 'viewer');
      const row = await db
        .selectFrom('projects')
        .select(projectColumns)
        .where('id', '=', projectId)
        .executeTakeFirst();
      if (!row) throw projectNotFound();
      return toProject(row, role);
    },
  );

  routes.patch(
    '/admin/projects/:projectId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Rename a project or change its model allow-list (admin)',
        description: '`allowedModels: null` allows every configured model.',
        security,
        params: projectParams,
        body: z
          .object({
            name: z.string().trim().min(1).max(100).optional(),
            allowedModels: modelListSchema.nullable().optional(),
          })
          .strict()
          .refine((b) => b.name !== undefined || b.allowedModels !== undefined, {
            message: 'nothing to change',
          }),
        response: { 200: projectSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      const user = currentUser(request);
      const role = await requireProjectRole(db, request, projectId, 'admin');
      const { name, allowedModels } = request.body;
      const row = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable('projects')
          .set({
            ...(name === undefined ? {} : { name }),
            ...(allowedModels === undefined ? {} : { allowed_models: allowedModels }),
            updated_at: new Date(),
          })
          .where('id', '=', projectId)
          .returning(projectColumns)
          .executeTakeFirst();
        if (!updated) throw projectNotFound();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: user.id },
          action: 'project.update',
          targetType: 'project',
          targetId: projectId,
          details: { changes: request.body },
          requestId: request.id,
        });
        return updated;
      });
      // Keys cache the allow-list; drop them on every instance once the change is committed.
      if (allowedModels !== undefined) {
        await deps.invalidation.publish({ kind: 'project', projectId });
      }
      return toProject(row, role);
    },
  );
}
