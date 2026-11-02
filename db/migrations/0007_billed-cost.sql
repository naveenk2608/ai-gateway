-- Up Migration

-- List cost versus billed cost (ADR 024). cost_micro_usd stays the list cost: tokens at the model's
-- price (ADR 016). billed_cost_micro_usd is what the provider bills: 0 for a deployment on a free
-- tier, the list cost on a paid one. Both are fixed when the worker ingests the request, from the
-- billing the gateway put on the event, so changing a deployment's billing never alters past rows.
-- Requests before M11 were all costed as paid, so their billed cost is their list cost.
ALTER TABLE usage_events
  ADD COLUMN billed_cost_micro_usd bigint CHECK (billed_cost_micro_usd >= 0),
  ADD COLUMN billing text CHECK (billing IN ('free_tier', 'paid'));
UPDATE usage_events SET billed_cost_micro_usd = cost_micro_usd;

-- Rollups gain the billed cost and the number of requests with usage but no list price, so a
-- model without a price shows "no list price" rather than $0.
ALTER TABLE usage_rollups_minute
  ADD COLUMN billed_cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (billed_cost_micro_usd >= 0),
  ADD COLUMN unpriced_requests bigint NOT NULL DEFAULT 0 CHECK (unpriced_requests >= 0);
ALTER TABLE usage_rollups_hour
  ADD COLUMN billed_cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (billed_cost_micro_usd >= 0),
  ADD COLUMN unpriced_requests bigint NOT NULL DEFAULT 0 CHECK (unpriced_requests >= 0);
ALTER TABLE usage_rollups_day
  ADD COLUMN billed_cost_micro_usd bigint NOT NULL DEFAULT 0 CHECK (billed_cost_micro_usd >= 0),
  ADD COLUMN unpriced_requests bigint NOT NULL DEFAULT 0 CHECK (unpriced_requests >= 0);
UPDATE usage_rollups_minute SET billed_cost_micro_usd = cost_micro_usd;
UPDATE usage_rollups_hour SET billed_cost_micro_usd = cost_micro_usd;
UPDATE usage_rollups_day SET billed_cost_micro_usd = cost_micro_usd;

CREATE OR REPLACE VIEW request_rollup_facts AS
SELECT
  r.id,
  r.started_at,
  r.project_id,
  r.api_key_id,
  r.model,
  r.deployment,
  u.provider,
  r.status,
  r.error_code,
  r.cache_hit,
  coalesce(u.prompt_tokens, 0) AS prompt_tokens,
  coalesce(u.completion_tokens, 0) AS completion_tokens,
  coalesce(u.total_tokens, 0) AS total_tokens,
  coalesce(u.cost_micro_usd, 0) AS cost_micro_usd,
  r.attempt_count,
  coalesce(a.retries, 0) AS retries,
  coalesce(a.fallbacks, 0) AS fallbacks,
  r.latency_ms,
  r.ttft_ms,
  CASE WHEN r.status = 'success' AND u.completion_tokens > 0
    THEN u.completion_tokens ELSE 0 END AS throughput_tokens,
  CASE WHEN r.status = 'success' AND u.completion_tokens > 0
    THEN greatest(0, r.latency_ms - coalesce(r.ttft_ms, 0)) ELSE 0 END AS throughput_ms,
  coalesce(u.billed_cost_micro_usd, 0) AS billed_cost_micro_usd,
  -- A provider answered with known usage, but the model has no price: the list cost is unknown.
  (u.provider IS NOT NULL AND u.usage_source <> 'missing' AND u.cost_micro_usd IS NULL) AS unpriced
FROM request_records r
LEFT JOIN usage_events u ON u.request_id = r.id
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE steps.previous = steps.deployment) AS retries,
    count(*) FILTER (WHERE steps.previous <> steps.deployment) AS fallbacks
  FROM (
    SELECT pa.deployment, lag(pa.deployment) OVER (ORDER BY pa.attempt_number) AS previous
    FROM provider_attempts pa
    WHERE pa.request_id = r.id
  ) steps
) a ON true;

CREATE OR REPLACE FUNCTION rollup_requests(request_ids uuid[]) RETURNS void LANGUAGE sql AS $$
WITH d AS (
  SELECT
    date_trunc('minute', started_at, 'UTC') AS bucket_start,
    project_id, api_key_id, model, deployment, provider, status, error_code,
    count(*) AS requests,
    count(*) FILTER (WHERE cache_hit) AS cache_hits,
    sum(prompt_tokens) AS prompt_tokens,
    sum(completion_tokens) AS completion_tokens,
    sum(total_tokens) AS total_tokens,
    sum(cost_micro_usd) AS cost_micro_usd,
    sum(attempt_count) AS attempts,
    sum(retries) AS retries,
    sum(fallbacks) AS fallbacks,
    sum(latency_ms) AS latency_ms_sum,
    bucket_sum(histogram_one_hot(latency_ms)) AS latency_buckets,
    count(ttft_ms) AS ttft_count,
    coalesce(sum(ttft_ms), 0) AS ttft_ms_sum,
    bucket_sum(histogram_one_hot(ttft_ms)) AS ttft_buckets,
    sum(throughput_tokens) AS throughput_tokens,
    sum(throughput_ms) AS throughput_ms,
    sum(billed_cost_micro_usd) AS billed_cost_micro_usd,
    count(*) FILTER (WHERE unpriced) AS unpriced_requests
  FROM request_rollup_facts
  WHERE id = ANY (request_ids)
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
),
minute AS (
  INSERT INTO usage_rollups_minute AS t
  SELECT bucket_start, project_id, api_key_id, model, deployment, provider, status, error_code,
    requests, cache_hits, prompt_tokens, completion_tokens, total_tokens, cost_micro_usd,
    attempts, retries, fallbacks, latency_ms_sum, latency_buckets, ttft_count, ttft_ms_sum,
    ttft_buckets, throughput_tokens, throughput_ms, billed_cost_micro_usd, unpriced_requests
  FROM d
  ORDER BY project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code
  ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
  DO UPDATE SET
    requests = t.requests + excluded.requests,
    cache_hits = t.cache_hits + excluded.cache_hits,
    prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = t.completion_tokens + excluded.completion_tokens,
    total_tokens = t.total_tokens + excluded.total_tokens,
    cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
    attempts = t.attempts + excluded.attempts,
    retries = t.retries + excluded.retries,
    fallbacks = t.fallbacks + excluded.fallbacks,
    latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
    latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
    ttft_count = t.ttft_count + excluded.ttft_count,
    ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
    ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
    throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
    throughput_ms = t.throughput_ms + excluded.throughput_ms,
    billed_cost_micro_usd = t.billed_cost_micro_usd + excluded.billed_cost_micro_usd,
    unpriced_requests = t.unpriced_requests + excluded.unpriced_requests
),
hour AS (
  INSERT INTO usage_rollups_hour AS t
  SELECT date_trunc('hour', bucket_start, 'UTC'),
    project_id, api_key_id, model, deployment, provider, status, error_code,
    sum(requests), sum(cache_hits), sum(prompt_tokens), sum(completion_tokens), sum(total_tokens),
    sum(cost_micro_usd), sum(attempts), sum(retries), sum(fallbacks), sum(latency_ms_sum),
    bucket_sum(latency_buckets), sum(ttft_count), sum(ttft_ms_sum), bucket_sum(ttft_buckets),
    sum(throughput_tokens), sum(throughput_ms), sum(billed_cost_micro_usd), sum(unpriced_requests)
  FROM d
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ORDER BY project_id, 1, api_key_id, model, deployment, provider, status, error_code
  ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
  DO UPDATE SET
    requests = t.requests + excluded.requests,
    cache_hits = t.cache_hits + excluded.cache_hits,
    prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = t.completion_tokens + excluded.completion_tokens,
    total_tokens = t.total_tokens + excluded.total_tokens,
    cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
    attempts = t.attempts + excluded.attempts,
    retries = t.retries + excluded.retries,
    fallbacks = t.fallbacks + excluded.fallbacks,
    latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
    latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
    ttft_count = t.ttft_count + excluded.ttft_count,
    ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
    ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
    throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
    throughput_ms = t.throughput_ms + excluded.throughput_ms,
    billed_cost_micro_usd = t.billed_cost_micro_usd + excluded.billed_cost_micro_usd,
    unpriced_requests = t.unpriced_requests + excluded.unpriced_requests
)
INSERT INTO usage_rollups_day AS t
SELECT date_trunc('day', bucket_start, 'UTC'),
  project_id, api_key_id, model, deployment, provider, status, error_code,
  sum(requests), sum(cache_hits), sum(prompt_tokens), sum(completion_tokens), sum(total_tokens),
  sum(cost_micro_usd), sum(attempts), sum(retries), sum(fallbacks), sum(latency_ms_sum),
  bucket_sum(latency_buckets), sum(ttft_count), sum(ttft_ms_sum), bucket_sum(ttft_buckets),
  sum(throughput_tokens), sum(throughput_ms), sum(billed_cost_micro_usd), sum(unpriced_requests)
FROM d
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY project_id, 1, api_key_id, model, deployment, provider, status, error_code
ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
DO UPDATE SET
  requests = t.requests + excluded.requests,
  cache_hits = t.cache_hits + excluded.cache_hits,
  prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
  completion_tokens = t.completion_tokens + excluded.completion_tokens,
  total_tokens = t.total_tokens + excluded.total_tokens,
  cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
  attempts = t.attempts + excluded.attempts,
  retries = t.retries + excluded.retries,
  fallbacks = t.fallbacks + excluded.fallbacks,
  latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
  latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
  ttft_count = t.ttft_count + excluded.ttft_count,
  ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
  ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
  throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
  throughput_ms = t.throughput_ms + excluded.throughput_ms,
  billed_cost_micro_usd = t.billed_cost_micro_usd + excluded.billed_cost_micro_usd,
  unpriced_requests = t.unpriced_requests + excluded.unpriced_requests
$$;

-- Unpriced requests already in the rollups.
UPDATE usage_rollups_minute r SET unpriced_requests = f.n
FROM (
  SELECT date_trunc('minute', started_at, 'UTC') AS bucket_start, project_id, api_key_id, model,
    deployment, provider, status, error_code, count(*) AS n
  FROM request_rollup_facts
  WHERE unpriced
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
) f
WHERE r.bucket_start = f.bucket_start AND r.project_id = f.project_id
  AND r.api_key_id IS NOT DISTINCT FROM f.api_key_id AND r.model = f.model
  AND r.deployment IS NOT DISTINCT FROM f.deployment AND r.provider IS NOT DISTINCT FROM f.provider
  AND r.status = f.status AND r.error_code IS NOT DISTINCT FROM f.error_code;
UPDATE usage_rollups_hour r SET unpriced_requests = f.n
FROM (
  SELECT date_trunc('hour', started_at, 'UTC') AS bucket_start, project_id, api_key_id, model,
    deployment, provider, status, error_code, count(*) AS n
  FROM request_rollup_facts
  WHERE unpriced
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
) f
WHERE r.bucket_start = f.bucket_start AND r.project_id = f.project_id
  AND r.api_key_id IS NOT DISTINCT FROM f.api_key_id AND r.model = f.model
  AND r.deployment IS NOT DISTINCT FROM f.deployment AND r.provider IS NOT DISTINCT FROM f.provider
  AND r.status = f.status AND r.error_code IS NOT DISTINCT FROM f.error_code;
UPDATE usage_rollups_day r SET unpriced_requests = f.n
FROM (
  SELECT date_trunc('day', started_at, 'UTC') AS bucket_start, project_id, api_key_id, model,
    deployment, provider, status, error_code, count(*) AS n
  FROM request_rollup_facts
  WHERE unpriced
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
) f
WHERE r.bucket_start = f.bucket_start AND r.project_id = f.project_id
  AND r.api_key_id IS NOT DISTINCT FROM f.api_key_id AND r.model = f.model
  AND r.deployment IS NOT DISTINCT FROM f.deployment AND r.provider IS NOT DISTINCT FROM f.provider
  AND r.status = f.status AND r.error_code IS NOT DISTINCT FROM f.error_code;

-- Down Migration

DROP FUNCTION rollup_requests(uuid[]);
DROP VIEW request_rollup_facts;
-- One row per request with the values the rollups sum.
CREATE VIEW request_rollup_facts AS
SELECT
  r.id,
  r.started_at,
  r.project_id,
  r.api_key_id,
  r.model,
  r.deployment,
  u.provider,
  r.status,
  r.error_code,
  r.cache_hit,
  coalesce(u.prompt_tokens, 0) AS prompt_tokens,
  coalesce(u.completion_tokens, 0) AS completion_tokens,
  coalesce(u.total_tokens, 0) AS total_tokens,
  coalesce(u.cost_micro_usd, 0) AS cost_micro_usd,
  r.attempt_count,
  coalesce(a.retries, 0) AS retries,
  coalesce(a.fallbacks, 0) AS fallbacks,
  r.latency_ms,
  r.ttft_ms,
  CASE WHEN r.status = 'success' AND u.completion_tokens > 0
    THEN u.completion_tokens ELSE 0 END AS throughput_tokens,
  CASE WHEN r.status = 'success' AND u.completion_tokens > 0
    THEN greatest(0, r.latency_ms - coalesce(r.ttft_ms, 0)) ELSE 0 END AS throughput_ms
FROM request_records r
LEFT JOIN usage_events u ON u.request_id = r.id
LEFT JOIN LATERAL (
  SELECT
    count(*) FILTER (WHERE steps.previous = steps.deployment) AS retries,
    count(*) FILTER (WHERE steps.previous <> steps.deployment) AS fallbacks
  FROM (
    SELECT pa.deployment, lag(pa.deployment) OVER (ORDER BY pa.attempt_number) AS previous
    FROM provider_attempts pa
    WHERE pa.request_id = r.id
  ) steps
) a ON true;

-- Adds the given requests to the rollups: per minute from the facts, then per hour and per day
-- from those per-minute deltas. Rows are written in key order so concurrent workers lock them in
-- the same order. Call it only for requests inserted in the same transaction.
CREATE FUNCTION rollup_requests(request_ids uuid[]) RETURNS void LANGUAGE sql AS $$
WITH d AS (
  SELECT
    date_trunc('minute', started_at, 'UTC') AS bucket_start,
    project_id, api_key_id, model, deployment, provider, status, error_code,
    count(*) AS requests,
    count(*) FILTER (WHERE cache_hit) AS cache_hits,
    sum(prompt_tokens) AS prompt_tokens,
    sum(completion_tokens) AS completion_tokens,
    sum(total_tokens) AS total_tokens,
    sum(cost_micro_usd) AS cost_micro_usd,
    sum(attempt_count) AS attempts,
    sum(retries) AS retries,
    sum(fallbacks) AS fallbacks,
    sum(latency_ms) AS latency_ms_sum,
    bucket_sum(histogram_one_hot(latency_ms)) AS latency_buckets,
    count(ttft_ms) AS ttft_count,
    coalesce(sum(ttft_ms), 0) AS ttft_ms_sum,
    bucket_sum(histogram_one_hot(ttft_ms)) AS ttft_buckets,
    sum(throughput_tokens) AS throughput_tokens,
    sum(throughput_ms) AS throughput_ms
  FROM request_rollup_facts
  WHERE id = ANY (request_ids)
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
),
minute AS (
  INSERT INTO usage_rollups_minute AS t
  SELECT bucket_start, project_id, api_key_id, model, deployment, provider, status, error_code,
    requests, cache_hits, prompt_tokens, completion_tokens, total_tokens, cost_micro_usd,
    attempts, retries, fallbacks, latency_ms_sum, latency_buckets, ttft_count, ttft_ms_sum,
    ttft_buckets, throughput_tokens, throughput_ms
  FROM d
  ORDER BY project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code
  ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
  DO UPDATE SET
    requests = t.requests + excluded.requests,
    cache_hits = t.cache_hits + excluded.cache_hits,
    prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = t.completion_tokens + excluded.completion_tokens,
    total_tokens = t.total_tokens + excluded.total_tokens,
    cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
    attempts = t.attempts + excluded.attempts,
    retries = t.retries + excluded.retries,
    fallbacks = t.fallbacks + excluded.fallbacks,
    latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
    latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
    ttft_count = t.ttft_count + excluded.ttft_count,
    ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
    ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
    throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
    throughput_ms = t.throughput_ms + excluded.throughput_ms
),
hour AS (
  INSERT INTO usage_rollups_hour AS t
  SELECT date_trunc('hour', bucket_start, 'UTC'),
    project_id, api_key_id, model, deployment, provider, status, error_code,
    sum(requests), sum(cache_hits), sum(prompt_tokens), sum(completion_tokens), sum(total_tokens),
    sum(cost_micro_usd), sum(attempts), sum(retries), sum(fallbacks), sum(latency_ms_sum),
    bucket_sum(latency_buckets), sum(ttft_count), sum(ttft_ms_sum), bucket_sum(ttft_buckets),
    sum(throughput_tokens), sum(throughput_ms)
  FROM d
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ORDER BY project_id, 1, api_key_id, model, deployment, provider, status, error_code
  ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
  DO UPDATE SET
    requests = t.requests + excluded.requests,
    cache_hits = t.cache_hits + excluded.cache_hits,
    prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
    completion_tokens = t.completion_tokens + excluded.completion_tokens,
    total_tokens = t.total_tokens + excluded.total_tokens,
    cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
    attempts = t.attempts + excluded.attempts,
    retries = t.retries + excluded.retries,
    fallbacks = t.fallbacks + excluded.fallbacks,
    latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
    latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
    ttft_count = t.ttft_count + excluded.ttft_count,
    ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
    ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
    throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
    throughput_ms = t.throughput_ms + excluded.throughput_ms
)
INSERT INTO usage_rollups_day AS t
SELECT date_trunc('day', bucket_start, 'UTC'),
  project_id, api_key_id, model, deployment, provider, status, error_code,
  sum(requests), sum(cache_hits), sum(prompt_tokens), sum(completion_tokens), sum(total_tokens),
  sum(cost_micro_usd), sum(attempts), sum(retries), sum(fallbacks), sum(latency_ms_sum),
  bucket_sum(latency_buckets), sum(ttft_count), sum(ttft_ms_sum), bucket_sum(ttft_buckets),
  sum(throughput_tokens), sum(throughput_ms)
FROM d
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY project_id, 1, api_key_id, model, deployment, provider, status, error_code
ON CONFLICT (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
DO UPDATE SET
  requests = t.requests + excluded.requests,
  cache_hits = t.cache_hits + excluded.cache_hits,
  prompt_tokens = t.prompt_tokens + excluded.prompt_tokens,
  completion_tokens = t.completion_tokens + excluded.completion_tokens,
  total_tokens = t.total_tokens + excluded.total_tokens,
  cost_micro_usd = t.cost_micro_usd + excluded.cost_micro_usd,
  attempts = t.attempts + excluded.attempts,
  retries = t.retries + excluded.retries,
  fallbacks = t.fallbacks + excluded.fallbacks,
  latency_ms_sum = t.latency_ms_sum + excluded.latency_ms_sum,
  latency_buckets = bucket_add(t.latency_buckets, excluded.latency_buckets),
  ttft_count = t.ttft_count + excluded.ttft_count,
  ttft_ms_sum = t.ttft_ms_sum + excluded.ttft_ms_sum,
  ttft_buckets = bucket_add(t.ttft_buckets, excluded.ttft_buckets),
  throughput_tokens = t.throughput_tokens + excluded.throughput_tokens,
  throughput_ms = t.throughput_ms + excluded.throughput_ms
$$;

ALTER TABLE usage_rollups_day DROP COLUMN billed_cost_micro_usd, DROP COLUMN unpriced_requests;
ALTER TABLE usage_rollups_hour DROP COLUMN billed_cost_micro_usd, DROP COLUMN unpriced_requests;
ALTER TABLE usage_rollups_minute DROP COLUMN billed_cost_micro_usd, DROP COLUMN unpriced_requests;
ALTER TABLE usage_events DROP COLUMN billed_cost_micro_usd, DROP COLUMN billing;
