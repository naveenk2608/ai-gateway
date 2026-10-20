# ADR 005: An EventBus seam with a Redis Streams adapter

- Status: accepted
- Date: 2026-10-20
- Milestone: M3

## Context

Usage must be recorded for every request, but writing to Postgres on the request path would put
analytics latency and database outages in front of clients. The self-hosted setup has Redis
already; the AWS deployment (M10) should be able to use SQS without touching the proxy.

## Decision

The gateway emits usage through an `EventBus` interface (`publish`, `stats`, `close`).
`publish` never blocks and never throws. The Redis Streams adapter puts the event in a bounded
in-memory buffer (`EVENTS_BUFFER_MAX`) and a background loop writes batches with pipelined
`XADD ... MAXLEN ~ EVENTS_STREAM_MAXLEN`, retrying with exponential backoff (up to 5 s) while
Redis is unreachable. On shutdown the buffer is flushed for up to 2 s.

The worker reads the stream through a consumer group (ADR 014) and trims entries that every
consumer has acknowledged.

## Alternatives considered

- Write to Postgres in the request: couples client latency to the database.
- Transactional outbox in Postgres: no loss window, but it puts a Postgres write on every request,
  which this design avoids; kept as future work.
- Kafka or NATS: one more service to run for a self-hosted gateway that already has Redis.

## Consequences

- If Redis is down longer than the buffer lasts, newest events are dropped and the drops are
  logged with a count. Events still buffered when the shutdown flush times out are lost and
  logged. This is the documented limit until an outbox exists.
- `MAXLEN ~` caps Redis memory but would trim unprocessed events if the worker were down long
  enough to fall that far behind.
- Stream trimming assumes one consumer group per stream; with more, the worker does not trim.
- The SQS adapter (M10) implements the same interface; the worker gets an SQS consumer then.
