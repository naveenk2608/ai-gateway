import type { Clock } from '@ai-gateway/shared';
import { enqueueAlert, type Db, type Logger } from '@ai-gateway/shared/node';

/** Shares of the monthly budget that alert once each per month (M15, ADR 033). */
export const BUDGET_THRESHOLDS = [50, 80, 100] as const;

/** One project's budget period after a batch added spend to it. */
export interface PeriodSpend {
  projectId: string;
  /** `YYYY-MM`. */
  period: string;
  before: number;
  after: number;
  limit: number | null;
}

/** The thresholds a change of spend from `before` to `after` crossed (none without a limit). */
export function crossedThresholds(before: number, after: number, limit: number | null): number[] {
  if (limit === null || limit <= 0) return [];
  return BUDGET_THRESHOLDS.filter((t) => before * 100 < t * limit && after * 100 >= t * limit);
}

/**
 * Queues a budget alert for each threshold a project's monthly spend crossed, in the worker's
 * ingest transaction (where the spend is added), deduplicated per project, month and threshold so
 * each alerts once a month even if spend is counted again. Goes to that project's destinations.
 */
export async function queueBudgetAlerts(
  trx: Db,
  periods: PeriodSpend[],
  now: number,
): Promise<void> {
  const crossings = periods.flatMap((p) =>
    crossedThresholds(p.before, p.after, p.limit).map((t) => ({ ...p, threshold: t })),
  );
  if (crossings.length === 0) return;
  const names = new Map(
    (
      await trx
        .selectFrom('projects')
        .select(['id', 'name'])
        .where(
          'id',
          'in',
          crossings.map((c) => c.projectId),
        )
        .execute()
    ).map((p) => [p.id, p.name]),
  );
  for (const c of crossings) {
    await enqueueAlert(trx, {
      projectId: c.projectId,
      type: 'budget.threshold',
      dedupeKey: `budget:${c.period}:${c.threshold}`,
      payload: {
        projectId: c.projectId,
        projectName: names.get(c.projectId) ?? '',
        period: c.period,
        thresholdPct: c.threshold,
        spentMicroUsd: c.after,
        limitMicroUsd: c.limit,
      },
      occurredAt: now,
    });
  }
}

/**
 * Queues a "dead letters growing" alert when usage events are dead-lettered, at most once per
 * `intervalMs` (ALERTS_DEAD_LETTER_INTERVAL_MS) across workers: the dedupe key is the interval's
 * number. It goes to every destination that chose `dead_letters`. Never throws.
 */
export class DeadLetterAlerts {
  readonly #o: { db: Db; clock: Clock; logger: Logger; intervalMs: number };
  #lastWindow = -1;

  constructor(options: { db: Db; clock: Clock; logger: Logger; intervalMs: number }) {
    this.#o = options;
  }

  async deadLettered(): Promise<void> {
    const now = this.#o.clock.now();
    const window = Math.floor(now / this.#o.intervalMs);
    if (window === this.#lastWindow) return;
    this.#lastWindow = window;
    try {
      const since = new Date(now - this.#o.intervalMs);
      const row = await this.#o.db
        .selectFrom('failed_events')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('failed_at', '>=', since)
        .executeTakeFirst();
      await enqueueAlert(this.#o.db, {
        projectId: null,
        type: 'dead_letters.growing',
        dedupeKey: `dead_letters:${window}`,
        payload: {
          count: Number(row?.n ?? 1),
          windowMinutes: Math.round(this.#o.intervalMs / 60_000),
        },
        occurredAt: now,
      });
    } catch (err) {
      this.#o.logger.warn({ err }, 'dead-letter alert could not be queued');
    }
  }
}
