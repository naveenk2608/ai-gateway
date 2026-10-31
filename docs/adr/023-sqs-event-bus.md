# ADR 023: SQS adapter for the event bus

- Status: accepted
- Date: 2026-10-31
- Milestone: M10

## Context

ADR 005 put usage events behind an `EventBus` interface with a Redis Streams adapter and promised
an SQS adapter for AWS. On AWS, a managed queue with a dead-letter queue removes the stream's
memory cap (`MAXLEN ~`) and lets the worker run without Redis. The accounting guarantees of
ADR 014 (every event stored exactly once in effect, bad events dead-lettered, Postgres outages
survived) must hold unchanged.

## Decision

- `EVENT_BUS=sqs` (default `redis`) with `SQS_QUEUE_URL`, `SQS_DLQ_URL` and `AWS_REGION`
  selects SQS for the gateway (publishing) and the worker (consuming), including the in-process
  consumer. Credentials come from the AWS SDK's default chain (the instance role on EC2).
- **Publishing:** the buffering of ADR 005 moves into a base class shared by both adapters, so
  `publish` still never blocks or throws. Batches go out with `SendMessageBatch` (10 per call);
  only the entries SQS refused are retried, in order.
- **Standard queue, not FIFO.** Order does not matter to the worker, and duplicates are already
  harmless: inserts are `ON CONFLICT DO NOTHING` on `event_id` (ADR 014).
- **Consuming:** long polls of up to 20 s (`WORKER_BLOCK_MS`, a stop cancels the wait), up to
  `WORKER_BATCH_SIZE` messages per transaction, and `DeleteMessageBatch` only after the commit.
  The visibility timeout is `WORKER_CLAIM_IDLE_MS`: a message not deleted comes back after it,
  which replaces the Redis consumer's claiming of a dead consumer's entries.
- **Dead letters:** a message received more than `WORKER_MAX_DELIVERIES` times is recorded in
  `failed_events` (stream `sqs:<queue name>`), sent to the dead-letter queue by the worker, and
  deleted. The queue's redrive policy is set higher (Terraform: `WORKER_MAX_DELIVERIES` + 5) and
  is only a backstop for messages the worker cannot even handle.
- **Postgres down:** the batch is retried in place, and before each wait its visibility is
  extended past the wait, so no other worker receives it and the outage uses up no deliveries.
- **Observability:** the Infrastructure page and the pipeline metrics read queue depths from
  `GetQueueAttributes` (approximate). SQS does not report the age of in-flight messages or the
  number of consumers, so those show as not reported.
- **Tests never touch AWS:** they run against LocalStack, started only through the `aws-local`
  Compose profile. LocalStack is pinned to 4.14.0, the last release that runs without an account
  token. A client with `SQS_ENDPOINT` set always uses LocalStack's placeholder credentials, and
  the test config gives the SDK no config files and no instance metadata.

## Alternatives considered

- FIFO queues: ordering and deduplication the worker does not need, at a lower throughput and a
  higher price.
- Only the redrive policy for dead letters: SQS would move bad messages, but the reason and the
  `failed_events` row the dashboard counts would be lost.
- Amazon Kinesis or MSK: stream semantics like Redis Streams, but a heavier and pricier service
  for one event type.
- A hand-written SigV4 client instead of the AWS SDK: fewer dependencies, but credentials from
  the instance role (IMDSv2) and retries would have to be rebuilt; `@aws-sdk/client-sqs` is the
  one new dependency.
- An SQS-compatible server other than LocalStack (ElasticMQ): lighter, but the milestone asks
  for LocalStack, which is what most AWS projects test against.

## Consequences

- Tested against LocalStack: an event delivered three times is stored once; a worker killed
  before or after the commit loses and duplicates nothing; a malformed event is dead-lettered
  with its reason after repeated deliveries; queue depths reach the Infrastructure page; a stop
  is prompt; a request through `/v1` reaches Postgres over SQS; and during a Postgres outage
  several visibility timeouts long, a second worker never receives the first one's batch.
- With SQS, the worker needs no Redis and the gateway still needs it (limits, budgets, cache).
- Events lost while SQS is unreachable for longer than the buffer lasts are dropped and counted,
  as with Redis (ADR 005); a transactional outbox remains future work.
- LocalStack 4.14.0 will age. Moving to a newer LocalStack needs a (free) account token in CI.
