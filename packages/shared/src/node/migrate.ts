import { runner } from 'node-pg-migrate';
import pg from 'pg';
import type { Logger } from 'pino';

/**
 * Advisory lock key every gateway and worker process takes before migrating, so instances that
 * start together run migrations one at a time: the first applies them, the rest find none pending.
 */
export const MIGRATION_LOCK_KEY = 4_206_310_377_028_118;

export interface MigrateOptions {
  databaseUrl: string;
  /** Directory of numbered plain-SQL migrations (db/migrations). */
  dir: string;
  logger: Logger;
  /** How long to wait for the connection; the lock itself is waited for without a limit. */
  connectTimeoutMs?: number;
}

/**
 * Applies pending migrations (ADR 003) under a session-level Postgres advisory lock on a dedicated
 * connection, outside the pool so the pool's query timeout cannot cut a long migration short. A
 * crash releases the lock with the session. Returns the names of the migrations applied.
 */
export async function migrateDatabase({
  databaseUrl,
  dir,
  logger,
  connectTimeoutMs = 5_000,
}: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    application_name: 'ai-gateway-migrate',
  });
  // An error on an idle client would otherwise crash the process; the next query reports it.
  client.on('error', (err) => logger.warn({ err }, 'migration connection error'));
  await client.connect();
  try {
    const started = performance.now();
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    const waitedMs = Math.round(performance.now() - started);
    try {
      const applied = await runner({
        dbClient: client,
        dir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        checkOrder: true,
        singleTransaction: true,
        // Our own lock is held for the whole run (see above).
        noLock: true,
        logger: {
          debug: (msg) => logger.debug({ detail: msg }, 'migration'),
          info: (msg) => logger.debug({ detail: msg }, 'migration'),
          warn: (msg) => logger.warn({ detail: msg }, 'migration'),
          error: (msg) => logger.error({ detail: msg }, 'migration'),
        },
      });
      const names = applied.map((migration) => migration.name);
      logger.info({ applied: names, lockWaitMs: waitedMs }, 'database migrations up to date');
      return names;
    } finally {
      // If the connection broke, the session (and its lock) is already gone.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}
