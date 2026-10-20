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

const INT8_OID = 20;

/** bigint columns (micro-dollars, counts) as numbers; values past 2^53 would lose precision, so they throw. */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} exceeds Number range`);
  return n;
}

const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary'): unknown => {
    if (oid === INT8_OID && format !== 'binary') return parseInt8;
    return pg.types.getTypeParser(oid, format) as unknown;
  }) as typeof pg.types.getTypeParser,
};

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
    types,
  });
  // An idle client losing its connection emits 'error' on the pool; unhandled, it crashes the process.
  pool.on('error', (err) => logger.warn({ err }, 'postgres idle client error'));
  return pool;
}

export async function pingPostgres(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
