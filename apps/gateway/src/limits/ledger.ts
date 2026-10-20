import type { Db } from '@ai-gateway/shared/node';
import type { SpendLoader } from './limiter.js';

/**
 * A project's recorded spend for a month: the `budget_periods` row the worker keeps in the same
 * transaction as each usage row. The gateway rebuilds its Redis totals from it (ADR 009).
 */
export function databaseSpendLoader(db: Db): SpendLoader {
  return async (projectId, period) => {
    const row = await db
      .selectFrom('budget_periods')
      .select('spent_micro_usd')
      .where('project_id', '=', projectId)
      .where('period_start', '=', new Date(period.start))
      .executeTakeFirst();
    return row?.spent_micro_usd ?? 0;
  };
}
