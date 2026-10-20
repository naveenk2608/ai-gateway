# ADR 017: Prometheus metrics, trace IDs in logs, no tracing SDK

- Status: accepted
- Date: 2026-10-21
- Milestone: M8

## Context

Operators need traffic, latency, errors, routing behaviour (retries, fallbacks, breakers) and the
health of the usage pipeline (lag, pending, dead letters), with history. The M6 analytics are
business data per project, built from rollups in Postgres. They lag by a batch, and they say
nothing about the processes themselves. One request should also be followable across the gateway,
its provider attempts and the worker that stores its usage.

Constraints: the live demo runs on Render's free plan (one 512 MB web service, no background
workers, no private network, nothing to receive traces), and the local machine has little free
memory. Metrics must not leak through the public port, and their label sets must stay bounded
whatever clients send.

## Decision

- **Metrics.** `prom-client` (15.1.3), with one registry per process and the default Node process
  metrics in each. The gateway records HTTP requests (one histogram: method, route pattern,
  status; its `_count` is the request count) and upstream attempts by provider, deployment,
  provider model and outcome. It also records retries, fallbacks, breaker state and transitions,
  cache lookups, admission rejections by reason, TTFT, output tokens per second, the prompt-token
  estimate error, usage events published, buffered and dropped, Postgres pool clients, and a
  Postgres and Redis round trip per scrape. The worker records events consumed, dead-lettered
  and reclaimed, loop errors, batch, rollup and prune durations, and pruned rows. Most metrics are
  derived from the finished request's usage event, so they count exactly what accounting counts.
- **Stream state.** `usage_stream_*` and `usage_dlq_length` are read from Redis at scrape time by
  both the gateway and the worker, so the lag stays visible while the worker is down. Dashboards
  take the `max` across the two. When Redis does not answer, `usage_stream_up` is 0 and the
  others are NaN, never a stale value.
- **Bounded labels.** Deployment, provider, model and outcome values come from
  `config/models.json` or fixed sets; anything else becomes `other`. Routes are Fastify's
  registered patterns, or `unmatched`. There are no request, key or project IDs and no client
  input. A unit test feeds thousands of random values and fails if any series count grows or an
  unknown label name appears.
- **Protection.** `GET /metrics` on the public port exists only when `METRICS_TOKEN` (32+
  characters) is set, and needs it as a bearer token, compared in constant time over SHA-256
  digests. A missing or wrong token gets 401; with no token configured the route is a 404. An
  optional private listener (`METRICS_PORT` on `METRICS_HOST`, loopback by default) serves the
  same registry and is protected by its bind address (plus the token if set). The worker serves
  only such a listener (`WORKER_METRICS_PORT`, default 9465). Compose scrapes the private
  listeners on its network and publishes neither port, so no token is committed.
- **Trace context without an SDK.** The gateway accepts a W3C `traceparent` (strictly validated;
  invalid ones start a new trace) or starts a trace. It makes a span per request and a child span
  per provider attempt, sent upstream as `traceparent`. Every request log line carries `traceId`
  and `spanId`, attempt lines also carry `attemptSpanId`, and the response carries `traceparent`.
  The usage event carries the trace, and the worker logs `usage event stored` with the same
  `traceId` and the request span as `parentSpanId`. `requestId` stays server-generated. Nothing is
  exported as spans: the trace lives in the logs.
- **Local stack.** The Compose profile `observability` adds Prometheus (1 day, 256 MB retention)
  and Grafana with a provisioned datasource and one dashboard that holds only queries. Both are
  bound to 127.0.0.1 and memory-limited. Grafana is anonymous read-only with no login form, so no
  password exists.
- **Dashboard.** The Infrastructure page keeps reading the admin API. It adds the answering
  instance's measured process values (uptime, memory, CPU share and event-loop delay since the
  previous reading, usage events buffered and dropped). History stays in Prometheus.

## Alternatives considered

- The OpenTelemetry SDK with auto-instrumentation: real spans and exemplars, but dozens of
  packages, tens of MB of memory and a slower start on a 512 MB free instance, and on Render there
  is no collector to export to. The IDs it would propagate are the W3C ones used here, so adding
  it later keeps every log field and header.
- `/metrics` open on the public port, or behind the admin session: the first exposes internals
  to anyone; the second ties scrapers to dashboard users and cookies.
- A separate port only: safest, but Render exposes one port, so the demo could not be scraped.
- Stream gauges from the worker only: the series vanish exactly when the worker stops, which is
  when lag matters.
- Labels per project or API key: useful, but unbounded with tenants; per-project numbers are what
  the M6 analytics are for.
- Pushing to a hosted metrics service: needs an account and a key, which local development must
  not.

## Consequences

- Tested: unit tests for each metric, the cardinality test, token checks on both listeners, an
  integration test that scrapes after real traffic through the mock provider and follows one
  trace from the gateway's request and attempt lines to the consumer's line. A test checks that
  every metric the Grafana dashboard queries is registered by the code; CI runs
  `promtool check config`.
- Metrics are per process. Prometheus must scrape every gateway instance to see the fleet; breaker
  state and the instance card describe the one process that answered.
- Scrapes cost a Redis read and a Postgres and Redis round trip each, and the instance card's CPU
  and event-loop delay are windows between readings, null on the first.
- There is no trace store: following a request means searching logs for its `traceId`.
  Exporting traces (OTLP) and exemplars on histograms are recorded as later options.
- `tracestate` is not forwarded to providers.
