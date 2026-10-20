/** `pnpm db:migrate`: applies pending migrations, as the gateway does at startup. */
import { commonConfigShape } from '@ai-gateway/shared';
import { createLogger, loadConfigOrExit, migrateDatabase } from '@ai-gateway/shared/node';
import { z } from 'zod';
import { DEFAULT_MIGRATIONS_DIR } from '../gateway.js';

const config = loadConfigOrExit(
  z.object({
    DATABASE_URL: commonConfigShape.DATABASE_URL,
    LOG_LEVEL: commonConfigShape.LOG_LEVEL,
    MIGRATIONS_DIR: z.string().min(1).optional(),
  }),
);
const logger = createLogger({ name: 'migrate', level: config.LOG_LEVEL });

try {
  await migrateDatabase({
    databaseUrl: config.DATABASE_URL,
    dir: config.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR,
    logger,
  });
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}
