-- Up Migration

-- Prices and usage are keyed by the provider's name (groq, gemini, ...) instead of the adapter kind
-- (openai-compatible), so two OpenAI-compatible providers serving the same model name keep separate
-- prices. Only the default Groq and Gemini deployments existed before; their rows are relabelled.
-- Every id, price value, stored cost and price_id stays exactly as it was (ADR 016).

-- Price rows are immutable (ADR 016); renaming the provider of the three seeded rows is the one
-- exception, done with the trigger off for these statements only. Their values do not change.
ALTER TABLE model_prices DISABLE TRIGGER model_prices_immutable;
UPDATE model_prices p
SET provider = CASE p.model WHEN 'gemini-3.5-flash-lite' THEN 'gemini' ELSE 'groq' END
WHERE p.provider = 'openai-compatible'
  AND p.model IN ('openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND NOT EXISTS (
    SELECT 1 FROM model_prices x
    WHERE x.provider = CASE p.model WHEN 'gemini-3.5-flash-lite' THEN 'gemini' ELSE 'groq' END
      AND x.model = p.model AND x.effective_from = p.effective_from
  );
ALTER TABLE model_prices ENABLE TRIGGER model_prices_immutable;

-- The provider that served each past request and attempt, by the default deployment ids.
CREATE TEMPORARY TABLE m11_provider_names (deployment text PRIMARY KEY, provider text NOT NULL)
  ON COMMIT DROP;
INSERT INTO m11_provider_names VALUES
  ('groq-gpt-oss-20b', 'groq'),
  ('groq-qwen3.8-27b', 'groq'),
  ('gemini-3.5-flash-lite', 'gemini');

UPDATE usage_events u SET provider = n.provider
FROM m11_provider_names n
WHERE u.provider = 'openai-compatible' AND u.deployment = n.deployment;

UPDATE provider_attempts a SET provider = n.provider
FROM m11_provider_names n
WHERE a.provider = 'openai-compatible' AND a.deployment = n.deployment;

-- Rollup rows are unique per (project, bucket, key, model, deployment, provider, status, error);
-- a row is relabelled only if no row already holds its new key.
UPDATE usage_rollups_minute r SET provider = n.provider
FROM m11_provider_names n
WHERE r.provider = 'openai-compatible' AND r.deployment = n.deployment
  AND NOT EXISTS (
    SELECT 1 FROM usage_rollups_minute x
    WHERE x.project_id = r.project_id AND x.bucket_start = r.bucket_start
      AND x.api_key_id IS NOT DISTINCT FROM r.api_key_id AND x.model = r.model
      AND x.deployment = r.deployment AND x.provider = n.provider AND x.status = r.status
      AND x.error_code IS NOT DISTINCT FROM r.error_code
  );
UPDATE usage_rollups_hour r SET provider = n.provider
FROM m11_provider_names n
WHERE r.provider = 'openai-compatible' AND r.deployment = n.deployment
  AND NOT EXISTS (
    SELECT 1 FROM usage_rollups_hour x
    WHERE x.project_id = r.project_id AND x.bucket_start = r.bucket_start
      AND x.api_key_id IS NOT DISTINCT FROM r.api_key_id AND x.model = r.model
      AND x.deployment = r.deployment AND x.provider = n.provider AND x.status = r.status
      AND x.error_code IS NOT DISTINCT FROM r.error_code
  );
UPDATE usage_rollups_day r SET provider = n.provider
FROM m11_provider_names n
WHERE r.provider = 'openai-compatible' AND r.deployment = n.deployment
  AND NOT EXISTS (
    SELECT 1 FROM usage_rollups_day x
    WHERE x.project_id = r.project_id AND x.bucket_start = r.bucket_start
      AND x.api_key_id IS NOT DISTINCT FROM r.api_key_id AND x.model = r.model
      AND x.deployment = r.deployment AND x.provider = n.provider AND x.status = r.status
      AND x.error_code IS NOT DISTINCT FROM r.error_code
  );

-- Down Migration

ALTER TABLE model_prices DISABLE TRIGGER model_prices_immutable;
UPDATE model_prices SET provider = 'openai-compatible'
WHERE (provider = 'groq' AND model IN ('openai/gpt-oss-20b', 'qwen/qwen3.8-27b'))
   OR (provider = 'gemini' AND model = 'gemini-3.5-flash-lite');
ALTER TABLE model_prices ENABLE TRIGGER model_prices_immutable;

UPDATE usage_events SET provider = 'openai-compatible'
WHERE deployment IN ('groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND provider IN ('groq', 'gemini');
UPDATE provider_attempts SET provider = 'openai-compatible'
WHERE deployment IN ('groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND provider IN ('groq', 'gemini');
UPDATE usage_rollups_minute SET provider = 'openai-compatible'
WHERE deployment IN ('groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND provider IN ('groq', 'gemini');
UPDATE usage_rollups_hour SET provider = 'openai-compatible'
WHERE deployment IN ('groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND provider IN ('groq', 'gemini');
UPDATE usage_rollups_day SET provider = 'openai-compatible'
WHERE deployment IN ('groq-gpt-oss-20b', 'groq-qwen3.8-27b', 'gemini-3.5-flash-lite')
  AND provider IN ('groq', 'gemini');
