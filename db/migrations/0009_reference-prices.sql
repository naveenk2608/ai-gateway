-- Up Migration

-- Reference prices (M11): official prices of paid models that no deployment calls, kept only to
-- show what the project's usage would cost elsewhere (GET /admin/analytics/cost-comparison). The
-- gateway's price book and the worker never read them, so they can never price or route a request.
-- Adding the column fires no UPDATE trigger: existing rows stay as they are (ADR 016).
ALTER TABLE model_prices ADD COLUMN reference boolean NOT NULL DEFAULT false;

INSERT INTO model_prices
  (id, provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from, reference)
VALUES
  -- Gemini 3.1 Pro Preview, paid tier, prompts up to 200k tokens: $2.00 / $12.00. Not on the free
  -- tier. Checked 2026-11-03: https://aistudio.google.com/docs/pricing
  (gen_random_uuid(), 'gemini', 'gemini-3.1-pro-preview', 2000000, 12000000, '2026-11-03T00:00:00Z', true),
  -- DeepSeek V4 Pro on DeepSeek's API, standard (peak) rate, cache-miss input $1.32 / output
  -- $3.96. Checked 2026-11-03: https://api-docs.deepseek.com/quick_start/pricing
  (gen_random_uuid(), 'deepseek', 'deepseek-v4-pro', 1320000, 3960000, '2026-11-03T00:00:00Z', true),
  -- Z.AI GLM-4.7: $0.60 / $2.20. Checked 2026-11-03: https://docs.z.ai/guides/overview/pricing
  (gen_random_uuid(), 'zai', 'glm-4.7', 600000, 2200000, '2026-11-03T00:00:00Z', true)
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- Down Migration

DELETE FROM model_prices
WHERE reference AND id NOT IN (SELECT price_id FROM usage_events WHERE price_id IS NOT NULL);
ALTER TABLE model_prices DROP COLUMN reference;
