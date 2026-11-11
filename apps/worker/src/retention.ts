import type { Db } from '@ai-gateway/shared/node';
import { sql } from 'kysely';
import { monthStart, type PartitionSettings } from './partitions.js';

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

/**
 * Deletes expired semantic cache entries (ADR 040) in batches; returns how many. Expiry is set by
 * the gateway from each project's TTL, and lookups already skip expired rows, so this only frees
 * the space. Does nothing where pgvector was missing and migration 0018 created no table.
 */
export async function pruneSemanticCache(db: Db, now: number, batchSize = 1_000): Promise<number> {
  const { rows } = await sql<{ ok: boolean }>`
    SELECT to_regclass('semantic_cache_entries') IS NOT NULL AS ok`.execute(db);
  if (rows[0]?.ok !== true) return 0;
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM semantic_cache_entries
       WHERE id IN (
         SELECT id FROM semantic_cache_entries
          WHERE expires_at <= ${new Date(now)}
          ORDER BY expires_at
          LIMIT ${batchSize}
       )`.execute(db);
    const n = Number(result.numAffectedRows ?? 0n);
    deleted += n;
    if (n < batchSize) return deleted;
  }
}

/**
 * Deletes guardrail findings (migration 0016, ADR 035) older than the raw rows' cutoff (ADR 039):
 * the start of the month RAW_RETENTION_MONTHS before the current one, where the raw partitions
 * are dropped, so findings go with the requests they describe (both are keyed by the request's
 * start). In batches like the other retention deletes; nothing when partitions are off
 * (RAW_PARTITIONS_ENABLED) or RAW_RETENTION_MONTHS is 0, as for the raw tables. Returns how many
 * rows were deleted.
 */
export async function pruneGuardrailResults(
  db: Db,
  now: number,
  settings: PartitionSettings,
  batchSize = 1_000,
): Promise<number> {
  if (!settings.enabled || settings.retentionMonths <= 0) return 0;
  const cutoff = monthStart(now, -settings.retentionMonths);
  let deleted = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM guardrail_results
       WHERE id IN (
         SELECT id FROM guardrail_results WHERE created_at < ${cutoff} LIMIT ${batchSize}
       )`.execute(db);
    const n = Number(result.numAffectedRows ?? 0n);
    deleted += n;
    if (n < batchSize) return deleted;
  }
}
