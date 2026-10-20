import pg from 'pg';
import type { Logger } from 'pino';

export interface PgPoolOptions {
  max?: number;
  connectTimeoutMs?: number;
  /**
   * Client-side cap on any query. Without it, a query to an unresponsive server holds its client
   * forever and pool.end() never resolves, which would stall shutdown.
   */
  queryTimeoutMs?: number;
}

export function createPgPool(
  connectionString: string,
  logger: Logger,
  { max = 10, connectTimeoutMs = 2_000, queryTimeoutMs = 5_000 }: PgPoolOptions = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: connectTimeoutMs,
    query_timeout: queryTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: 'ai-gateway',
  });
  // An idle client losing its connection emits 'error' on the pool; unhandled, it crashes the process.
  pool.on('error', (err) => logger.warn({ err }, 'postgres idle client error'));
  return pool;
}

export async function pingPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
