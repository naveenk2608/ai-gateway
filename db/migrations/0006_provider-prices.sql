-- Up Migration

-- List prices of the real-provider deployments in config/models.json (ADR 016), in micro-dollars
-- per million tokens. They are inserted here, not only by `pnpm db:seed`, so hosts that never run
-- the seed (the live demo) cost requests too. A row that already exists (the same provider, model
-- and effective_from) is left alone. Sources and the date each was checked are next to each row;
-- docs/providers.md has the same table. Free endpoints with no price of their own use the model
-- maker's paid API price, or else OpenRouter's paid listing of the same model (ADR 024).
INSERT INTO model_prices
  (id, provider, model, input_micro_usd_per_mtok, output_micro_usd_per_mtok, effective_from)
VALUES
  -- Groq, $0.075 / $0.30. Checked 2026-10-21: https://console.groq.com/docs/model/openai/gpt-oss-20b
  (gen_random_uuid(), 'groq', 'openai/gpt-oss-20b', 75000, 300000, '2026-10-21T00:00:00Z'),
  -- Groq (preview model), $0.80 / $4.00. Checked 2026-10-28: https://console.groq.com/docs/models
  (gen_random_uuid(), 'groq', 'qwen/qwen3.8-27b', 800000, 4000000, '2026-10-28T00:00:00Z'),
  -- Groq, $0.15 / $0.60. Checked 2026-11-03:
  -- https://console.groq.com/docs/model/openai/gpt-oss-120b
  (gen_random_uuid(), 'groq', 'openai/gpt-oss-120b', 150000, 600000, '2026-11-03T00:00:00Z'),
  -- Gemini API paid tier, text: $0.30 / $2.50. Checked 2026-10-21:
  -- https://ai.google.dev/gemini-api/docs/pricing
  (gen_random_uuid(), 'gemini', 'gemini-3.5-flash-lite', 300000, 2500000, '2026-10-21T00:00:00Z'),
  -- Gemini API paid tier, standard: $0.75 / $3.75 through 2026-12-31 (the page announces $1.50 /
  -- $7.50 from 2027-01-01; that row is not added yet). Checked 2026-11-03:
  -- https://aistudio.google.com/docs/pricing
  (gen_random_uuid(), 'gemini', 'gemini-3.8-flash', 750000, 3750000, '2026-11-03T00:00:00Z'),
  -- Gemini API paid tier, standard, text/image/video input: $0.25 / $1.50. Checked 2026-11-03:
  -- https://aistudio.google.com/docs/pricing
  (gen_random_uuid(), 'gemini', 'gemini-3.1-flash-lite', 250000, 1500000, '2026-11-03T00:00:00Z'),
  -- Mistral Small 4 (mistral-small-2603), $0.15 / $0.60. Checked 2026-11-03:
  -- https://docs.mistral.ai/models/mistral-small-4-0-26-03
  (gen_random_uuid(), 'mistral', 'mistral-small-2603', 150000, 600000, '2026-11-03T00:00:00Z'),
  -- Mistral Large 4 (public preview), $0.70 / $2.10. Checked 2026-11-03:
  -- https://docs.mistral.ai/models/mistral-large-4-0
  (gen_random_uuid(), 'mistral', 'mistral-large-4', 700000, 2100000, '2026-11-03T00:00:00Z'),
  -- NVIDIA's endpoint is free and has no per-token price. List price: DeepSeek's own API for the
  -- same model (deepseek-flash, DeepSeek-V4.1-Flash-1017), standard (peak) rate, cache-miss input
  -- $0.30 / output $1.20. Checked 2026-11-03: https://api-docs.deepseek.com/quick_start/pricing
  (gen_random_uuid(), 'nvidia', 'deepseek-ai/deepseek-v4.1-flash', 300000, 1200000, '2026-11-03T00:00:00Z'),
  -- NVIDIA's endpoint is free and NVIDIA sells no per-token API for it. List price: OpenRouter's
  -- paid nvidia/nemotron-3-super-120b-a12b, $0.30 / $2.40. Checked 2026-11-03:
  -- https://openrouter.ai/api/v1/models
  (gen_random_uuid(), 'nvidia', 'nvidia/nemotron-3-super-120b-a12b', 300000, 2400000, '2026-11-03T00:00:00Z'),
  -- OpenRouter's :free variant costs nothing. List price: its paid google/gemma-4-31b-it,
  -- $0.20 / $0.40 (Google's Gemini API offers Gemma 4 free only). Checked 2026-11-03:
  -- https://openrouter.ai/api/v1/models
  (gen_random_uuid(), 'openrouter', 'google/gemma-4-31b-it:free', 200000, 400000, '2026-11-03T00:00:00Z'),
  -- Cloudflare Workers AI, beyond the free 10,000 Neurons a day: $0.270 / $0.850. Checked
  -- 2026-11-03 (page updated 2026-10-20): https://developers.cloudflare.com/workers-ai/platform/pricing/
  (gen_random_uuid(), 'cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 270000, 850000, '2026-11-03T00:00:00Z'),
  -- Z.AI offers GLM-4.7-Flash free only (https://docs.z.ai/guides/overview/pricing). List price:
  -- OpenRouter's paid z-ai/glm-4.7-flash, $0.0605 / $0.40. Checked 2026-11-03:
  -- https://openrouter.ai/api/v1/models
  (gen_random_uuid(), 'zai', 'glm-4.7-flash', 60500, 400000, '2026-11-03T00:00:00Z')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- Down Migration

-- Price rows may already be referenced by usage rows (price_id), so they are kept.
SELECT 1;
