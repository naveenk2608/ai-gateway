import { formatCount, formatUsd } from '../format.js';

/**
 * Spend as the API reports it (ADR 024): the list cost (tokens at each model's price), what the
 * providers bill (0 on free tiers), the saving, and requests whose model has no list price.
 */
export interface CostFigures {
  costMicroUsd: number;
  billedCostMicroUsd?: number;
  savedMicroUsd?: number;
  unpricedRequests?: number;
}

/**
 * The list cost, or "no list price" when every request with usage had a model without a price:
 * an unknown list cost is never shown as $0.
 */
export function listCostText(c: CostFigures): string {
  const unpriced = c.unpricedRequests ?? 0;
  if (c.costMicroUsd === 0 && unpriced > 0) return 'no list price';
  return formatUsd(c.costMicroUsd);
}

/** "billed $0.00 · saved $0.18", plus how many requests had no list price. */
export function billedNote(c: CostFigures): string | undefined {
  if (c.billedCostMicroUsd === undefined) return undefined;
  const parts = [`billed ${formatUsd(c.billedCostMicroUsd)}`];
  if (c.savedMicroUsd !== undefined) parts.push(`saved ${formatUsd(c.savedMicroUsd)}`);
  const unpriced = c.unpricedRequests ?? 0;
  if (unpriced > 0) parts.push(`${formatCount(unpriced)} with no list price`);
  return parts.join(' · ');
}
