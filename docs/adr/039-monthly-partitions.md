# ADR 039: Monthly partitions and retention for the raw request tables

- Status: accepted
- Date: 2026-11-10
- Milestone: M17

## Context

`request_records`, `provider_attempts` and `usage_events` keep a row per request and attempt
forever (PLAN-NOTES, M2 and M6). The analytics pages read rollups (ADR 015), which already expire;
the raw rows only back the request list and detail. Neon's Free plan holds 1 GB per project
(<https://neon.com/pricing>, checked 2026-11-10), and deleting old rows one by one bloats the
table and costs I/O. Effectively-once accounting (ADR 014) depends on unique keys and
`ON CONFLICT DO NOTHING`.

## Decision

- **One restructuring migration** (0017) turns the three tables into tables partitioned by month
  (`RANGE`), on the time their event carries: `request_records.started_at`,
  `provider_attempts.started_at`, `usage_events.occurred_at`. Names and columns stay the same; rows
  are copied; the rollup view is defined again on the new tables; the old tables are dropped.
- **Keys**: a unique key on a partitioned table must include the partition column, so the primary
  keys become `(id, started_at)` / `(id, occurred_at)`, and the ledger's `UNIQUE(event_id)` becomes
  `UNIQUE(event_id, occurred_at)` (likewise `request_id`, and `(request_id, attempt_number,
  started_at)` for attempts). Because these times come from the event, a re-delivered event has
  the same key and is still dropped by `ON CONFLICT DO NOTHING`.
- **Foreign keys** from `provider_attempts` and `usage_events` to `request_records` cannot exist
  (a foreign key cannot point at a partitioned table) and are dropped. Nothing relies on them: the
  worker inserts all three in one transaction. The other foreign keys (projects, API keys,
  prices) stay.
- **Partitions**: from the oldest row's month to three months ahead, plus a default partition so an
  insert outside them never fails. `gw_create_month_partition` (moving rows the default partition
  holds for that month first) and `gw_drop_month_partitions` are SQL functions the worker calls.
- **Maintenance**: on its retention schedule (`ROLLUP_RETENTION_INTERVAL_MS`, hourly), the worker
  creates the current month and `RAW_PARTITIONS_AHEAD_MONTHS` (3) more, drops monthly partitions
  older than `RAW_RETENTION_MONTHS` (6) before the current month, and deletes default-partition
  rows older than that in batches. `RAW_RETENTION_MONTHS=0` keeps everything;
  `RAW_PARTITIONS_ENABLED=false` stops the maintenance (the default partition still takes rows).
- **Deploys**: the previous version keeps working while the new one migrates: the same names and
  columns, and its inserts use `ON CONFLICT DO NOTHING` without a conflict target, which works on
  partitioned tables. The migration runs in one transaction under the migration lock.
- **Down migration**: plain tables with the original constraint names, keeping every row except
  attempts and usage rows whose request was dropped with an old partition.

## Alternatives considered

- Deleting old rows in batches from plain tables: works, but leaves bloat and vacuum work on a 1 GB
  plan; dropping a partition is instant and frees the space.
- Partitioning on `created_at` (insert time): a re-delivered event would get a new key and be
  counted twice, breaking ADR 014.
- `pg_partman` or a Neon feature: an extension to install and depend on for two small functions.
- Keeping the foreign keys by adding `started_at` to the child tables: extra columns and a
  composite reference for a check the code does not need.

## Consequences

- Raw rows older than six months disappear on schedule; rollups keep the analytics (day rollups
  400 days, ADR 015). The request list and detail cover the retained months only.
- Lookups by request ID alone scan each partition's index; with a few monthly partitions this is
  cheap.
- Rows dated far outside the partitions (tests, late events) sit in the default partition until
  their month's partition is created or retention deletes them.
- Tested: `test/partitions.test.ts` migrates a copy of the schema with rows in three months up,
  checks rows, partitions, the view and duplicate drops, runs the worker's maintenance (creating
  months ahead, moving default rows, dropping by retention) and migrates down and up again; the
  local Compose database (15,396 request records, 6,596 usage rows) migrated through 0017 with every
  row kept and the integration suites that use these tables passing on it.

## Note (2026-11-11, M19): guardrail findings follow the raw rows

`guardrail_results` (migration 0016, ADR 035) holds one row per check that found something in a
request, keyed by the request's start time, but it was never pruned while the requests it points
to were dropped after `RAW_RETENTION_MONTHS`. The retention pass of both consumers (the worker's,
on Redis Streams or SQS, and the gateway's with `RUN_WORKER_IN_PROCESS`) now deletes its rows
older than the same cutoff the raw partitions use (the start of the month `RAW_RETENTION_MONTHS`
before the current one), in batches of 1,000 like the other retention deletes, right after the
partition maintenance. The same switches apply: nothing is deleted when `RAW_PARTITIONS_ENABLED`
is false or `RAW_RETENTION_MONTHS` is 0. The table is not partitioned (no migration in this
change); its rows are small and few per request. Tests: `apps/worker/test/guardrail-retention.test.ts`
(the cutoff, batches, both off switches, and the consumer's schedule).
