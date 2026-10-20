/**
 * `pnpm db:seed`: local demo data. Applies migrations, then creates a demo project, an owner and
 * an API key, and prints the password and key once. Running it again keeps the project and
 * admin (and the password) and adds a new key.
 */
import { randomBytes } from 'node:crypto';
import { commonConfigShape } from '@ai-gateway/shared';
import {
  createDb,
  createLogger,
  createPgPool,
  loadConfigOrExit,
  migrateDatabase,
} from '@ai-gateway/shared/node';
import { z } from 'zod';
import { generateApiKey } from '../auth/api-keys.js';
import { bootstrap } from '../auth/bootstrap.js';
import { DEFAULT_MIGRATIONS_DIR } from '../gateway.js';

const config = loadConfigOrExit(
  z.object({
    DATABASE_URL: commonConfigShape.DATABASE_URL,
    LOG_LEVEL: commonConfigShape.LOG_LEVEL.default('warn'),
    MIGRATIONS_DIR: z.string().min(1).optional(),
    API_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),
    SEED_ADMIN_EMAIL: z.email().default('admin@example.com'),
  }),
);
const logger = createLogger({ name: 'seed', level: config.LOG_LEVEL });

await migrateDatabase({
  databaseUrl: config.DATABASE_URL,
  dir: config.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
  logger,
});

const pool = createPgPool(config.DATABASE_URL, logger);
const db = createDb(pool);
const password = randomBytes(12).toString('base64url');
const key = generateApiKey();
try {
  const result = await bootstrap(
    db,
    {
      projectName: 'Demo project',
      admin: { email: config.SEED_ADMIN_EMAIL, password },
      apiKey: key.plaintext,
    },
    config.API_KEY_PEPPER,
    logger,
  );
  if (!result) throw new Error('nothing to seed');
  const lines = [
    `Project:  Demo project (${result.projectId})`,
    result.adminCreated
      ? `Admin:    ${config.SEED_ADMIN_EMAIL} / ${password}`
      : `Admin:    ${config.SEED_ADMIN_EMAIL} already exists; password unchanged`,
    `API key:  ${key.plaintext}`,
    '',
    'The password and key are shown only now. Use the key as `Authorization: Bearer <key>`.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await pool.end();
}
