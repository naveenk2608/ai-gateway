import { budgetPeriodOf, uuidv7, type Clock } from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';
import type { ExpiredReservation, Limiter, SpendLoader } from './limiter.js';

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

/**
 * Audits reservations the sweeper released as `expired`. If the request finishes after all, the
 * worker turns the row into `reconciled` with its actual cost.
 */
export async function recordExpiredReservations(
  db: Db,
  expired: readonly ExpiredReservation[],
  at: Date,
): Promise<void> {
  if (expired.length === 0) return;
  await db.transaction().execute(async (trx) => {
    const keys = [...new Set(expired.map((e) => `${e.projectId}|${e.period}`))].sort();
    const periods = await trx
      .insertInto('budget_periods')
      .values(
        keys.map((key) => {
          const [projectId, periodKey] = key.split('|') as [string, string];
          const period = budgetPeriodOf(periodKey);
          return {
            id: uuidv7(),
            project_id: projectId,
            period_start: new Date(period.start),
            period_end: new Date(period.end),
            limit_micro_usd: null,
          };
        }),
      )
      .onConflict((oc) =>
        oc
          .columns(['project_id', 'period_start'])
          .doUpdateSet((eb) => ({ updated_at: eb.ref('budget_periods.updated_at') })),
      )
      .returning(['id', 'project_id', 'period_start'])
      .execute();
    const ids = new Map(periods.map((p) => [`${p.project_id}|${p.period_start.getTime()}`, p.id]));
    await trx
      .insertInto('budget_reservations')
      .values(
        expired.flatMap((e) => {
          const id = ids.get(`${e.projectId}|${budgetPeriodOf(e.period).start}`);
          if (!id) return [];
          return [
            {
              id: uuidv7(),
              budget_period_id: id,
              project_id: e.projectId,
              request_id: e.requestId,
              reserved_micro_usd: e.amountMicroUsd,
              actual_micro_usd: null,
              status: 'expired' as const,
              settled_at: at,
            },
          ];
        }),
      )
      .onConflict((oc) => oc.column('request_id').doNothing())
      .execute();
  });
}

export interface SweeperOptions {
  limiter: Pick<Limiter, 'sweep'>;
  db: Db;
  clock: Clock;
  logger: Logger;
  intervalMs: number;
}

/**
 * Releases budget reservations whose request stopped renewing them (its gateway crashed), so
 * they do not hold the budget until the month ends, and records each as expired. Every instance
 * runs one; the Lua script hands each reservation to exactly one of them.
 */
export class ReservationSweeper {
  readonly #o: SweeperOptions;
  readonly #stop = new AbortController();
  #running: Promise<void> | undefined;

  constructor(options: SweeperOptions) {
    this.#o = options;
  }

  start(): void {
    this.#running = (async () => {
      while (!this.#stop.signal.aborted) {
        try {
          await this.#o.clock.sleep(this.#o.intervalMs, this.#stop.signal);
        } catch {
          return;
        }
        await this.sweepOnce().catch((err: unknown) => {
          this.#o.logger.warn({ err }, 'budget reservation sweep failed');
        });
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#running;
  }

  /** Releases and records expired reservations; returns how many. */
  async sweepOnce(): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await this.#o.limiter.sweep(100);
      if (expired.length === 0) break;
      total += expired.length;
      try {
        await recordExpiredReservations(this.#o.db, expired, new Date(this.#o.clock.now()));
      } catch (err) {
        // Redis has already released them; only the audit rows are missing.
        this.#o.logger.error({ err, expired }, 'could not record expired budget reservations');
      }
      if (expired.length < 100) break;
    }
    if (total > 0) this.#o.logger.info({ expired: total }, 'expired budget reservations released');
    return total;
  }
}
