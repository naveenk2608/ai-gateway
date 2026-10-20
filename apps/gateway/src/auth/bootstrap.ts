import { uuidv7 } from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';
import { sql } from 'kysely';
import { writeAudit } from '../admin/audit.js';
import { hashSecret, parseApiKey, secretMatches } from './api-keys.js';
import { hashPassword } from './passwords.js';

/** Serializes bootstrap runs from instances that start together. */
const BOOTSTRAP_LOCK_KEY = 4_206_310_377_028_119;

export interface BootstrapInput {
  projectName: string;
  admin?: { email: string; password: string } | undefined;
  /** A full `gw_<keyId>_<secret>` key chosen by the operator. */
  apiKey?: string | undefined;
}

export interface BootstrapResult {
  projectId: string;
  projectCreated: boolean;
  adminCreated: boolean;
  apiKeyCreated: boolean;
}

const system = { type: 'system' } as const;

/**
 * Creates the first project, owner and API key from settings alone, for hosts with no shell.
 * Idempotent: each item is created only if missing, and existing users, passwords and keys are
 * never changed, so it is safe on every start and on several instances at once.
 */
export async function bootstrap(
  db: Db,
  input: BootstrapInput,
  pepper: string,
  logger: Logger,
): Promise<BootstrapResult | null> {
  if (!input.admin && !input.apiKey) return null;
  const key = input.apiKey ? parseApiKey(input.apiKey) : null;
  if (input.apiKey && !key)
    throw new Error('bootstrap API key is not in the gw_<keyId>_<secret> format');
  const email = input.admin?.email.toLowerCase();
  // Hashing is slow; do it before taking the lock.
  const passwordHash = input.admin ? await hashPassword(input.admin.password) : undefined;

  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`.execute(trx);

    const existingKey = key
      ? await trx
          .selectFrom('api_keys')
          .select(['id', 'project_id', 'secret_hash', 'revoked_at'])
          .where('key_id', '=', key.keyId)
          .executeTakeFirst()
      : undefined;
    const existingUser = email
      ? await trx.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst()
      : undefined;

    // The project: the key's, else the admin's oldest owned one, else one with the name, else new.
    let projectId = existingKey?.project_id;
    if (!projectId && existingUser) {
      const owned = await trx
        .selectFrom('project_members')
        .select('project_id')
        .where('user_id', '=', existingUser.id)
        .where('role', '=', 'owner')
        .orderBy('project_id')
        .executeTakeFirst();
      projectId = owned?.project_id;
    }
    if (!projectId) {
      const named = await trx
        .selectFrom('projects')
        .select('id')
        .where('name', '=', input.projectName)
        .orderBy('id')
        .executeTakeFirst();
      projectId = named?.id;
    }
    const projectCreated = projectId === undefined;
    if (projectId === undefined) {
      projectId = uuidv7();
      await trx.insertInto('projects').values({ id: projectId, name: input.projectName }).execute();
      await writeAudit(trx, {
        projectId,
        actor: system,
        action: 'project.create',
        targetType: 'project',
        targetId: projectId,
        details: { name: input.projectName, source: 'bootstrap' },
      });
    }

    let adminCreated = false;
    if (email && passwordHash && !existingUser) {
      const userId = uuidv7();
      await trx
        .insertInto('users')
        .values({ id: userId, email, password_hash: passwordHash })
        .execute();
      await trx
        .insertInto('project_members')
        .values({ project_id: projectId, user_id: userId, role: 'owner' })
        .execute();
      await writeAudit(trx, {
        projectId,
        actor: system,
        action: 'member.add',
        targetType: 'user',
        targetId: userId,
        details: { email, role: 'owner', source: 'bootstrap' },
      });
      adminCreated = true;
    }

    let apiKeyCreated = false;
    if (key && !existingKey) {
      const apiKeyId = uuidv7();
      await trx
        .insertInto('api_keys')
        .values({
          id: apiKeyId,
          project_id: projectId,
          key_id: key.keyId,
          secret_hash: hashSecret(key.secret, pepper),
          name: 'bootstrap',
        })
        .execute();
      await writeAudit(trx, {
        projectId,
        actor: system,
        action: 'api_key.create',
        targetType: 'api_key',
        targetId: apiKeyId,
        details: { keyId: key.keyId, name: 'bootstrap', source: 'bootstrap' },
      });
      apiKeyCreated = true;
    } else if (key && existingKey) {
      if (!secretMatches(key.secret, pepper, existingKey.secret_hash)) {
        logger.warn(
          { keyId: key.keyId },
          'BOOTSTRAP_API_KEY: a key with this ID exists with a different secret (or pepper); left unchanged',
        );
      } else if (existingKey.revoked_at) {
        logger.warn({ keyId: key.keyId }, 'BOOTSTRAP_API_KEY has been revoked; left revoked');
      }
    }

    return { projectId, projectCreated, adminCreated, apiKeyCreated };
  });
}
