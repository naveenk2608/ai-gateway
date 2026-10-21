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

/** A share of admitted requests (requests minus rejected); null when nothing was admitted. */
export function shareOfAdmitted(
  part: number,
  totals: { requests: number; rejected: number },
): number | null {
  const admitted = totals.requests - totals.rejected;
  return admitted > 0 ? part / admitted : null;
}
