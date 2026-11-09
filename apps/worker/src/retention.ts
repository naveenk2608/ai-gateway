import type { Db } from '@ai-gateway/shared/node';
import { sql } from 'kysely';

/** How long each rollup table keeps its rows (ADR 015). */
export interface RollupRetention {
  minuteHours: number;
  hourDays: number;
  dayDays: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Deletes rollup rows older than their table's retention; returns the rows deleted per table. */
export async function pruneRollups(
  db: Db,
  now: number,
  retention: RollupRetention,
): Promise<{ minute: number; hour: number; day: number }> {
  const prune = async (
    table: 'usage_rollups_minute' | 'usage_rollups_hour' | 'usage_rollups_day',
    keepMs: number,
  ) => {
    const result = await db
      .deleteFrom(table)
      .where('bucket_start', '<', new Date(now - keepMs))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  };
  return {
    minute: await prune('usage_rollups_minute', retention.minuteHours * HOUR_MS),
    hour: await prune('usage_rollups_hour', retention.hourDays * DAY_MS),
    day: await prune('usage_rollups_day', retention.dayDays * DAY_MS),
  };
}

/**
 * Deletes Idempotency-Keys past their `expires_at` (ADR 032), in batches so no single statement
 * holds locks on many rows; returns how many were deleted. Expiry is set by the gateway that
 * created each key (IDEMPOTENCY_KEY_TTL_HOURS), so the worker needs no setting of its own.
 */
export async function pruneIdempotencyKeys(
  db: Db,
  now: number,
  batchSize = 1_000,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM idempotency_keys
       WHERE id IN (
         SELECT id FROM idempotency_keys
          WHERE expires_at <= ${new Date(now)}
          ORDER BY expires_at
          LIMIT ${batchSize}
       )`.execute(db);
    const n = Number(result.numAffectedRows ?? 0n);
    deleted += n;
    if (n < batchSize) return deleted;
  }
}
