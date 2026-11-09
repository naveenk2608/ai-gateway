# ADR 037: OpenTelemetry tracing, off unless an OTLP endpoint is set

- Status: accepted; supersedes the "no tracing SDK" part of ADR 017
- Date: 2026-11-10
- Milestone: M17

## Context

ADR 017 left the OpenTelemetry SDK out for its memory and start-up cost on the free host: trace
IDs live in log lines and `traceparent` headers, and following a request means searching logs.
Off the free host (Compose, Kubernetes), a trace view of one request across the gateway, its
provider attempts and the worker is worth the SDK, as long as the demo pays nothing for it and
nothing private ends up in a span.

## Decision

- **Off by default.** Tracing starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (both
  processes; the in-process worker shares the gateway's). Then the SDK (`@opentelemetry/sdk-trace`
  3.1.1, `resources` 3.1.1, `exporter-trace-otlp-http` 0.301.1) is loaded with a dynamic import
  and spans are sent in batches over OTLP/HTTP; the exporter reads the standard
  `OTEL_EXPORTER_OTLP_*` variables. Without it only `@opentelemetry/api` 1.10.0 is loaded, whose
  tracer is a no-op. Render keeps it off.
- **Same IDs as the logs.** The gateway already makes a trace and span ID per request and a child
  span ID per attempt (ADR 017). Spans are started with exactly those IDs (a pinned ID generator),
  under the caller's `traceparent` when there is one, so a `traceId` from a log line or a response
  header finds the trace. With tracing on, every /v1 request is recorded and its `traceparent` is
  passed on as sampled.
- **Spans**: `POST /v1/...` (server; status code, request ID), `provider.attempt` (client;
  deployment, provider, provider model, attempt number, stream, outcome, upstream status),
  `cache.lookup` (hit or miss), `coalesce.wait` (a follower or a repeat waiting for another
  request's answer), `db.idempotency_claim` (`db.system.name` postgresql), and in the worker
  `usage.ingest` (consumer; one per event, child of the request's span through the trace context
  the usage event already carries). Failed spans carry a short code, never a provider's text.
  Spans never hold prompt or answer text, tool arguments, keys or URLs.
- **Not traced**: health checks, readiness, `/metrics` and the admin API.
- **Local trace store**: Jaeger 2.22.0 in Compose (profile `tracing`, OTLP/HTTP on 4318, UI on
  16686), with README steps.

## Alternatives considered

- Auto-instrumentation (HTTP, undici, pg, ioredis): many more packages and spans, and hard to keep
  prompt text out of attributes; the few spans that matter are made by hand.
- An async context manager for implicit parents: one more package; parents are passed
  explicitly.
- Keeping logs only (ADR 017): no trace view; still the default when no endpoint is set.

## Consequences

- With an endpoint set, one request shows as one trace from the gateway through its provider
  attempts to the worker's insert, in any OTLP backend.
- Five new runtime dependencies (Apache-2.0, exact versions); the SDK's memory is spent only when
  tracing is on.
- Tested with an in-memory exporter (`src/tracing.test.ts`): a request with a caller's
  `traceparent` yields the request, attempt, cache lookup and worker ingest spans with the expected
  IDs and parents and no prompt text; a request without one starts a trace; health checks make no
  span.
