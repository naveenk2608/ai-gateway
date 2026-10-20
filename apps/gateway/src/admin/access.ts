import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '@ai-gateway/shared';
import type { Db, Role } from '@ai-gateway/shared/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GatewayError } from '../errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook on admin routes. */
    adminUser: AdminUser | null;
  }
}

export interface AdminUser {
  id: string;
  email: string;
  sessionId: string;
}

export const SESSION_COOKIE = 'gw_session';

/** A new opaque session token; only its SHA-256 is stored. */
export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashSessionToken(token) };
}

export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

const notLoggedIn = new GatewayError('not_authenticated', 'Log in to use the admin API.', {
  httpStatus: 401,
});

/** onRequest hook for admin routes: requires a live session cookie. */
export function requireSession(db: Db, clock: Clock) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw notLoggedIn;
    const session = await db
      .selectFrom('user_sessions')
      .innerJoin('users', 'users.id', 'user_sessions.user_id')
      .select(['user_sessions.id', 'users.id as userId', 'users.email'])
      .where('user_sessions.token_hash', '=', hashSessionToken(token))
      .where('user_sessions.expires_at', '>', new Date(clock.now()))
      .where('users.disabled_at', 'is', null)
      .executeTakeFirst();
    if (!session) throw notLoggedIn;
    request.adminUser = { id: session.userId, email: session.email, sessionId: session.id };
    request.log = request.log.child({ userId: session.userId });
  };
}

const RANK: Record<Role, number> = { viewer: 1, admin: 2, owner: 3 };

export function projectNotFound(): GatewayError {
  return new GatewayError('project_not_found', 'Project not found.', { httpStatus: 404 });
}

/**
 * The caller's role in a project, or a 404 when they are not a member: another project's
 * resources are indistinguishable from ones that do not exist. A member whose role is too low gets
 * a 403, since they can already see the project.
 */
export async function requireProjectRole(
  db: Db,
  request: FastifyRequest,
  projectId: string,
  minimum: Role,
): Promise<Role> {
  const user = request.adminUser;
  if (!user) throw notLoggedIn;
  const member = await db
    .selectFrom('project_members')
    .select('role')
    .where('project_id', '=', projectId)
    .where('user_id', '=', user.id)
    .executeTakeFirst();
  if (!member) throw projectNotFound();
  if (RANK[member.role] < RANK[minimum]) {
    throw new GatewayError(
      'insufficient_role',
      `This action needs the ${minimum} role in this project.`,
      { httpStatus: 403 },
    );
  }
  return member.role;
}

/** The authenticated user; only for routes behind requireSession. */
export function currentUser(request: FastifyRequest): AdminUser {
  if (!request.adminUser) throw notLoggedIn;
  return request.adminUser;
}
