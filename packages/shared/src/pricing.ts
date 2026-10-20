/** One version of a model's price (ADR 016), in micro-dollars per million tokens. */
export interface PriceVersion {
  id: string;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  /** Milliseconds since the epoch. */
  effectiveFrom: number;
}

const PER_MILLION = 1_000_000;

/**
 * Cost of one request in integer micro-dollars, rounded up so fractions of a micro-dollar are
 * never lost in our favour. Integer arithmetic throughout: no floating-point money.
 */
export function costMicroUsd(
  promptTokens: number,
  completionTokens: number,
  price: Pick<PriceVersion, 'inputMicroUsdPerMTok' | 'outputMicroUsdPerMTok'>,
): number {
  const scaled =
    BigInt(promptTokens) * BigInt(price.inputMicroUsdPerMTok) +
    BigInt(completionTokens) * BigInt(price.outputMicroUsdPerMTok);
  const million = BigInt(PER_MILLION);
  const cost = (scaled + million - 1n) / million;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('cost exceeds safe range');
  return Number(cost);
}

/** The version in effect at `at`: the latest one whose effective_from is not after it. */
export function priceAt<T extends Pick<PriceVersion, 'effectiveFrom'>>(
  versions: readonly T[],
  at: number,
): T | undefined {
  let best: T | undefined;
  for (const version of versions) {
    if (version.effectiveFrom > at) continue;
    if (!best || version.effectiveFrom > best.effectiveFrom) best = version;
  }
  return best;
}
