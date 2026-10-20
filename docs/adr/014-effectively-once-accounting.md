# ADR 014: At-least-once delivery plus idempotent inserts

- Status: accepted
- Date: 2026-10-20
- Milestone: M3

## Context

Usage rows drive cost and budgets, so an event must be counted once: never lost when a worker
crashes, never doubled when it is re-delivered. Exactly-once delivery is not available from Redis
Streams (or SQS); at-least-once is.

## Decision

- Each event has a UUIDv7 `eventId`; `usage_events` has `UNIQUE(event_id)` and
  `UNIQUE(request_id)`, `request_records` and `provider_attempts` use the request and attempt IDs
  from ingress as primary keys. Every insert is `ON CONFLICT DO NOTHING`.
- The worker inserts a batch in one transaction and sends `XACK` only after the commit. A crash
  before the commit rolls back; a crash after it leaves entries pending, and their re-delivery
  inserts nothing.
- `XAUTOCLAIM` takes over entries idle longer than `WORKER_CLAIM_IDLE_MS`, from dead consumers or
  from failed attempts. An entry delivered more than `WORKER_MAX_DELIVERIES` (5) times goes to the
  dead-letter stream and a `failed_events` row, then is acknowledged.
- Invalid events are left pending (not acknowledged) and reach the DLQ through the same path. A
  batch the database rejects is retried one event at a time, so one bad event cannot hold back
  the others. While Postgres is unreachable, the batch is retried in place without re-delivery,
  so an outage does not use up delivery attempts.

## Alternatives considered

- Acknowledge before inserting: loses events on a crash.
- Deduplicate in Redis (a set of seen IDs): a second store to keep consistent, and it expires.
- Exactly-once via Kafka transactions: a heavy dependency for one table.

## Consequences

- Tested: the same event published 3 times gives one row; a worker stopped by fault injection
  just before and just after the commit, then restarted, leaves every event stored once; malformed
  events reach the DLQ after 6 deliveries while valid ones are stored at once.
- The kill test uses injected faults at the two crash points rather than killing a real process,
  so it is deterministic.
- The DLQ has no replay tool yet; `failed_events.payload` holds the original event for one.
