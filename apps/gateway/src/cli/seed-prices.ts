/**
 * The `model_prices` rows `pnpm db:seed` adds (ADR 016): prices per million tokens in
 * micro-dollars, keyed like cost rows by the provider name and the provider's model name from
 * config/models.json. Real providers' list prices are inserted by migrations
 * (db/migrations/0006_provider-prices.sql), so every database has them.
 */
export const SEED_PRICES = [
  // Demo prices so local requests show a cost. Illustrative values, not any provider's prices.
  {
    provider: 'mock',
    model: 'mock',
    input_micro_usd_per_mtok: 1_000_000,
    output_micro_usd_per_mtok: 2_000_000,
    effective_from: new Date(0),
  },
  // The mock embeddings model: input only, as embedding prices are. Illustrative too.
  {
    provider: 'mock',
    model: 'mock-embed',
    input_micro_usd_per_mtok: 100_000,
    output_micro_usd_per_mtok: 0,
    effective_from: new Date(0),
  },
];

const usd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(2)}`;

/** What `pnpm db:seed` prints about prices: the rows it adds, and where the real ones come from. */
export function seedPricesLine(prices: readonly (typeof SEED_PRICES)[number][] = SEED_PRICES) {
  const rows = prices.map((p) =>
    p.output_micro_usd_per_mtok > 0
      ? `${p.model} (${usd(p.input_micro_usd_per_mtok)} / ${usd(p.output_micro_usd_per_mtok)} per million tokens)`
      : `${p.model} (${usd(p.input_micro_usd_per_mtok)} per million input tokens)`,
  );
  return `Prices:   ${rows.join(', ')}, demo values for the mock provider; real providers' prices come from the migrations`;
}
