# Roadmap

What is left to build, milestone by milestone, from M8 to the end of the project. Each section
has enough detail to start work from the repository alone: read this file, then
[PLAN-NOTES.md](PLAN-NOTES.md) and the ADRs in [adr/](adr/).

## Where the project stands (2026-10-21)

- M0–M7 are done and tagged `m0-done` … `m7-done`: the OpenAI-compatible proxy (streaming and
  non-streaming), API keys, admin auth and RBAC, the usage pipeline (Redis Stream → worker →
  Postgres, effectively-once), Redis Lua limits and budget reservations, retries, breakers,
  routing policies, the exact cache, the analytics API (rollups) and the full React dashboard.
- Live demo: <https://ai-gateway-8var.onrender.com> (Render free web service, Docker, deploys
  every commit on `main`). It runs the gateway image with `RUN_WORKER_IN_PROCESS=true` (the
  free plan has no background workers), with Render's free Postgres and Key Value (Redis).
- CI (`.github/workflows/ci.yml`) has four jobs: `check` (format, lint, dashboard-data check,
  typecheck, unit tests, build), `integration` (Postgres + Redis services), `dashboard-e2e`
  (Chromium at 375 px) and `images` (all Compose images build).
- Accepted decisions are ADR 001–016 and 018. ADR 017 (observability) is written in M8.

## How to work on a milestone

1. Work on one milestone at a time. Inspect the relevant code before changing it.
2. Build in small vertical slices. After each one run `pnpm format`, `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, and `pnpm test:int` (needs `docker compose up -d`) when the
   slice touches Postgres, Redis or HTTP behaviour. Fix failures before moving on. Never skip,
   delete or weaken a failing test.
3. Conventional commits, one per slice. Messages describe the change only: no attribution
   trailers or generated-by lines.
4. Update `.env.example`, the OpenAPI schemas, the README and PLAN-NOTES when behaviour or
   config changes. Deferred work goes in PLAN-NOTES as a row (`open`, `by design`,
   `planned M<N>`, `done`), never as a `TODO` in finished code.
5. Never write benchmark or dashboard numbers by hand; empty data shows an empty state.
   No secrets in code, tests, fixtures or logs; `.env` is never committed.
6. A new dependency is pinned to an exact version and justified in one line in the report.
7. To change an accepted decision, write a new ADR that supersedes it (template:
   [adr/000-template.md](adr/000-template.md)) instead of diverging silently.
8. A milestone is done when every CI job is green on its last commit, the Render deploy of that
   commit is live with `/ready` returning 200, its acceptance checks pass, PLAN-NOTES is updated,
   and the README status line names it. Then tag `m<N>-done`.

End each milestone with this report:

```markdown
## M<N> report
- Done: <features, each with the test or command that proves it>
- Changed files: <grouped by app/package>
- Test results: <counts, plus any flaky or skipped tests and why>
- Deferred / known issues: <list, also written to docs/PLAN-NOTES.md>
- New dependencies: <name@version — reason>
- Next step: <first task of the next milestone>
```

## M8 — Observability

**Goal.** Operators can see traffic, latency, errors, routing behaviour and the usage pipeline
from Prometheus metrics, and follow one request through gateway and worker logs by its trace
ID. Ops metrics stay separate from the business analytics of M6.

**Scope**

- `prom-client` with one registry per process, plus default Node process metrics in both.
- Gateway metrics: HTTP requests and duration by method, route pattern and status; upstream
  attempts by provider, deployment, model and outcome; retries; fallbacks; breaker state and
  transitions; cache hits and misses; admission rejections by reason (rpm, tpm, concurrency,
  budget, request too large, limits unavailable) and scope; TTFT and output tokens/s
  histograms; prompt-token estimate error (estimated vs reported, as a ratio); usage events
  published, buffered and dropped; Postgres pool clients; Redis and Postgres round trips.
- Worker metrics: events consumed, dead-lettered and reclaimed; stream lag, pending entries,
  oldest pending age and DLQ length (read from Redis at scrape time); batch, rollup and prune
  durations. When the consumer runs inside the gateway, these use the gateway's registry.
- Bounded label cardinality: model, deployment and provider values come from
  `config/models.json` (anything else becomes `other`); never request IDs, key IDs, project IDs
  or user input as labels.
- Protection: `METRICS_TOKEN` (bearer, constant-time compare) guards `GET /metrics` on the main
  port. Missing or wrong token → 401; no token configured → 404. Optional `METRICS_PORT` and
  `METRICS_HOST` (default `127.0.0.1`) add a separate listener. The worker serves its own
  `/metrics` on `127.0.0.1:9465` by default, with the same token rule.
- Tracing without a tracing SDK: W3C `traceparent` accepted from clients (strictly validated)
  or generated; `traceId` and `spanId` on every request log line; one child span per provider
  attempt, sent upstream as `traceparent`; `traceparent` on the response; the trace carried in
  the usage event so the worker logs it when it stores the event. `requestId` stays
  server-generated.
- Compose profile `observability`: Prometheus and Grafana bound to `127.0.0.1`, with memory
  limits and short retention; a provisioned datasource and one dashboard (traffic, latency
  p50/p95, errors, fallbacks, breakers, stream lag, DLQ) containing queries only.
- Dashboard Infrastructure page keeps reading the admin API. New card "This gateway instance":
  measured process values only (uptime, memory, event-loop lag, events buffered and dropped);
  no hostnames or environment values; "not measured" where there is no data. No history on the
  page; history lives in Prometheus.

**Acceptance**

- [ ] Unit tests for metric recording, and a cardinality test that feeds many random models,
      paths and IDs and fails if any metric exceeds its series bound or uses a label outside the
      allow-list.
- [ ] Integration test: real requests through the mock provider, then a scrape of `/metrics`
      shows the counters moved; `/metrics` rejects a missing or wrong token and serves the right
      one.
- [ ] A test checks that every metric queried in the Grafana dashboard JSON is registered by the
      code; CI validates the Prometheus config with `promtool check config`.
- [ ] One request ID can be followed through gateway and worker logs by a single trace ID.
- [ ] Stopping the worker makes stream lag rise visibly on the Infrastructure page.
- [ ] The observability profile was started once, Prometheus showed both targets up and the
      dashboard rendered real series, then the profile was stopped.
- [ ] All four CI jobs green; Render live on the last commit with `/ready` 200 and `/metrics`
      401 without the token. After the owner sets `METRICS_TOKEN` in the Render dashboard
      (Generate), `/metrics` returns 200 with it.

**ADR to write.** ADR 017 — observability: pino JSON logs with request and trace IDs,
prom-client `/metrics` behind a token or a private listener, W3C trace context in logs and
events without an OpenTelemetry SDK (no collector on the free host; the SDK costs memory and
startup time). Records exporting traces (OTLP) and exemplars as later options.

**PLAN-NOTES rows it closes**

- 2026-10-21 M7 "The Infrastructure page shows only what the gateway measures now…" (planned M8).
- 2026-10-20 M4 "The prompt estimate is stored per request… an estimate-error metric…" (planned M8).
- 2026-10-20 M3 "Event emission and consumer metrics… become Prometheus metrics in M8" (planned M8).
- 2026-10-20 M8 "ADR 017 file (observability) is written in M8" (planned M8).

## M9 — Benchmarks

**Goal.** Reproducible numbers for the gateway's added latency and throughput, and for the
correctness of limits, accounting and the cache under load, every one generated from committed
k6 output.

**Scope**

- An HTTP surface for the mock provider: a small standalone server speaking the
  OpenAI-compatible wire format with the same deterministic settings (latency, TTFT, tokens/s,
  seeded errors). The gateway reaches it through the existing OpenAI-compatible adapter, so the
  gateway path and the direct path hit the same server.
- k6 scripts in `bench/` with configurable VUs, rate, duration and target URL; k6 runs from a
  pinned `grafana/k6` image, so no local install is needed.
- Overhead scenarios at 10, 50 and 100 VUs: k6 → gateway → mock vs k6 → mock, streaming and
  non-streaming, reporting p50/p95/p99 latency, TTFT and throughput.
- Correctness scenarios: rate-limit accuracy across 2 gateway instances (admitted vs limit),
  duplicate-accounting check (requests sent = usage rows stored, none twice), cache hit ratio for
  a repeated temperature-0 workload.
- `pnpm bench` runs the scenarios and writes k6 JSON summaries plus a machine-info capture
  (CPU, memory, OS, Node and image versions, config used) into `bench/results/`.
- `pnpm bench:report` turns those files into `docs/benchmarks.md`: every number links to the
  result file it came from, with machine, config, duration and limitations stated.
- Ollama inference benchmarks (model speed) in a separate report from gateway overhead, and only
  if run against a real Ollama.

**Acceptance**

- [ ] Every number in `docs/benchmarks.md` traces to a committed k6 output file.
- [ ] The report states machine, config, duration and limitations.
- [ ] Unit tests for the report generator (fixture summaries → expected markdown); it fails when
      a referenced result file is missing.
- [ ] CI runs `pnpm bench:report --check`, which fails if `docs/benchmarks.md` differs from
      what the committed results generate (no hand edits).
- [ ] CI green on all jobs; Render live on the last commit with `/ready` 200 (benchmarks never
      run against the free Render service).

**ADR to write.** ADR 019 — benchmark method: k6 in a container, the HTTP mock as the common
upstream, results committed as JSON, the report generated and checked in CI, and why numbers
from a laptop are labelled with their machine.

**PLAN-NOTES rows it closes**

- 2026-10-20 M1 "The mock provider runs in-process… an HTTP surface for M9 is still open" (planned M9).
- 2026-10-20 M9 "Root script `bench` is added with the k6 scripts" (planned M9).

## M10 — AWS deployment and final docs

**Goal.** A documented, reproducible AWS deployment that a fresh account can create, test and
destroy cheaply, plus a README that alone explains the project and how to run it.

**Scope**

- Terraform in `infra/terraform/`: VPC, ALB, two gateway instances (EC2 or ECS), one worker,
  Redis and Postgres as containers on one instance for the cheap demo (ElastiCache and RDS
  documented as options), Secrets Manager for `DATABASE_URL`, `API_KEY_PEPPER` and
  `METRICS_TOKEN`, CloudWatch logs and alarms (5xx rate, unhealthy targets, budget alarm).
- ALB idle timeout raised for long SSE streams; SSE keep-alive comments while waiting for a
  slow first token; ALB target deregistration delay covering the drain (or a pre-stop delay).
- An SQS adapter for `EventBus` (ADR 005) with a DLQ, behind a config flag, plus an SQS
  consumer in the worker; idempotency stays on `event_id` (ADR 014). Tested against an
  SQS-compatible local server in CI, never a real account in tests.
- `TRUST_PROXY` set and verified for the ALB (client IP in login limits).
- Raw-record retention: decide sizing and retention (or partitioning) for `request_records`,
  `provider_attempts` and `usage_events`.
- `terraform destroy` documented as the cleanup procedure, with a cost estimate per day of
  uptime.
- README: problem, features, Mermaid architecture and request-lifecycle diagrams, schema, API
  examples, setup, environment reference, testing, benchmarks, security decisions, limitations,
  AWS guide, future work.
- Testing section maps each required failure scenario to its test: auth and project isolation;
  key revocation and rotation grace; provider adapter normalization of success and errors;
  streaming with mid-stream provider drop and client disconnect; timeouts; retry and fallback
  with no retry after the first byte; breaker transitions; rate limits across instances; budget
  reservation, reconciliation and expiry; duplicate usage events; cache-key isolation; Postgres
  unavailable; Redis unavailable in both fail modes; worker restart and stuck-message reclaim.
  Add a test for any scenario without one (Postgres unavailable is the likeliest gap).
- Trade-off notes on consistency, retries, reservation accuracy and cache correctness.

**Acceptance**

- [ ] A fresh AWS account can `terraform apply`, run the k6 smoke test against the ALB and
      `terraform destroy` with nothing left billing (checked in the billing console).
- [ ] Rate limits hold across the two AWS gateway instances (the M4 concurrency test rerun
      against the ALB).
- [ ] The README alone is enough to run the project locally.
- [ ] CI adds `terraform fmt -check` and `terraform validate`, and SQS adapter tests; all jobs
      green; Render still live on the last commit with `/ready` 200.
- [ ] Applying and destroying real AWS resources is done by the account owner, or with the
      owner's explicit go-ahead for each run.

**ADRs to write.** ADR 020 — AWS deployment layout (single-instance data tier for the demo, ALB
settings for SSE, secrets, alarms, cost bound). ADR 021 — SQS event bus adapter (standard queue,
visibility timeout, redrive to the DLQ, dedupe by `event_id`). Every row of the decision table
then has an ADR file.

**PLAN-NOTES rows it closes**

- 2026-10-20 M1 "No SSE keep-alive comments are sent while waiting for a slow first token…" (planned M10).
- 2026-10-20 M10 "No pre-stop delay between SIGTERM and closing the listener…" (planned M10).
- 2026-10-21 M6 "Raw `request_records`, `provider_attempts` and `usage_events` have no
  retention…" (open; revisit with M10 sizing), and the related 2026-10-20 M2 partitioning row.
- 2026-10-20 M4 "`TRUST_PROXY` must match the proxies in front of the gateway…" (open), for the
  ALB.
- 2026-10-20 M0 "Local Compose Postgres uses trust auth… Production must supply credentials"
  (by design): credentials come from Secrets Manager.

## After M10

Future work, not scheduled: a semantic cache with a measured false-hit rate; cost-aware routing
evaluated against a labelled prompt set; a transactional outbox for usage events (closes the
event-loss rows from M3 and M4); multi-region deployment notes. PLAN-NOTES rows marked `open`
that no milestone above closes stay open until someone picks them up.
