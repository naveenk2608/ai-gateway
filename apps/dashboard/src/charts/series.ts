/** Per-interval values derived from the analytics API's series, for sparklines. */

/**
 * The error rate of each interval: failed over admitted (requests minus rejected), the definition
 * the API uses for `totals.errorRate`. An interval that admitted nothing has no rate: it is null,
 * so its sparkline shows a gap rather than a 0% it never measured.
 */
export function errorRates(
  series: readonly { requests: number; failed: number; rejected: number }[],
): (number | null)[] {
  return series.map(({ requests, failed, rejected }) => {
    const admitted = requests - rejected;
    return admitted > 0 ? failed / admitted : null;
  });
}

export interface Share {
  key: string;
  label: string;
  value: number;
  /** The slice that stands for everything not shown on its own. */
  other?: boolean;
}

/**
 * The largest parts of a total, at most `max` slices: when there are more parts, or the parts do
 * not add up to the total (a breakdown the API cut short), the smallest ones fold into one
 * "Other" slice holding the rest of the total. Parts worth nothing draw nothing and are dropped.
 */
export function foldShares(parts: readonly Share[], total: number, max: number): Share[] {
  const sum = (xs: readonly Share[]) => xs.reduce((s, p) => s + p.value, 0);
  const sorted = parts.filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= max && total - sum(sorted) <= 0) return sorted;
  const kept = sorted.slice(0, max - 1);
  const rest = total - sum(kept);
  return rest > 0 ? [...kept, { key: 'other', label: 'Other', value: rest, other: true }] : kept;
}

/** A share of admitted requests (requests minus rejected); null when nothing was admitted. */
export function shareOfAdmitted(
  part: number,
  totals: { requests: number; rejected: number },
): number | null {
  const admitted = totals.requests - totals.rejected;
  return admitted > 0 ? part / admitted : null;
}
