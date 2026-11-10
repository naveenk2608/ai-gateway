import type { Db } from '@ai-gateway/shared/node';
import { sql } from 'kysely';

/** The raw request tables partitioned by month (migration 0017, ADR 039), and their keys. */
export const RAW_TABLES = [
  ['request_records', 'started_at'],
  ['provider_attempts', 'started_at'],
  ['usage_events', 'occurred_at'],
] as const;

export interface PartitionSettings {
  /** Off: partitions are neither created nor dropped (RAW_PARTITIONS_ENABLED). */
  enabled: boolean;
  /** Months after the current one that always have a partition (RAW_PARTITIONS_AHEAD_MONTHS). */
  aheadMonths: number;
  /**
   * Whole months of raw rows kept before the current one (RAW_RETENTION_MONTHS); older monthly
   * partitions are dropped. 0 keeps everything.
   */
  retentionMonths: number;
}

export interface PartitionMaintenance {
  created: number;
  dropped: number;
  /** Old rows deleted from the default partitions (rows outside every monthly partition). */
  defaultDeleted: number;
}

/** The first instant of the UTC month `offset` months from the one holding `now`. */
export function monthStart(now: number, offset: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}

/**
 * Keeps the raw tables' partitions in step (ADR 039): creates the current month's and the next
 * `aheadMonths` (moving any rows the default partition holds for them), drops monthly partitions
 * older than `retentionMonths` before the current month, and deletes default-partition rows older
 * than that cutoff in batches.
 */
export async function maintainPartitions(
  db: Db,
  now: number,
  settings: PartitionSettings,
  batchSize = 1_000,
): Promise<PartitionMaintenance> {
  const result: PartitionMaintenance = { created: 0, dropped: 0, defaultDeleted: 0 };
  if (!settings.enabled) return result;
  for (const [table, key] of RAW_TABLES) {
    for (let k = 0; k <= settings.aheadMonths; k++) {
      const created = await sql<{ created: boolean }>`
        SELECT gw_create_month_partition(${table}, ${key}, ${monthStart(now, k)}) AS created`.execute(
        db,
      );
      if (created.rows[0]?.created) result.created++;
    }
    if (settings.retentionMonths <= 0) continue;
    const cutoff = monthStart(now, -settings.retentionMonths);
    const dropped = await sql<{ dropped: number }>`
      SELECT gw_drop_month_partitions(${table}, ${cutoff}) AS dropped`.execute(db);
    result.dropped += Number(dropped.rows[0]?.dropped ?? 0);
    const fallback = sql.table(`${table}_default`);
    for (;;) {
      const deleted = await sql`
        DELETE FROM ${fallback}
         WHERE ctid IN (SELECT ctid FROM ${fallback} WHERE ${sql.ref(key)} < ${cutoff} LIMIT ${batchSize})`.execute(
        db,
      );
      const n = Number(deleted.numAffectedRows ?? 0n);
      result.defaultDeleted += n;
      if (n < batchSize) break;
    }
  }
  return result;
}
