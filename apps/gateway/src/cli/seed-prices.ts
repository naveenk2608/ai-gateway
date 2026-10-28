/**
 * The `model_prices` rows `pnpm db:seed` adds (ADR 016): prices per million tokens in
 * micro-dollars, keyed like cost rows by the provider kind and the provider's model name from
 * config/models.json.
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
  // Groq, openai/gpt-oss-20b: $0.075 input, $0.30 output per 1M tokens. Checked 2026-10-21 on
  // https://console.groq.com/docs/models and https://console.groq.com/docs/model/openai/gpt-oss-20b
  {
    provider: 'openai-compatible',
    model: 'openai/gpt-oss-20b',
    input_micro_usd_per_mtok: 75_000,
    output_micro_usd_per_mtok: 300_000,
    effective_from: new Date('2026-10-21T00:00:00Z'),
  },
  // Groq, qwen/qwen3.8-27b: $0.80 input, $4.00 output per 1M tokens. A preview model on Groq
  // (for evaluation; may be discontinued at short notice). Checked 2026-10-28 on
  // https://console.groq.com/docs/models
  {
    provider: 'openai-compatible',
    model: 'qwen/qwen3.8-27b',
    input_micro_usd_per_mtok: 800_000,
    output_micro_usd_per_mtok: 4_000_000,
    effective_from: new Date('2026-10-28T00:00:00Z'),
  },
  // Google Gemini API, gemini-3.5-flash-lite, paid tier: $0.30 input (text, image, video), $2.50
  // output per 1M tokens. Checked 2026-10-21 on https://ai.google.dev/gemini-api/docs/pricing
  // (page last updated 2026-10-19).
  {
    provider: 'openai-compatible',
    model: 'gemini-3.5-flash-lite',
    input_micro_usd_per_mtok: 300_000,
    output_micro_usd_per_mtok: 2_500_000,
    effective_from: new Date('2026-10-21T00:00:00Z'),
  },
];
