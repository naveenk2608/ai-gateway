import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import { requireSession } from './access.js';
import { registerApiKeyRoutes } from './api-key-routes.js';
import { registerAuditRoutes } from './audit-routes.js';
import { registerAccountRoutes, registerLoginRoute } from './auth-routes.js';
import { registerMemberRoutes } from './member-routes.js';
import { registerProjectRoutes } from './project-routes.js';
import type { AdminDeps } from './schemas.js';

export type { AdminDeps } from './schemas.js';

/**
 * The admin API (ADR 007) for the dashboard: session-cookie auth, per-project roles, and an
 * audit row in the same transaction as every change.
 */
export async function registerAdminApi(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  await app.register(cookie);
  app.decorateRequest('adminUser', null);
  registerLoginRoute(app, deps);

  await app.register((scoped, _opts, done) => {
    scoped.addHook('onRequest', requireSession(deps.db, deps.clock));
    registerAccountRoutes(scoped, deps);
    registerProjectRoutes(scoped, deps);
    registerMemberRoutes(scoped, deps);
    registerApiKeyRoutes(scoped, deps);
    registerAuditRoutes(scoped, deps);
    done();
  });
}
