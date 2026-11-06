-- Up Migration

-- List prices of the embedding models the default models file uses (M13), in micro-dollars per
-- million tokens. Embedding models are priced on input only, so the output price is 0. Free-tier
-- deployments are billed nothing and keep this as their list cost (ADR 024). New rows only:
-- prices are never edited (ADR 016).
INSERT INTO model_prices
  (id, provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
VALUES
  -- Gemini Embedding (gemini-embedding-001), paid tier, text input: $0.15 per 1M tokens (free of
  -- charge on the free tier). Checked 2026-11-06: https://aistudio.google.com/docs/pricing
  (gen_random_uuid(), 'gemini', 'gemini-embedding-001', 150000, 0, '2026-11-06T00:00:00Z'),
  -- Mistral Embed (mistral-embed, model ID mistral-embed-2312): $0.1 per 1M tokens.
  -- Checked 2026-11-06: https://docs.mistral.ai/models/mistral-embed-23-12
  (gen_random_uuid(), 'mistral', 'mistral-embed', 100000, 0, '2026-11-06T00:00:00Z'),
  -- Cloudflare Workers AI @cf/baai/bge-large-en-v1.5: $0.204 per 1M input tokens (18,582 Neurons),
  -- beyond the free 10,000 Neurons a day. Checked 2026-11-06:
  -- https://developers.cloudflare.com/workers-ai/platform/pricing/
  (gen_random_uuid(), 'cloudflare', '@cf/baai/bge-large-en-v1.5', 204000, 0, '2026-11-06T00:00:00Z')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- Down Migration

DELETE FROM model_prices
WHERE effective_from = '2026-11-06T00:00:00Z'
  AND (provider, model) IN (
    ('gemini', 'gemini-embedding-001'),
    ('mistral', 'mistral-embed'),
    ('cloudflare', '@cf/baai/bge-large-en-v1.5')
  )
  AND id NOT IN (SELECT price_id FROM usage_events WHERE price_id IS NOT NULL);
