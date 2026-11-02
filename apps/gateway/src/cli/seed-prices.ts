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
];
