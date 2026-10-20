# ADR 015: Analytics from per-minute rollups with latency histograms

- Status: accepted
- Date: 2026-10-21
- Milestone: M6

## Context

The dashboard needs counts, tokens, cost, error and fallback rates and latency percentiles over
the last hour up to the last 30 days, broken down by project, key, model, deployment and status.
Scanning `request_records` for each chart grows with history and would compete with ingestion.
The totals must stay exactly equal to the raw records, even though usage events can be delivered
more than once (ADR 014).

## Decision

- The worker keeps three tables, `usage_rollups_minute`, `_hour` and `_day`, with one row per
  UTC bucket and key (project, API key, logical model, deployment, provider, status, error code).
  Each row holds sums (requests, cache hits, tokens, cost, attempts, retries, fallbacks, latency,
  time to first token, throughput) and two histograms: counts per latency and per TTFT bucket,
  with fixed bounds from 10 ms to 120 s plus an overflow bucket.
- Rollups are written in the same transaction as the request rows, only for the requests that
  transaction inserted (`RETURNING id`), by one SQL function: per-minute deltas from the inserted
  requests, then the hourly and daily deltas derived from those per-minute deltas. A re-delivered
  event inserts no request and so adds nothing. Rows are upserted in key order, so concurrent
  workers lock them in the same order.
- The migration that adds the tables back-fills them from existing records.
- Reads: 1 h and 24 h use minute rows, 7 d hourly rows, 30 d daily rows; any other range is a
  400 listing the supported ones. Windows end with the current step and are aligned to it (1 min,
  15 min, 1 h, 1 day). Percentiles are interpolated within histogram buckets and labelled
  approximate; values over 120 s are reported as 120 s.
- Retention per table is configurable (default 48 h, 35 days, 400 days) and cannot be set below
  what the ranges need. The consumer deletes expired rows every hour.
- Only the request list reads raw records, one keyset page at a time.

## Alternatives considered

- Hourly and daily rows built by a periodic job from minute rows: needs a watermark for late
  events and must run before minute rows expire; the same totals come from the per-minute deltas
  at no extra pass.
- Exact percentiles (`percentile_cont` over raw rows): exact, but scans history on every read.
- t-digest or HDR sketches: more accurate tails, but an extension or custom encoding; fixed
  buckets are enough for a dashboard and sum with plain SQL.
- Counters in Redis: fast, but not transactional with the records, so totals could drift.

## Consequences

- Tested by a property test (fast-check): random requests, batch sizes and re-deliveries give
  rollups equal, row by row, to totals computed from the events, and equal to raw-record sums;
  the SQL and TypeScript histogram bounds are checked to match.
- Each ingested batch does one more statement; analytics reads touch at most the rows of the
  window, never history.
- Buckets are UTC; a "day" is a UTC day. Percentiles are approximate by design.
- Changing histogram bounds or rollup keys needs a migration and a rebuild from raw records,
  which only works for records still kept.
