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

/** A share (0..1) as a percentage with one decimal; null as a dash. */
export function formatPercent(share: number | null): string {
  if (share === null) return '—';
  return `${(share * 100).toFixed(1)}%`;
}

/** A series point's start, short enough for a chart axis: time for ranges within a day. */
export function formatAxisTime(iso: string, stepSeconds: number, locale?: string): string {
  const date = new Date(iso);
  return stepSeconds >= 86_400
    ? date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
    : stepSeconds >= 3_600
      ? date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit' })
      : date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** A duration in ms as the largest sensible unit, e.g. "4 s", "3 min". */
export function formatAge(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** A dollar amount typed by a user as micro-dollars; null for an empty field, NaN if invalid. */
export function parseUsd(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, '');
  if (trimmed === '') return null;
  if (!/^\d+(\.\d{0,6})?$/.test(trimmed)) return Number.NaN;
  return Math.round(Number(trimmed) * MICRO);
}

/** Micro-dollars as a plain dollar amount for an input field. */
export function usdInput(microUsd: number | null): string {
  return microUsd === null ? '' : String(microUsd / MICRO);
}
