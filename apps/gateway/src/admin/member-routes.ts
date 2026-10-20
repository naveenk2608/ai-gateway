import { uuidv7 } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/passwords.js';
import { GatewayError } from '../errors.js';
import { currentUser, requireProjectRole } from './access.js';
import { writeAudit } from './audit.js';
import {
  errorResponses,
  iso,
  memberSchema,
  projectParams,
  roleSchema,
  type AdminDeps,
} from './schemas.js';

const memberParams = projectParams.extend({ userId: z.uuid() });
const security = [{ session: [] }];

function memberNotFound(): GatewayError {
  return new GatewayError('member_not_found', 'Member not found.', { httpStatus: 404 });
}

/**
 * Locks the project's owner rows and fails if `userId` is the last owner, so concurrent changes
 * cannot leave a project without one.
 */
async function assertNotLastOwner(trx: Db, projectId: string, userId: string): Promise<void> {
  const owners = await trx
    .selectFrom('project_members')
    .select('user_id')
    .where('project_id', '=', projectId)
    .where('role', '=', 'owner')
    .forUpdate()
    .execute();
  if (owners.length === 1 && owners[0]?.user_id === userId) {
    throw new GatewayError('last_owner', 'A project must keep at least one owner.', {
      httpStatus: 409,
    });
  }
}

export function registerMemberRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  const routes = app.withTypeProvider<ZodTypeProvider>();

  routes.get(
    '/admin/projects/:projectId/members',
    {
      schema: {
        tags: ['admin'],
        summary: 'Project members',
        security,
        params: projectParams,
        response: { 200: z.object({ data: z.array(memberSchema) }), ...errorResponses },
      },
    },
    async (request) => {
      const { projectId } = request.params;
      await requireProjectRole(db, request, projectId, 'viewer');
      const rows = await db
        .selectFrom('project_members')
        .innerJoin('users', 'users.id', 'project_members.user_id')
        .select(['users.id', 'users.email', 'project_members.role', 'project_members.created_at'])
        .where('project_members.project_id', '=', projectId)
        .orderBy('project_members.created_at')
        .execute();
      return {
        data: rows.map((r) => ({
          userId: r.id,
          email: r.email,
          role: r.role,
          createdAt: iso(r.created_at),
        })),
      };
    },
  );

  routes.post(
    '/admin/projects/:projectId/members',
    {
      schema: {
        tags: ['admin'],
        summary: 'Add a member (owner)',
        description:
          'Adds an existing user by email. For a new user, `password` sets their initial password.',
        security,
        params: projectParams,
        body: z
          .object({
            email: z.email(),
            role: roleSchema,
            password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
          })
          .strict(),
        response: { 201: memberSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { projectId } = request.params;
      const actor = currentUser(request);
      await requireProjectRole(db, request, projectId, 'owner');
      const email = request.body.email.toLowerCase();
      const { role, password } = request.body;
      // Hash before the transaction; it is slow.
      const passwordHash = password === undefined ? undefined : await hashPassword(password);

      const member = await db.transaction().execute(async (trx) => {
        let user = await trx
          .selectFrom('users')
          .select('id')
          .where('email', '=', email)
          .executeTakeFirst();
        let userCreated = false;
        if (!user) {
          if (!passwordHash) {
            throw new GatewayError(
              'password_required',
              'No user has this email; send `password` to create one.',
              { httpStatus: 400, param: 'password' },
            );
          }
          user = { id: uuidv7() };
          await trx
            .insertInto('users')
            .values({ id: user.id, email, password_hash: passwordHash })
            .execute();
          userCreated = true;
        }
        const inserted = await trx
          .insertInto('project_members')
          .values({ project_id: projectId, user_id: user.id, role })
          .onConflict((oc) => oc.doNothing())
          .returning('created_at')
          .executeTakeFirst();
        if (!inserted) {
          throw new GatewayError('already_member', 'This user is already a member.', {
            httpStatus: 409,
          });
        }
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: actor.id },
          action: 'member.add',
          targetType: 'user',
          targetId: user.id,
          details: { email, role, userCreated },
          requestId: request.id,
        });
        return { userId: user.id, email, role, createdAt: iso(inserted.created_at) };
      });
      return reply.code(201).send(member);
    },
  );

  routes.patch(
    '/admin/projects/:projectId/members/:userId',
    {
      schema: {
        tags: ['admin'],
        summary: "Change a member's role (owner)",
        security,
        params: memberParams,
        body: z.object({ role: roleSchema }).strict(),
        response: { 200: memberSchema, ...errorResponses },
      },
    },
    async (request) => {
      const { projectId, userId } = request.params;
      const actor = currentUser(request);
      await requireProjectRole(db, request, projectId, 'owner');
      const { role } = request.body;
      return db.transaction().execute(async (trx) => {
        if (role !== 'owner') await assertNotLastOwner(trx, projectId, userId);
        const before = await trx
          .selectFrom('project_members')
          .select('role')
          .where('project_id', '=', projectId)
          .where('user_id', '=', userId)
          .forUpdate()
          .executeTakeFirst();
        if (!before) throw memberNotFound();
        const row = await trx
          .updateTable('project_members')
          .set({ role })
          .where('project_id', '=', projectId)
          .where('user_id', '=', userId)
          .returning('created_at')
          .executeTakeFirstOrThrow();
        const user = await trx
          .selectFrom('users')
          .select('email')
          .where('id', '=', userId)
          .executeTakeFirstOrThrow();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: actor.id },
          action: 'member.update',
          targetType: 'user',
          targetId: userId,
          details: { from: before.role, to: role },
          requestId: request.id,
        });
        return { userId, email: user.email, role, createdAt: iso(row.created_at) };
      });
    },
  );

  routes.delete(
    '/admin/projects/:projectId/members/:userId',
    {
      schema: {
        tags: ['admin'],
        summary: 'Remove a member (owner)',
        security,
        params: memberParams,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    async (request, reply) => {
      const { projectId, userId } = request.params;
      const actor = currentUser(request);
      await requireProjectRole(db, request, projectId, 'owner');
      await db.transaction().execute(async (trx) => {
        await assertNotLastOwner(trx, projectId, userId);
        const removed = await trx
          .deleteFrom('project_members')
          .where('project_id', '=', projectId)
          .where('user_id', '=', userId)
          .returning('role')
          .executeTakeFirst();
        if (!removed) throw memberNotFound();
        await writeAudit(trx, {
          projectId,
          actor: { type: 'user', userId: actor.id },
          action: 'member.remove',
          targetType: 'user',
          targetId: userId,
          details: { role: removed.role },
          requestId: request.id,
        });
      });
      return reply.code(204).send(null);
    },
  );
}
