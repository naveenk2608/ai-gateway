import { uuidv7 } from '@ai-gateway/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, verifyDecoyPassword, verifyPassword } from '../auth/passwords.js';
import { GatewayError } from '../errors.js';
import { currentUser, newSessionToken, SESSION_COOKIE } from './access.js';
import { writeAudit } from './audit.js';
import { errorResponses, roleSchema, userSchema, type AdminDeps } from './schemas.js';

const invalidCredentials = new GatewayError('invalid_credentials', 'Invalid email or password.', {
  httpStatus: 401,
});

/** POST /admin/auth/login: the one admin route that needs no session. */
export function registerLoginRoute(app: FastifyInstance, deps: AdminDeps): void {
  const { db, clock } = deps;
  app.withTypeProvider<ZodTypeProvider>().post(
    '/admin/auth/login',
    {
      schema: {
        tags: ['admin'],
        summary: 'Log in; sets an HTTP-only session cookie',
        body: z
          .object({ email: z.email(), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) })
          .strict(),
        response: { 200: z.object({ user: userSchema }), ...errorResponses },
      },
    },
    async (request, reply) => {
      const email = request.body.email.toLowerCase();
      const user = await db
        .selectFrom('users')
        .select(['id', 'email', 'password_hash'])
        .where('email', '=', email)
        .where('disabled_at', 'is', null)
        .executeTakeFirst();
      const ok = user
        ? await verifyPassword(user.password_hash, request.body.password)
        : await verifyDecoyPassword(request.body.password);
      if (!user || !ok) {
        request.log.info({ userFound: user !== undefined }, 'admin login failed');
        throw invalidCredentials;
      }

      const { token, hash } = newSessionToken();
      const now = clock.now();
      await db.transaction().execute(async (trx) => {
        // Drop this user's expired sessions while we are here.
        await trx
          .deleteFrom('user_sessions')
          .where('user_id', '=', user.id)
          .where('expires_at', '<=', new Date(now))
          .execute();
        const sessionId = uuidv7(now);
        await trx
          .insertInto('user_sessions')
          .values({
            id: sessionId,
            user_id: user.id,
            token_hash: hash,
            expires_at: new Date(now + deps.sessionTtlSeconds * 1000),
          })
          .execute();
        await writeAudit(trx, {
          projectId: null,
          actor: { type: 'user', userId: user.id },
          action: 'auth.login',
          targetType: 'session',
          targetId: sessionId,
          requestId: request.id,
        });
      });

      void reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        // Strict: the browser never sends the cookie on cross-site requests (CSRF).
        sameSite: 'strict',
        secure: deps.secureCookie,
        path: '/',
        maxAge: deps.sessionTtlSeconds,
      });
      return { user: { id: user.id, email: user.email } };
    },
  );
}

/** Session-scoped account routes. */
export function registerAccountRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.post(
    '/admin/auth/logout',
    {
      schema: {
        tags: ['admin'],
        summary: 'Log out; ends the session',
        security: [{ session: [] }],
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('user_sessions').where('id', '=', user.sessionId).execute();
        await writeAudit(trx, {
          projectId: null,
          actor: { type: 'user', userId: user.id },
          action: 'auth.logout',
          targetType: 'session',
          targetId: user.sessionId,
          requestId: request.id,
        });
      });
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send(null);
    },
  );

  routes.get(
    '/admin/me',
    {
      schema: {
        tags: ['admin'],
        summary: 'The logged-in user and their projects',
        security: [{ session: [] }],
        response: {
          200: z.object({
            user: userSchema,
            projects: z.array(z.object({ id: z.string(), name: z.string(), role: roleSchema })),
          }),
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const user = currentUser(request);
      const projects = await db
        .selectFrom('project_members')
        .innerJoin('projects', 'projects.id', 'project_members.project_id')
        .select(['projects.id', 'projects.name', 'project_members.role'])
        .where('project_members.user_id', '=', user.id)
        .orderBy('projects.id')
        .execute();
      return { user: { id: user.id, email: user.email }, projects };
    },
  );
}
