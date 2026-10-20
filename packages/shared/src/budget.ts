/**
 * Budget periods (ADR 009): calendar months in UTC. The gateway (Redis totals) and the worker
 * (`budget_periods` rows) assign a request to the period in which it started, so both sides agree.
 */
export interface BudgetPeriod {
  /** `YYYY-MM`, used in Redis keys. */
  key: string;
  /** Start of the month, milliseconds since the epoch (inclusive). */
  start: number;
  /** Start of the next month (exclusive). */
  end: number;
}

/** The period a `YYYY-MM` key names. */
export function budgetPeriodOf(key: string): BudgetPeriod {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) throw new RangeError(`not a budget period: ${key}`);
  return budgetPeriodAt(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
}

export function budgetPeriodAt(at: number): BudgetPeriod {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, '0')}`,
    start: Date.UTC(year, month, 1),
    end: Date.UTC(year, month + 1, 1),
  };
}
