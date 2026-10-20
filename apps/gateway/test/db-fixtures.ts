import { randomBytes } from 'node:crypto';
import { uuidv7 } from '@ai-gateway/shared';
import type { Db, Role } from '@ai-gateway/shared/node';
import { generateApiKey, hashSecret } from '../src/auth/api-keys.js';
import { hashPassword } from '../src/auth/passwords.js';
import { TEST_PEPPER } from './helpers.js';

/** Rows for one test. Names are unique, so test files sharing the database never collide. */

export async function createProject(
  db: Db,
  {
    name = `project-${randomBytes(3).toString('hex')}`,
    allowedModels = null as string[] | null,
  } = {},
): Promise<string> {
  const id = uuidv7();
  await db.insertInto('projects').values({ id, name, allowed_models: allowedModels }).execute();
  return id;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createUser(
  db: Db,
  memberships: { projectId: string; role: Role }[] = [],
): Promise<TestUser> {
  const id = uuidv7();
  const email = `user-${randomBytes(4).toString('hex')}@example.test`;
  const password = randomBytes(12).toString('base64url');
  await db
    .insertInto('users')
    .values({ id, email, password_hash: await hashPassword(password) })
    .execute();
  for (const { projectId, role } of memberships) {
    await db
      .insertInto('project_members')
      .values({ project_id: projectId, user_id: id, role })
      .execute();
  }
  return { id, email, password };
}

export interface TestKey {
  id: string;
  keyId: string;
  plaintext: string;
}

export async function createApiKey(
  db: Db,
  projectId: string,
  { expiresAt = null as Date | null, revokedAt = null as Date | null } = {},
): Promise<TestKey> {
  const key = generateApiKey();
  const id = uuidv7();
  await db
    .insertInto('api_keys')
    .values({
      id,
      project_id: projectId,
      key_id: key.keyId,
      secret_hash: hashSecret(key.secret, TEST_PEPPER),
      name: 'test',
      expires_at: expiresAt,
      revoked_at: revokedAt,
    })
    .execute();
  return { id, keyId: key.keyId, plaintext: key.plaintext };
}
