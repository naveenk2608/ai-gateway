-- Up Migration

-- Monthly partitions for the raw request tables (M17, ADR 039). request_records,
-- provider_attempts and usage_events grow without limit, and Neon's free plan holds 1 GB per
-- project. Each becomes a table partitioned by month on the time its event carries (started_at,
-- started_at, occurred_at): a re-delivered event has the same key, so ON CONFLICT DO NOTHING still
-- drops it (ADR 014). Table names and columns stay the same, so a gateway or worker of the previous
-- version keeps working during a deploy (its inserts use ON CONFLICT DO NOTHING without a target).
--
-- What changes: a unique key on a partitioned table must include the partition column, so
-- (id) becomes (id, started_at) and so on; and a foreign key cannot point at a partitioned table,
-- so provider_attempts.request_id and usage_events.request_id no longer reference request_records
-- (the worker inserts all three in one transaction; nothing relies on the reference).
--
-- Partitions run from the oldest row's month to three months ahead; a default partition takes
-- anything outside them, so an insert never fails. The worker creates months ahead and drops old
-- ones (RAW_RETENTION_MONTHS) with the two functions below.

-- The partition of `parent` for the UTC month holding `in_month`, named <parent>_YYYY_MM,
-- partitioned on `part_key`. Rows the default partition holds for that month move into it first,
-- so attaching it never fails. Returns false when it exists already.
CREATE FUNCTION gw_create_month_partition(parent text, part_key text, in_month timestamptz)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  first_day timestamp := date_trunc('month', in_month AT TIME ZONE 'UTC');
  lower_bound timestamptz := first_day AT TIME ZONE 'UTC';
  upper_bound timestamptz := (first_day + interval '1 month') AT TIME ZONE 'UTC';
  child text := parent || '_' || to_char(first_day, 'YYYY_MM');
BEGIN
  IF to_regclass(child) IS NOT NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', child, parent);
  EXECUTE format(
    'WITH moved AS (DELETE FROM %I WHERE %I >= %L AND %I < %L RETURNING *) '
    'INSERT INTO %I SELECT * FROM moved',
    parent || '_default', part_key, lower_bound, part_key, upper_bound, child);
  EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
    parent, child, lower_bound, upper_bound);
  RETURN true;
END $$;

-- Drops the monthly partitions of `parent` for months before the UTC month holding `older_than`;
-- returns how many it dropped. The default partition is never dropped.
CREATE FUNCTION gw_drop_month_partitions(parent text, older_than timestamptz)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  cutoff text := to_char(date_trunc('month', older_than AT TIME ZONE 'UTC'), 'YYYY_MM');
  child record;
  dropped integer := 0;
BEGIN
  FOR child IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = parent
       AND c.relname ~ ('^' || parent || '_[0-9]{4}_[0-9]{2}$')
       AND right(c.relname, 7) < cutoff
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP TABLE %I', child.relname);
    dropped := dropped + 1;
  END LOOP;
  RETURN dropped;
END $$;

-- Monthly partitions of `parent` from `from_time` to three months after now.
CREATE FUNCTION gw_create_partitions_through(parent text, part_key text, from_time timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  current_month timestamp := date_trunc('month', least(from_time, now()) AT TIME ZONE 'UTC');
  last_month timestamp := date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months';
BEGIN
  WHILE current_month <= last_month LOOP
    PERFORM gw_create_month_partition(parent, part_key, current_month AT TIME ZONE 'UTC');
    current_month := current_month + interval '1 month';
  END LOOP;
END $$;

-- request_records, by started_at.
ALTER TABLE request_records RENAME TO request_records_unpartitioned;
CREATE TABLE request_records (
  LIKE request_records_unpartitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (started_at);
ALTER TABLE request_records
  ADD CONSTRAINT request_records_pk PRIMARY KEY (id, started_at),
  ADD CONSTRAINT request_records_project FOREIGN KEY (project_id) REFERENCES projects (id),
  ADD CONSTRAINT request_records_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys (id);
CREATE INDEX request_records_by_project ON request_records (project_id, started_at DESC, id DESC);
CREATE TABLE request_records_default PARTITION OF request_records DEFAULT;
SELECT gw_create_partitions_through(
  'request_records', 'started_at',
  coalesce((SELECT min(started_at) FROM request_records_unpartitioned), now()));
INSERT INTO request_records SELECT * FROM request_records_unpartitioned;

-- provider_attempts, by started_at.
ALTER TABLE provider_attempts RENAME TO provider_attempts_unpartitioned;
CREATE TABLE provider_attempts (
  LIKE provider_attempts_unpartitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (started_at);
ALTER TABLE provider_attempts
  ADD CONSTRAINT provider_attempts_pk PRIMARY KEY (id, started_at),
  ADD CONSTRAINT provider_attempts_number UNIQUE (request_id, attempt_number, started_at);
CREATE TABLE provider_attempts_default PARTITION OF provider_attempts DEFAULT;
SELECT gw_create_partitions_through(
  'provider_attempts', 'started_at',
  coalesce((SELECT min(started_at) FROM provider_attempts_unpartitioned), now()));
INSERT INTO provider_attempts SELECT * FROM provider_attempts_unpartitioned;

-- usage_events, by occurred_at: the ledger's UNIQUE(event_id) becomes UNIQUE(event_id,
-- occurred_at); occurred_at comes from the event, so a re-delivery still conflicts (ADR 014).
ALTER TABLE usage_events RENAME TO usage_events_unpartitioned;
CREATE TABLE usage_events (
  LIKE usage_events_unpartitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (occurred_at);
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_pk PRIMARY KEY (id, occurred_at),
  ADD CONSTRAINT usage_events_event UNIQUE (event_id, occurred_at),
  ADD CONSTRAINT usage_events_request UNIQUE (request_id, occurred_at),
  ADD CONSTRAINT usage_events_project FOREIGN KEY (project_id) REFERENCES projects (id),
  ADD CONSTRAINT usage_events_api_key FOREIGN KEY (api_key_id) REFERENCES api_keys (id),
  ADD CONSTRAINT usage_events_price FOREIGN KEY (price_id) REFERENCES model_prices (id);
CREATE INDEX usage_events_by_project ON usage_events (project_id, occurred_at DESC);
CREATE TABLE usage_events_default PARTITION OF usage_events DEFAULT;
SELECT gw_create_partitions_through(
  'usage_events', 'occurred_at',
  coalesce((SELECT min(occurred_at) FROM usage_events_unpartitioned), now()));
INSERT INTO usage_events SELECT * FROM usage_events_unpartitioned;

-- The rollup view now reads the partitioned tables (a view follows a renamed table, so it is
-- defined again by name; same columns as migration 0007).
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

DROP TABLE usage_events_unpartitioned;
DROP TABLE provider_attempts_unpartitioned;
DROP TABLE request_records_unpartitioned;

-- Down Migration

-- Back to plain tables with the constraints of migrations 0001 to 0016. Rows are kept, except
-- attempts and usage rows whose request was dropped with an old partition (the restored foreign
-- keys would refuse them) and any second row for one ID (the restored unique keys).
ALTER TABLE usage_events RENAME TO usage_events_partitioned;
ALTER TABLE provider_attempts RENAME TO provider_attempts_partitioned;
ALTER TABLE request_records RENAME TO request_records_partitioned;

CREATE TABLE request_records (
  LIKE request_records_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (id),
  FOREIGN KEY (project_id) REFERENCES projects (id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys (id)
);
CREATE INDEX request_records_project_started_idx ON request_records (project_id, started_at DESC, id DESC);
INSERT INTO request_records SELECT * FROM request_records_partitioned ON CONFLICT DO NOTHING;

CREATE TABLE provider_attempts (
  LIKE provider_attempts_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (id),
  FOREIGN KEY (request_id) REFERENCES request_records (id),
  UNIQUE (request_id, attempt_number)
);
INSERT INTO provider_attempts
SELECT * FROM provider_attempts_partitioned a
 WHERE EXISTS (SELECT 1 FROM request_records r WHERE r.id = a.request_id)
ON CONFLICT DO NOTHING;

CREATE TABLE usage_events (
  LIKE usage_events_partitioned INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (id),
  UNIQUE (event_id),
  UNIQUE (request_id),
  FOREIGN KEY (request_id) REFERENCES request_records (id),
  FOREIGN KEY (project_id) REFERENCES projects (id),
  FOREIGN KEY (api_key_id) REFERENCES api_keys (id),
  FOREIGN KEY (price_id) REFERENCES model_prices (id)
);
CREATE INDEX usage_events_project_occurred_idx ON usage_events (project_id, occurred_at DESC);
INSERT INTO usage_events
SELECT * FROM usage_events_partitioned u
 WHERE EXISTS (SELECT 1 FROM request_records r WHERE r.id = u.request_id)
ON CONFLICT DO NOTHING;

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

DROP TABLE usage_events_partitioned;
DROP TABLE provider_attempts_partitioned;
DROP TABLE request_records_partitioned;
DROP FUNCTION gw_create_partitions_through(text, text, timestamptz);
DROP FUNCTION gw_drop_month_partitions(text, timestamptz);
DROP FUNCTION gw_create_month_partition(text, text, timestamptz);
