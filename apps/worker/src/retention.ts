import type { Db } from '@ai-gateway/shared/node';

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
