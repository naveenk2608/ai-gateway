-- Up Migration

-- Analytics rollups (ADR 015). The worker adds each newly ingested request to a per-minute row, and
-- the same per-minute deltas to the per-hour and per-day rows, in the transaction that inserts the
-- request. A re-delivered event inserts no request, so it adds nothing here either (ADR 014).
-- Buckets are UTC. Latency and time to first token are kept as histogram counts, so percentiles
-- can be approximated from any set of rows without reading raw history.

-- Inclusive upper bounds (ms) of the histogram buckets, plus one overflow bucket. Must equal
-- LATENCY_BUCKET_BOUNDS_MS in packages/shared/src/analytics.ts (a test checks).
CREATE FUNCTION rollup_bucket_bounds() RETURNS integer[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY[10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000]
$$;

-- A histogram holding the one value `ms` (NULL for NULL).
CREATE FUNCTION histogram_one_hot(ms integer) RETURNS bigint[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN ms IS NULL THEN NULL ELSE (
    SELECT array_agg(
      (CASE WHEN i = 1 + (SELECT count(*) FROM unnest(rollup_bucket_bounds()) AS b WHERE ms > b)
        THEN 1 ELSE 0 END)::bigint ORDER BY i)
    FROM generate_series(1, cardinality(rollup_bucket_bounds()) + 1) AS i
  ) END
$$;

-- Element-wise sum of two histograms; a NULL or shorter one counts as zeros.
CREATE FUNCTION bucket_add(a bigint[], b bigint[]) RETURNS bigint[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(coalesce(x, 0) + coalesce(y, 0) ORDER BY i), '{}')
  FROM unnest(coalesce(a, '{}'), coalesce(b, '{}')) WITH ORDINALITY AS t(x, y, i)
$$;

CREATE AGGREGATE bucket_sum(bigint[]) (SFUNC = bucket_add, STYPE = bigint[], INITCOND = '{}');

CREATE TABLE usage_rollups_minute (
  bucket_start timestamptz NOT NULL,
  project_id uuid NOT NULL REFERENCES projects (id),
  api_key_id uuid REFERENCES api_keys (id),
  -- The logical model the client asked for, and the deployment and provider that answered last
  -- (NULL when no provider was called: rejections and cache hits).
  model text NOT NULL,
  deployment text,
  provider text,
  status text NOT NULL CHECK (status IN ('success', 'error', 'canceled', 'rejected')),
  error_code text,
  requests bigint NOT NULL CHECK (requests > 0),
  cache_hits bigint NOT NULL CHECK (cache_hits >= 0),
  prompt_tokens bigint NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens bigint NOT NULL CHECK (completion_tokens >= 0),
  total_tokens bigint NOT NULL CHECK (total_tokens >= 0),
  cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd >= 0),
  -- Upstream attempts; of those after the first, retries stayed on the same deployment and
  -- fallbacks moved to another one.
  attempts bigint NOT NULL CHECK (attempts >= 0),
  retries bigint NOT NULL CHECK (retries >= 0),
  fallbacks bigint NOT NULL CHECK (fallbacks >= 0),
  latency_ms_sum bigint NOT NULL CHECK (latency_ms_sum >= 0),
  latency_buckets bigint[] NOT NULL,
  -- Time to first token, for streamed requests that produced one.
  ttft_count bigint NOT NULL CHECK (ttft_count >= 0),
  ttft_ms_sum bigint NOT NULL CHECK (ttft_ms_sum >= 0),
  ttft_buckets bigint[] NOT NULL,
  -- Completion tokens of successful requests and the time spent producing them (latency minus
  -- time to first token), for output tokens per second.
  throughput_tokens bigint NOT NULL CHECK (throughput_tokens >= 0),
  throughput_ms bigint NOT NULL CHECK (throughput_ms >= 0),
  UNIQUE NULLS NOT DISTINCT
    (project_id, bucket_start, api_key_id, model, deployment, provider, status, error_code)
);
CREATE INDEX usage_rollups_minute_bucket_idx ON usage_rollups_minute (bucket_start);

CREATE TABLE usage_rollups_hour (LIKE usage_rollups_minute INCLUDING ALL);
ALTER TABLE usage_rollups_hour
  ADD FOREIGN KEY (project_id) REFERENCES projects (id),
  ADD FOREIGN KEY (api_key_id) REFERENCES api_keys (id);
CREATE TABLE usage_rollups_day (LIKE usage_rollups_minute INCLUDING ALL);
ALTER TABLE usage_rollups_day
  ADD FOREIGN KEY (project_id) REFERENCES projects (id),
  ADD FOREIGN KEY (api_key_id) REFERENCES api_keys (id);

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

-- Requests ingested before this migration.
SELECT rollup_requests(ARRAY(SELECT id FROM request_records));

-- Down Migration

DROP FUNCTION rollup_requests(uuid[]);
DROP VIEW request_rollup_facts;
DROP TABLE usage_rollups_day;
DROP TABLE usage_rollups_hour;
DROP TABLE usage_rollups_minute;
DROP AGGREGATE bucket_sum(bigint[]);
DROP FUNCTION bucket_add(bigint[], bigint[]);
DROP FUNCTION histogram_one_hot(integer);
DROP FUNCTION rollup_bucket_bounds();
