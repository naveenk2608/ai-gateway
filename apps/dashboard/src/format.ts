const MICRO = 1_000_000;

/** Micro-dollars as dollars: cents for amounts of a cent or more, six places below that. */
export function formatUsd(microUsd: number | null): string {
  if (microUsd === null) return '—';
  if (microUsd === 0) return '$0.00';
  const dollars = microUsd / MICRO;
  return Math.abs(microUsd) < 10_000 ? `$${dollars.toFixed(6)}` : `$${dollars.toFixed(2)}`;
}

export function formatCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US');
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** A timestamp in the viewer's time zone, to the second. */
export function formatTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Spend as a share of a budget, e.g. "12%"; null when there is no budget. */
export function budgetShare(spentMicroUsd: number, budgetMicroUsd: number | null): string | null {
  if (budgetMicroUsd === null) return null;
  if (budgetMicroUsd === 0) return spentMicroUsd > 0 ? 'over budget' : '0%';
  return `${Math.floor((spentMicroUsd / budgetMicroUsd) * 100)}%`;
}
