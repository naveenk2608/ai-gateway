import { uuidv7 } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { GatewayError } from '../errors.js';
import { ROUTING_POLICIES, type ModelRoute } from '../models-config.js';
import { overrideIssues, routeOverrideSchema } from '../routing/overrides.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import { errorResponses, iso, projectParams, type AdminDeps } from './schemas.js';

const security = [{ session: [] }];

const routeSchema = z.object({
  policy: z.enum(ROUTING_POLICIES),
  targets: z.array(
    z.object({ deployment: z.string(), weight: z.number(), lastResort: z.boolean() }),
  ),
});

const versionSchema = z.object({
  version: z.number(),
  action: z.enum(['change', 'rollback', 'reset']),
  /** The whole route of this version; null for a reset (the models file's route). */
  route: routeSchema.nullable(),
  /** For a rollback: the version it copied. */
  rolledBackTo: z.number().nullable(),
  createdAt: z.string(),
  /** The email of who made it; null once that user is deleted. */
  createdBy: z.string().nullable(),
});

export const projectRoutesSchema = z.object({
  /** False when ROUTE_OVERRIDES_ENABLED is off: every project uses the models file. */
  enabled: z.boolean(),
  models: z.array(
    z.object({
      name: z.string(),
      /** The route from the models file. */
      file: routeSchema,
      /** The project's active override, or null when it uses the file's route. */
      override: z
        .object({ version: z.number(), route: routeSchema, createdAt: z.string() })
        .nullable(),
    }),
  ),
});
export type ProjectRoutes = z.output<typeof projectRoutesSchema>;

const modelParams = z.object({ projectId: z.uuid(), model: z.string().min(1).max(256) });

const overridesOff = () =>
  new GatewayError(
    'route_overrides_disabled',
    'Routing overrides are off on this gateway (ROUTE_OVERRIDES_ENABLED).',
    { httpStatus: 409 },
  );

/**
 * Routing edited from the dashboard (M15, ADR 034): per project, a model's policy and targets
 * from the models file may be overridden, using only the deployments the file lists for it. Each
 * change is a new version; rollback copies an old one; reset returns to the file's route. Viewers
 * read; admins change. Every change is audited and reloaded by every instance.
 */
export function registerRouteRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  const overrides = deps.routeOverrides;
  const enabled = overrides?.enabled === true;
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const fileRoute = (model: string): ModelRoute => {
    const found = deps.models.models.find((m) => m.name === model);
    if (!found) {
      throw new GatewayError(
        'model_not_found',
        `The model \`${model}\` is not in the models file.`,
        {
          httpStatus: 404,
          param: 'model',
        },
      );
    }
    return { policy: found.policy, targets: found.targets };
  };

  /** Writes the next version under a per-(project, model) lock, audits it and reloads it. */
  const writeVersion = async (
    request: FastifyRequest,
    projectId: string,
    model: string,
    change: {
      action: 'change' | 'rollback' | 'reset';
      route: ModelRoute | null;
      rolledBackTo?: number;
    },
  ) => {
    const user = currentUser(request);
    const version = await db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`routes:${projectId}:${model}`}, 0))`.execute(
        trx,
      );
      const last = await latestVersion(trx, projectId, model);
      const next = (last ?? 0) + 1;
      await trx
        .insertInto('route_overrides')
        .values({
          id: uuidv7(clock.now()),
          project_id: projectId,
          model,
          version: next,
          action: change.action,
          route: change.route === null ? null : JSON.stringify(change.route),
          rolled_back_to: change.rolledBackTo ?? null,
          created_by: user.id,
        })
        .execute();
      await writeAudit(trx, {
        projectId,
        actor: { type: 'user', userId: user.id },
        action: `route.${change.action === 'change' ? 'update' : change.action}`,
        targetType: 'model_route',
        targetId: null,
        details: {
          model,
          version: next,
          ...(change.rolledBackTo === undefined ? {} : { rolledBackTo: change.rolledBackTo }),
          route: change.route,
        },
        requestId: request.id,
      });
      return next;
    });
    // This instance at once, then every other one through the invalidation channel.
    await overrides?.reloadProject(projectId);
    await deps.invalidation.publish({ kind: 'routes', projectId });
    return { version, route: change.route };
  };

  routes.get(
    '/admin/projects/:projectId/routes',
    {
      schema: {
        tags: ['admin'],
        summary: "Each model's route from the models file and the project's override (viewer)",
        security,
        params: projectParams,
        response: { 200: projectRoutesSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const rows = await sql<{
        model: string;
        version: number;
        route: ModelRoute | null;
        created_at: Date;
      }>`
        SELECT DISTINCT ON (model) model, version, route, created_at
          FROM route_overrides
         WHERE project_id = ${projectId}
         ORDER BY model, version DESC`.execute(db);
      const active = new Map(rows.rows.map((r) => [r.model, r]));
      return {
        enabled,
        models: deps.models.models.map((m) => {
          const row = active.get(m.name);
          return {
            name: m.name,
            file: { policy: m.policy, targets: m.targets },
            override:
              row && row.route
                ? { version: row.version, route: row.route, createdAt: iso(row.created_at) }
                : null,
          };
        }),
      };
    },
  );

  routes.get(
    '/admin/projects/:projectId/routes/:model/history',
    {
      schema: {
        tags: ['admin'],
        summary: "Every version of a model's route override, newest first (viewer)",
        security,
        params: modelParams,
        response: {
          200: z.object({ model: z.string(), versions: z.array(versionSchema) }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const { projectId, model } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      fileRoute(model);
      const rows = await db
        .selectFrom('route_overrides')
        .leftJoin('users', 'users.id', 'route_overrides.created_by')
        .select([
          'route_overrides.version',
          'route_overrides.action',
          'route_overrides.route',
          'route_overrides.rolled_back_to',
          'route_overrides.created_at',
          'users.email',
        ])
        .where('route_overrides.project_id', '=', projectId)
        .where('route_overrides.model', '=', model)
        .orderBy('route_overrides.version', 'desc')
        .limit(100)
        .execute();
      return {
        model,
        versions: rows.map((r) => ({
          version: r.version,
          action: r.action,
          route: (r.route ?? null) as ModelRoute | null,
          rolledBackTo: r.rolled_back_to,
          createdAt: iso(r.created_at),
          createdBy: r.email ?? null,
        })),
      };
    },
  );

  const changed = z.object({ version: z.number(), route: routeSchema.nullable() });

  routes.put(
    '/admin/projects/:projectId/routes/:model',
    {
      schema: {
        tags: ['admin'],
        summary: "Override a model's policy and targets for this project (admin)",
        description:
          'Only the deployments the models file lists for the model; each once. The change is a ' +
          'new version and reaches every gateway instance within seconds.',
        security,
        params: modelParams,
        body: routeOverrideSchema,
        response: { 200: changed, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, model } = request.params;
      await requireProjectRole(db, request, projectId, 'admin');
      if (!enabled) throw overridesOff();
      const issues = overrideIssues(fileRoute(model), request.body);
      if (issues.length > 0) {
        throw new GatewayError('invalid_route', `The route is not valid: ${issues.join('; ')}.`, {
          httpStatus: 400,
          param: 'targets',
        });
      }
      return writeVersion(request, projectId, model, { action: 'change', route: request.body });
    },
  );

  routes.post(
    '/admin/projects/:projectId/routes/:model/rollback',
    {
      schema: {
        tags: ['admin'],
        summary: 'Roll back to an earlier version: a new version copying it (admin)',
        security,
        params: modelParams,
        body: z.object({ version: z.number().int().min(1) }).strict(),
        response: { 200: changed, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, model } = request.params;
      await requireProjectRole(db, request, projectId, 'admin');
      if (!enabled) throw overridesOff();
      const file = fileRoute(model);
      const old = await db
        .selectFrom('route_overrides')
        .select(['route'])
        .where('project_id', '=', projectId)
        .where('model', '=', model)
        .where('version', '=', request.body.version)
        .executeTakeFirst();
      if (!old) {
        throw new GatewayError('version_not_found', 'No such version of this route.', {
          httpStatus: 404,
          param: 'version',
        });
      }
      const route = (old.route ?? null) as ModelRoute | null;
      // The models file may have changed since: an old route must still fit it.
      const issues = route ? overrideIssues(file, route) : [];
      if (issues.length > 0) {
        throw new GatewayError(
          'invalid_route',
          `That version no longer fits the models file: ${issues.join('; ')}.`,
          { httpStatus: 409 },
        );
      }
      return writeVersion(request, projectId, model, {
        action: 'rollback',
        route,
        rolledBackTo: request.body.version,
      });
    },
  );

  routes.post(
    '/admin/projects/:projectId/routes/:model/reset',
    {
      schema: {
        tags: ['admin'],
        summary: "Return to the models file's route: a new version with no override (admin)",
        security,
        params: modelParams,
        response: { 200: changed, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, model } = request.params;
      await requireProjectRole(db, request, projectId, 'admin');
      if (!enabled) throw overridesOff();
      fileRoute(model);
      return writeVersion(request, projectId, model, { action: 'reset', route: null });
    },
  );
}

async function latestVersion(db: Db, projectId: string, model: string): Promise<number | null> {
  const row = await db
    .selectFrom('route_overrides')
    .select((eb) => eb.fn.max('version').as('version'))
    .where('project_id', '=', projectId)
    .where('model', '=', model)
    .executeTakeFirst();
  return row?.version ?? null;
}
