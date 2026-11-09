# Roadmap

What is left to build, milestone by milestone, from M8 on. Each section
has enough detail to start work from the repository alone: read this file, then
[PLAN-NOTES.md](PLAN-NOTES.md) and the ADRs in [adr/](adr/).

## Where the project stands (2026-10-31, after M10)

- M0–M7 are done and tagged `m0-done` … `m7-done`: the OpenAI-compatible proxy (streaming and
  non-streaming), API keys, admin auth and RBAC, the usage pipeline (Redis Stream → worker →
  Postgres, effectively-once), Redis Lua limits and budget reservations, retries, breakers,
  routing policies, the exact cache, the analytics API (rollups) and the full React dashboard.
- Live demo: <https://ai-gateway-8var.onrender.com> (Render free web service, Docker, deploys
  every commit on `main`). It runs the gateway image with `RUN_WORKER_IN_PROCESS=true` (the
  free plan has no background workers), with Render's free Postgres and Key Value (Redis).
- CI (`.github/workflows/ci.yml`) has five jobs: `check` (format, lint, dashboard-data check,
  benchmark report check, typecheck, unit tests, build), `integration` (Postgres + Redis
  services, LocalStack for the SQS tests), `dashboard-e2e` (Chromium at 375 px), `images` (all
  Compose images build; the Prometheus config, the bench stack's and the AWS demo's Compose
  files are valid) and `terraform` (fmt, validate, `terraform test` with a mocked AWS provider,
  the tag check; no AWS credentials).
- M8 (observability) is done: every acceptance check passed, including Render `/metrics`
  answering 401 without the token or with a wrong one once `METRICS_TOKEN` was set. The owner
  tags `m8-done`.
- M9 (benchmarks) is done: the mock provider over HTTP, k6 scenarios that `pnpm bench` runs
  against a two-instance Compose stack, results committed in `bench/results/`, and
  `docs/benchmarks.md` generated from them and checked in CI. The owner tags `m9-done`.
- M10 (AWS deployment and final docs) is built at zero cost: the SQS event bus and its worker
  consumer (tested against LocalStack), Terraform for a demo and a full setup (tested with a
  mocked provider, **never applied**), `docs/aws-deployment.md`, `docs/trade-offs.md`, the README
  sections and a Postgres-outage test. The acceptance checks that need an AWS account are open
  in PLAN-NOTES.
- Accepted decisions are ADR 001–023; ADR 020 is the dashboard design system (tokens, shell,
  shared components and the "not measured" rule), ADR 021 the Playground page (in the
  dashboard, which the gateway serves at `/dashboard/`) and CORS for `/v1`, ADR 022 the AWS
  layout and ADR 023 the SQS event bus.

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

- [x] Unit tests for metric recording, and a cardinality test that feeds many random models,
      paths and IDs and fails if any metric exceeds its series bound or uses a label outside the
      allow-list.
- [x] Integration test: real requests through the mock provider, then a scrape of `/metrics`
      shows the counters moved; `/metrics` rejects a missing or wrong token and serves the right
      one.
- [x] A test checks that every metric queried in the Grafana dashboard JSON is registered by the
      code; CI validates the Prometheus config with `promtool check config`.
- [x] One request ID can be followed through gateway and worker logs by a single trace ID.
- [x] Stopping the worker makes stream lag rise visibly on the Infrastructure page.
- [x] The observability profile was started once, Prometheus showed both targets up and the
      dashboard rendered real series, then the profile was stopped.
- [x] All four CI jobs green; Render live on the last commit with `/ready` 200.
- [x] After the owner sets `METRICS_TOKEN` in the Render dashboard (Generate), Render `/metrics`
      returns 401 without it or with a wrong one, and 200 with it (404 until it is set).

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

- [x] Every number in `docs/benchmarks.md` traces to a committed k6 output file (machine facts
      to the run's `machine.json`).
- [x] The report states machine, config, duration and limitations.
- [x] Unit tests for the report generator (fixture summaries → expected markdown); it fails when
      a referenced result file is missing.
- [x] CI runs `pnpm bench:report --check`, which fails if `docs/benchmarks.md` differs from
      what the committed results generate (no hand edits).
- [x] CI green on all jobs; Render live on the last commit with `/ready` 200 (benchmarks never
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

**ADRs to write.** ADR 022 — AWS deployment layout (single-instance data tier for the demo, ALB
settings for SSE, secrets, alarms, cost bound). ADR 023 — SQS event bus adapter (standard queue,
visibility timeout, redrive to the DLQ, dedupe by `event_id`). Every row of the decision table
then has an ADR file. (Written 2026-10-31; the trade-off notes are in `docs/trade-offs.md`.)

**PLAN-NOTES rows it closes**

- 2026-10-20 M1 "No SSE keep-alive comments are sent while waiting for a slow first token…" (planned M10).
- 2026-10-20 M10 "No pre-stop delay between SIGTERM and closing the listener…" (planned M10).
- 2026-10-21 M6 "Raw `request_records`, `provider_attempts` and `usage_events` have no
  retention…" (open; revisit with M10 sizing), and the related 2026-10-20 M2 partitioning row.
- 2026-10-20 M4 "`TRUST_PROXY` must match the proxies in front of the gateway…" (open), for the
  ALB.
- 2026-10-20 M0 "Local Compose Postgres uses trust auth… Production must supply credentials"
  (by design): credentials come from Secrets Manager.

## Next milestones (M11–M17)

M0–M10 are built; M10's checks that need an AWS account stay open in PLAN-NOTES. M11–M17 come
from comparing the gateway with other open-source gateways in November 2026: LiteLLM, Portkey,
Bifrost, TensorZero, Helicone, New API, agentgateway, Plano and OmniRoute. Each milestone closes
a gap that comparison found. Everything stays at $0: free providers only, no AWS spend. Before
M11, the demo database moves off Render's free Postgres, which expires on 2026-11-19 (see the
2026-11-03 PLAN-NOTES row).

## M11 — Real providers and honest costs

**Goal.** Real free-tier providers carry the demo's traffic, and costs mean something: each
request shows its list price and what was actually billed, free-tier quotas are tracked across
instances, and budgets visibly work.

**Scope**

- More free providers, each enabled only when its key is set: Groq gpt-oss-120b, more Gemini
  free models, Mistral, NVIDIA NIM, OpenRouter `:free` models, Cloudflare Workers AI and Z.AI.
- A provider name per deployment, with prices keyed by provider instead of adapter kind.
- List cost and billed cost per request, with "saved" on the dashboard.
- Free-tier quotas and shared 429 cooldowns in Redis.
- Cheapest-first routing above a soft budget threshold.
- A cost comparison: the project's usage priced at other models' prices.
- Scheduled real traffic to the live demo from GitHub Actions.

**Acceptance**

- [x] A free-tier request shows a list cost and $0 billed (`usage-pipeline.test.ts` through the
      gateway and worker; the saving on the Overview and Cost pages in `pages.test.tsx`).
- [x] A $0.02 budget refuses requests once it is spent, and above the soft threshold the attempt
      records "cheapest first" (`budget-soft-threshold.test.ts`).
- [x] A quota skip, and a cooldown shared by two instances, are tested (`quotas.test.ts`: a mock
      with a quota of 3 requests a day is skipped on the 4th with the reason stored; a 429 on one
      instance makes the other skip a deployment that would have answered).
- [x] With no provider keys, everything still works on the mock; with only the Groq and Gemini
      keys, `chat-default` is as before (`default-models.test.ts`).
- [x] Reference-price models are never routed (`cost-comparison.test.ts`, `default-models.test.ts`).
- [x] The traffic script's dry run passes in CI.
- [ ] Each new provider called once with a real key (health check, a call, a stream, usage):
      not checked, no key was available (PLAN-NOTES).
- [ ] The scheduled traffic runs against the live demo: waits for the owner's `DEMO_BASE_URL` and
      `DEMO_API_KEY` secrets.

**ADRs to write.** List cost versus billed cost (budgets count list cost). Free-tier quotas and
shared cooldowns, including what happens when Redis is down. Written: ADR 024 and ADR 025.

**PLAN-NOTES rows it closes**

- 2026-10-21 UI "The dashboard names the provider of an `openai-compatible` deployment from its
  id…" (provider names guessed from IDs, and the Cost page grouped by adapter kind).
- 2026-10-28 Providers "GPT, Grok, DeepSeek and further Qwen models are not configured…" (no
  free DeepSeek, no `chat-variety`).

### M11 plan (2026-11-03)

Order A → G; D and E build on B. Each part is pushed in small commits and CI is checked after
each push. Model IDs, prices and free limits come only from official docs or `/models`
endpoints, with the source and the date next to each value (code comments, or
`docs/providers.md`); anything that cannot be confirmed is left out and gets a PLAN-NOTES row.

**Part A — more free providers.**

- Config: every deployment gets `providerName` (`groq`, `gemini`, `mistral`, `nvidia`,
  `openrouter`, `cloudflare`, `zai`, `ollama`, `mock`) next to its adapter kind (`provider`,
  unchanged, so existing model files keep working). It defaults to the adapter kind, so an
  unnamed `openai-compatible` deployment keeps today's price key.
- `baseUrl` may use `${VAR}` placeholders read from the environment at startup (Cloudflare's
  account ID is never committed); a deployment whose variables are unset is disabled.
- `healthCheck: "models" | "none"` per deployment (default `models`); Cloudflare's OpenAI
  endpoint answers 405 to `GET /models`, so it uses `none` and recovers on `BREAKER_OPEN_MS`.
- The usage event's attempt `provider` carries the provider name, plus `adapter` (kind). The
  worker, `PriceBook` and `cost_aware` key prices by provider name.
- Migration `0005_provider-names.sql`: re-keys the three seeded `openai-compatible` price rows
  to `groq` / `gemini` in place (the immutability trigger is disabled for that one statement;
  ids and values are unchanged, so every stored cost and `price_id` stays the same), and
  relabels past `usage_events`, `provider_attempts` and rollup rows of the default Groq and
  Gemini deployments. Costs are not touched.
- Migration `0006_provider-prices.sql`: list prices for the new deployments, inserted with
  `ON CONFLICT DO NOTHING` so hosts that never run the seed (the live demo) get them.
- Deployments: Groq `openai/gpt-oss-120b`; Gemini `gemini-3.8-flash`, `gemini-3.1-flash-lite`;
  Mistral `mistral-small-2603`, `mistral-large-4`; NVIDIA `deepseek-ai/deepseek-v4.1-flash`,
  `nvidia/nemotron-3-super-120b-a12b`; OpenRouter `google/gemma-4-31b-it:free`; Cloudflare
  `@cf/meta/llama-4-scout-17b-16e-instruct`; Z.AI `glm-4.7-flash`. Each is enabled only when
  its key (and Cloudflare's account ID) is set.
- Routes: `chat-default` (priority over real providers, mock last), `chat-fast`
  (`lowest_latency`), `chat-cheap` (`cost_aware`), `chat-variety` (`weighted`); the last three
  include the mock last-resort only where a route would otherwise be empty with no keys.
- `/admin/models` returns `providerName`, `adapter` and the base-URL host; the dashboard names
  providers from it; the Cost page groups by provider name. New providers use the letter tile
  unless a logo exists in `@lobehub/icons-static-svg` 1.95.1 (MIT, as now).
- Real checks: no provider key is set in this environment, so each is recorded "not checked:
  no key" in PLAN-NOTES.

**Part B — list price vs actually paid.**

- `billing: "free_tier" | "paid"` per deployment (default `paid`, so nothing is under-counted).
  The attempt record carries it; the worker stores `cost_micro_usd` (list, unchanged meaning)
  and a new `billed_cost_micro_usd` (0 on `free_tier`, the list cost on `paid`), both fixed at
  ingest.
- Migration `0007_billed-cost.sql`: the new usage column (history: billed = list, as every past
  request was counted), `billed_cost_micro_usd` and `unpriced_requests` on the three rollup
  tables, and the rollup view and function recreated to fill them.
- Analytics API (overview, cost) and the Overview and Cost pages show list, billed and saved
  (list − billed); a model with no price shows "no list price", never $0.
- Budgets keep counting list cost. ADR 024 records it.

**Part C — free-tier quotas and shared cooldowns.**

- Optional `quota` per deployment (`requestsPerMinute`, `requestsPerDay`, `tokensPerMinute`,
  `tokensPerDay`), from published free limits only, with sources in `docs/providers.md`.
- `QuotaBoard` (gateway, Redis Lua like the limiter): fixed UTC minute and day windows per
  deployment; a deployment whose quota would be exceeded is skipped and the reason goes on the
  next attempt (`skipped groq-gpt-oss-120b (quota: 1000 of 1000 requests today)`); when every
  deployment is skipped the request fails with 503 `quota_exhausted` and a `retry-after`.
- An upstream 429 sets `gw:cooldown:<deployment>` for its `Retry-After` or
  `PROVIDER_COOLDOWN_MS`; every instance skips it until then (checked once per candidate, so
  ADR 011's same-deployment retry is unchanged). `x-ratelimit-limit-*` / `-remaining-*` headers
  whose limit matches a configured quota raise our count to the provider's.
- Redis down: quota and cooldown checks fail open. ADR 025 records it.
- `/admin/models` returns today's use, limits and cooldown; the Models page shows a meter and
  the cooldown state; Prometheus counters for quota skips and cooldowns.

**Part D — budgets you can see working.** `projects.budget_soft_threshold_pct` (migration
`0008_budget-soft-threshold.sql`, default 80), editable in Settings → Limits and budget and
audited. Admission returns the budget's used share; at or above the threshold the router puts
the cheapest deployments first and records `budget at 82%: cheapest first`. A $0.02 budget is
tested end to end and the README shows how to set up a demo project with one.

**Part E — what it would cost elsewhere.** `model_prices.reference` (migration
`0009_reference-prices.sql`) with a few official paid prices for models never called; the
`PriceBook` and the worker ignore reference rows (tested). `GET
/admin/analytics/cost-comparison` prices the project's tokens for a range under every priced
model, sorted, with a tokenizer note; a card on the Cost page.

**Part F — scheduled real traffic.** `scripts/traffic.mjs` (varied routes, streaming and not,
small `max_tokens`, one repeated prompt, waits up to 2 minutes for a sleeping host,
`--dry-run`), `.github/workflows/traffic.yml` (every 2 hours and on demand, skipped on forks and
when `DEMO_API_KEY` / `DEMO_BASE_URL` are missing, short timeout); CI runs the dry run. Docs
compare the daily totals with each provider's free limits.

**Part G — wrap-up.** README (real-providers table with free limits, sources and dates; costs,
quotas, scheduled traffic; unpooled Postgres URL for migrations), `.env.example`, PLAN-NOTES
(close the rows above and the 2026-11-03 Render row: the demo's `DATABASE_URL` moved to Neon on
2026-11-03), ticked acceptance checks.

**Decisions to review** (also in PLAN-NOTES): list prices for free endpoints come from the
model maker's own paid API price when it sells one (DeepSeek for NVIDIA's DeepSeek), else from
OpenRouter's paid listing of the same model (`/api/v1/models`), else none; only one OpenRouter
`:free` deployment, because OpenRouter's free limit (20/min, 50/day without credits) is per
account, not per model; NVIDIA, Mistral, Gemini and Z.AI publish no per-model free limits, so
they get no quota (their 429s still put them on cooldown).

## M12 — Fixes and supply-chain safety

**Goal.** Close the known problems from PLAN-NOTES and from M11's live checks, and make what CI
builds and publishes verifiable.

**Scope**

- Streamed requests that time out before their first token get a 504 (found with Gemini 3.8
  Flash in M11's live checks).
- The dead-letter fix from PLAN-NOTES: claim a retried batch with `XCLAIM ... JUSTID` before
  each wait.
- A per-IP limit for unknown API keys, and a short Redis cache of key IDs that do not exist.
- `x-ratelimit-*` headers on successful replies.
- A chat health check for providers whose model list can include models they will not serve.
- GitHub Actions pinned to commit SHAs with least-privilege permissions, Dependabot, an SBOM, a
  Trivy image scan, and signed images published to GHCR.

**Acceptance**

- [x] A streamed request that times out before its first token gets an HTTP 504 with a JSON
      error (`chat-completions.test.ts` through the mock, also when the timeout opens the breaker;
      `hosted-provider.test.ts` through the HTTP adapter). It did already: the reset seen in M11
      happened outside the gateway (PLAN-NOTES).
- [x] A two-worker Postgres-outage test dead-letters nothing and stores every event once
      (`postgres-outage.test.ts`).
- [x] An unknown-key flood from one IP gets 429s, without a Postgres lookup for each request
      (`unknown-keys.test.ts`: 50 unknown keys with a limit of 5 cost 5 lookups; over HTTP, 429
      with `retry-after`).
- [x] Successful replies carry the six `x-ratelimit` headers (`rate-limit-headers.test.ts`:
      from the tightest scope, on streams and cache hits too, none for a limit not set).
- [x] A deployment that lists a model but will not serve it fails its chat health check
      (`chat-health-check.test.ts`: its breaker stays open, while a `models` check of the same
      provider half-opens; unit tests in `routing/health.test.ts`).
- [x] Every action is pinned to a SHA and Dependabot is configured. CI produces an SBOM and a
      Trivy result, and the image on GHCR verifies with cosign (CI run for `84fe3ae`: the
      `gateway-sbom-and-scan` artifact, no fixable CRITICAL finding, and `cosign verify` with the
      workflow's identity passed on `ghcr.io/naveenk2608/ai-gateway@sha256:89c83ccf…`).

**PLAN-NOTES rows it closes**

- 2026-10-31 M10 "Found while writing the Postgres-outage test… with two or more workers on the
  Redis Stream…".
- 2026-10-20 M4 "Requests with unknown API key IDs are not rate-limited per client IP…".
- 2026-10-20 M4 "No `x-ratelimit-limit/remaining/reset` headers on successful responses…".
- Updates: 2026-10-21 M6 "Requests with an invalid, revoked or expired API key…" (its per-IP
  part), 2026-11-04 M11 "Health checks use `GET /models`…", 2026-11-04 M11 "Gemini 3.8 Flash…",
  and 2026-10-31 M10 "The instances' first-boot scripts…" (a pre-built image now exists).

### M12 plan (2026-11-05)

Order A → G. Each part is pushed in small commits, and CI is checked after each push. The local
machine has little free memory, so formatting and syntax are checked per file locally and CI runs
lint, typecheck and the test suites. Versions and digests come only from each project's official
repository or registry, with the version next to every pin.

**Part A — streamed timeouts.** Integration tests in `apps/gateway/test/chat-completions.test.ts`:

- A streamed request to a deployment that never sends its first event gets 504 `upstream_timeout`
  as JSON, and both tries are cancelled.
- With `BREAKER_FAILURE_THRESHOLD=1`, the first timeout opens the breaker, so there is no retry.
  A streamed and a non-streamed request still get the 504.
- The same through the OpenAI-compatible adapter (undici, as with Gemini), against a local HTTP
  server that takes the request and never answers.

Render's log for the reported request (2026-11-03 23:26:27 UTC) shows the gateway answering 504
after 60.0 s, without a restart. In M11's first run the gateway answered its 504s only after
120 s (a timeout plus a retry), but the client's connection had already closed at about 60 s. If
the tests pass, the reset happened between the client and the gateway, most likely in Render's
proxy. That evidence then goes to PLAN-NOTES, and the gateway is not changed.

**Part B — dead letters during a long Postgres outage.** While Postgres is down, the
`UsageConsumer` claims its batch to itself (`XCLAIM <stream> <group> <self> 0 <ids> JUSTID`)
before each wait. That resets the entries' idle time without raising their delivery count. Each
wait is capped below `WORKER_CLAIM_IDLE_MS`, so no wait outlasts a claim; the backoff would
otherwise grow to 30 s. A failed claim is logged and the retry goes on. Test, in
`apps/worker/test/postgres-outage.test.ts`: two workers, with Postgres switched off for longer than
`WORKER_MAX_DELIVERIES` × `WORKER_CLAIM_IDLE_MS`. When it comes back, every event is stored once
and nothing is dead-lettered.

**Part C — unknown API keys.** When a key is not in the in-process cache, one Lua script runs
before the Postgres lookup:

- If the client IP's unknown-key bucket (`UNKNOWN_KEYS_PER_MINUTE_PER_IP`) is empty, the request
  gets 429 with `retry-after`.
- If the key ID is cached as unknown (`UNKNOWN_KEY_CACHE_MS`), the request gets 401 without a
  lookup, and the miss counts against the bucket.
- Otherwise Postgres is asked. A miss is cached and counted.

A new key's ID is removed from that cache through the existing invalidation channel, so the key
works at once. If Redis is down, the check is skipped and the lookup goes to Postgres, as before
M12. Prometheus counts rejected and limited unknown keys, with no IP label because ADR 017 keeps
labels bounded; the IP goes in the warning log line. Closes the M4 row and updates the M6 row.

**Part D — rate-limit headers.** The ADMIT script also returns, for each RPM and TPM bucket it
took from, the limit, what is left, and the time until the bucket is full again. No extra Redis
call is made. On successful `/v1/chat/completions` replies, cache hits and streams included, the
gateway sends `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests` and
`x-ratelimit-reset-requests`, and the same three for tokens. Each set comes from the tightest scope
(the one with the least left), with resets in OpenAI's duration format (`1s`, `6m0s`). A set is
left out when no RPM or TPM limit applies. Token counts are as reserved at admission: the prompt
estimate plus the output cap. Tests and README; closes the M4 row.

**Part E — chat health checks.** A new per-deployment value, `healthCheck: "chat"`, makes the
probe one non-streamed request with `max_tokens` 1 instead of `GET /models`:

- Like every probe, it runs only while the deployment's breaker is open (ADR 012), and at most once
  per `HEALTH_CHECK_CHAT_INTERVAL_MS` per deployment.
- It counts against the deployment's quota, and is skipped when that quota is used up.
- A failed chat probe keeps the breaker open until the next probe, so the open period's timer
  does not half-open it in between.

NVIDIA's deployments use it; every other deployment keeps `models`. ADR 026; the PLAN-NOTES row
is updated.

**Part F — supply chain.**

- Every `uses:` is pinned to a full commit SHA, with its release in a comment. The SHAs are read
  from each action's official repository.
- Workflows default to `contents: read`. Only the publishing steps get `packages: write` and
  `id-token: write`.
- `.github/dependabot.yml` covers npm and github-actions: weekly, with minor and patch updates
  grouped.
- A `gateway-image` job runs after the checks pass. It builds the Dockerfile's `gateway` stage,
  writes a CycloneDX SBOM (kept as a build artifact), and scans the image with Trivy. The scan
  fails on CRITICAL vulnerabilities that have a fix, and `.trivyignore` gives a reason for each
  entry.
- On pushes to main, the job then pushes the image to `ghcr.io/naveenk2608/ai-gateway`, tagged
  with the commit SHA and `main`. It signs the digest with cosign keyless signing (GitHub's OIDC
  token, no stored key) and verifies the signature in the same job.
- Plain `docker` commands build, log in and push, so little third-party code runs with write
  access.
- README: pulling the image and `cosign verify`. ADR 027. The M10 boot-scripts row notes that a
  pre-built image now exists; the Terraform is unchanged.

**Part G — wrap-up.** README, `.env.example`, the ADRs, PLAN-NOTES rows closed or updated, ticked
acceptance checks, and an "M12 run" row with the parts done, what is left, the decisions to
review, and anything reverted or skipped.

## M13 — Tools, JSON output and embeddings

**Goal.** Agents can use the gateway: tool calls, JSON output and image input pass through with
the same limits, budgets and accounting as text, and embeddings get their own endpoint.

**Scope**

- Accept `tools`, `tool_choice`, `response_format` and image parts.
- Stream tool-call deltas.
- Count tool definitions in token estimates and budget reservations, and include them in the
  cache key.
- The mock fakes tool calls.
- `/v1/embeddings` with keys, limits, budgets and accounting.

**Acceptance**

- [x] A try the deadline cuts short doesn't count against the breaker; a try that runs its full
      timeout still does (`proxy/chat-completions.test.ts`, streamed and not: cut after 5 s of a
      60 s timeout, the breaker with a threshold of 1 stays closed; a full timeout opens it; and
      `routing/routed.test.ts`).
- [x] The OpenAI SDK's tool-calling loop works through the gateway, streaming and not, with
      `finish_reason` `tool_calls` (`test/openai-sdk-tools.test.ts`: by hand, and with
      `runTools` streamed and not; live on Groq gpt-oss-20b and Gemini 3.1 Flash-Lite).
- [x] A `json_schema` request returns JSON that matches the schema (the mock in CI:
      `test/openai-sdk-tools.test.ts`, streamed and not; live: Groq gpt-oss-20b, also streamed).
- [x] A tools request on a route with no tool-capable deployment gets a 400 before any provider
      call (`model_capability_unsupported`; the mock's request count stays 0, in
      `test/openai-sdk-tools.test.ts` and `proxy/chat-tools.test.ts`).
- [x] An embeddings request is rate-limited, budgeted, cached and recorded with its endpoint,
      tokens and cost (`test/embeddings.test.ts`: 429 `rpm_limit_exceeded`, the per-request cost
      cap, the budget period's spend, a cache hit with no upstream call, and the record's
      `endpoint`, tokens and cost through the worker; live on Gemini and Mistral).
- [x] Config validation rejects an embeddings route that mixes models or dimensions
      (`models-config.test.ts`, also the mock, and chat with embeddings either way).
- [x] CI is green, and the git log and git grep checks are clean (every M13 push; the checks ran
      before each push).

**PLAN-NOTES rows it closes**

- 2026-10-20 M1 "Unsupported OpenAI parameters are rejected with a 400…", for tools,
  `response_format` and image content (`logprobs` and `n > 1` stay rejected).
- 2026-11-05 M12 "Decision to review: `REQUEST_DEADLINE_MS`…" (its breaker part).

### M13 plan (2026-11-06)

Order A → E. Each part is pushed in small commits, and CI is checked after each push. The local
machine has little free memory, so formatting is checked per file, the typecheck per package and
only the affected unit tests run locally; CI runs lint and every suite. Model IDs, capabilities,
dimensions, limits and prices come only from each provider's official docs or pricing page, with
the URL and the date checked in `docs/providers.md`; what the docs do not clearly state counts as
unsupported. Migrations only add (new columns with defaults, new price rows).

**Part A — deadline cuts and the breaker.** A try's outcome carries the timeout's phase. A try cut
by `REQUEST_DEADLINE_MS` that ran for less than its deployment's `timeoutMs` is neutral: no breaker
failure (`onNeutral`, which also frees a half-open trial), no latency sample and no cooldown. Its
attempt is still stored as `timeout`, and the client still gets the 504. A try that ran its full
`timeoutMs` counts as before. Unit tests in `routing/routed.test.ts` and
`proxy/chat-completions.test.ts`, streamed and not: a try cut after 5 s of a 60 s timeout (failure
threshold 1) leaves the breaker closed with no failure counted; a try that runs its whole timeout
opens it. A dated note in ADR 012, and the PLAN-NOTES row is closed.

**Part B — tools, JSON output and images on `/v1/chat/completions`.**

- Schema: messages become a union by role. `system` and `developer` take text; `user` takes text
  and `image_url` parts (an `https:` URL or a `data:image/...;base64` URL, with `detail`);
  `assistant` takes text or null content with `tool_calls` (and `refusal: null`, so the SDK's loop
  can send a reply back as it got it); `tool` takes `tool_call_id`. The request takes `tools`
  (functions only: name, description, `parameters`, `strict`), `tool_choice`, `parallel_tool_calls`
  and `response_format` (`text`, `json_object`, `json_schema` with name, schema and strict).
  Checks: `tool_choice` and `parallel_tool_calls` need `tools`, a named `tool_choice` must name a
  listed tool, and the number of images and the size of each `data:` URL are capped (400 above).
  `functions`, `function_call` and the `function` role get a 400 that says to use `tools`. Anything
  else stays a 400.
- Provider seam: the normalized request carries tools, tool choice, parallel calls, the response
  format, tool calls, tool-call IDs and image parts; results carry `toolCalls`; streams yield
  tool-call deltas; `finishReason` gains `tool_calls`.
- Adapters: openai-compatible sends the fields and reads `message.tool_calls` and
  `delta.tool_calls`, as pieces or as a whole call in one chunk, with or without `index`. One shared
  accumulator gives every call an ID (a generated `call_…` when the provider sends none) and emits
  each call's ID and name before its argument pieces. A table keyed by the provider name adapts what
  a provider's docs say it rejects or limits: the field is dropped, or tool-call IDs are mapped both
  ways (Mistral's documented ID format, if confirmed). Ollama maps tools, `format` (JSON or a
  schema), `images` (data URLs only; the gateway never fetches URLs) and argument objects. The mock
  answers a deterministic tool call (the named tool, else the first) whose arguments fill the
  schema's required fields, and JSON that matches a `json_schema`.
- Replies: `message.tool_calls`, `content: null` when the model only calls tools, `finish_reason`
  `tool_calls`; SSE deltas in OpenAI's shape (index, id, type and name with empty arguments first,
  then the arguments in pieces), in order.
- Capabilities: each deployment gets `capabilities` (`tools`, `json_object`, `json_schema`,
  `vision`), filled from the provider's docs for that exact model; unknown is false, the mock has
  all four. Before admission, a route keeps only the deployments that have what the request uses;
  the others are named in the first try's routing reason (`skipped x (no tools)`), like breaker
  skips. If none is left, the request gets 400 `model_capability_unsupported` naming the
  capability, before any provider call or budget reservation.
- Tokens and money: tool definitions, tool calls, tool results and JSON schemas count in the
  prompt estimate (and so in TPM and the budget reservation); each image counts a fixed estimate,
  documented in the README. Billing still uses reported usage.
- Cache: the key (version 2) adds tools, `tool_choice`, `parallel_tool_calls`, `response_format`,
  image parts, assistant tool calls and `tool_call_id`; entries keep tool calls.
- Tests: unit tests for the schema, the adapters (deltas split across chunks, whole calls in one
  chunk, ID mapping), the mock, capability routing, the estimate and the cache key; integration
  tests with the openai SDK (7.30.0): the tool-calling loop streamed and not, `json_schema`, and a
  tools request on a route without tool support (400, no upstream call).
- Docs: a README tool-calling example and a table of what each model supports; ADR 028
  (capabilities and capability-aware routing); every provider difference in `docs/providers.md`.

**Part C — `/v1/embeddings`.**

- Config: a deployment can be `"type": "embeddings"` (default `chat`) with its documented
  `dimensions`, whether (and to which sizes) the client may change them, and its documented input
  limits. Validation rejects an embeddings model whose deployments differ in model or dimensions or
  mix the mock with real ones, a chat model that lists an embedding deployment, and the reverse.
- Provider seam: `embed()` on the adapters: openai-compatible `POST /embeddings`, Ollama
  `/api/embed`, and the mock's deterministic unit vectors (seeded from a hash of the input, size
  configurable).
- `POST /v1/embeddings` in OpenAI's format (`model`, `input` as a string or strings, token arrays
  400, `encoding_format` float or base64, `dimensions` only where supported, `user`), with caps on
  the number of inputs and their total size. It goes through the same path as chat: API key and
  allow-list, admission (RPM, TPM from the estimated input tokens, the budget at the input price),
  quotas and cooldowns, breakers, retries, the deadline, the trace and the usage event.
- Records: migration 0010 adds `request_records.endpoint` (default `chat`); events carry
  `endpoint`; the worker stores it; the admin request list and detail return it; the dashboard's
  request list shows it.
- Prices: migration 0011 adds the embedding models' input prices (output 0), with sources and
  dates. Free deployments are billed `free_tier` (ADR 024).
- Deployments: embedding models from Gemini, Mistral and Cloudflare Workers AI where their docs
  show a free one, plus Ollama and the mock; each ID, size, limit and price confirmed on the
  official page first.
- Cache: exact match on project, model, inputs, dimensions and encoding format.
- `/v1/models` lists the embedding models; `scripts/traffic.mjs` sends one small embeddings
  request a run.
- Tests: unit and integration (openai SDK: one input, a batch, base64, dimensions; limits, budget,
  the request record's endpoint, tokens and cost). README section, `docs/providers.md` rows, ADR
  029 (routes that never mix models, prices, caching).

**Part D — live checks.** With `DEMO_BASE_URL` and `DEMO_API_KEY` set, wait until the demo runs the
new code (`/v1/embeddings` stops answering 404), then check through the openai SDK: a tool call on
Groq's gpt-oss-20b and a Gemini model, streamed and not; a `json_schema` answer; embeddings on
Gemini and Mistral. Each failed check is retried up to 3 times a minute apart; results go to a
PLAN-NOTES table "M13 real-provider checks". Without the values, the exact commands are written
down instead.

**Part E — wrap-up.** README, ADRs, PLAN-NOTES rows closed or updated, ticked acceptance checks, and
the "M13 run" row (parts and commits, what is left, decisions to review, anything reverted or
skipped).

## M14 — Smarter routing

**Goal.** Lowest-latency routing spreads load instead of sending everything to the single
fastest deployment, retries stay bounded during an outage, and identical requests in flight
share one upstream call.

**Scope**

- Power-of-two-choices with PeakEWMA for lowest-latency routing.
- A retry budget per deployment.
- Request coalescing for identical cacheable requests in flight.
- Quota groups: free allowances shared by several deployments of one account.

**Acceptance**

- [x] A benchmark shows traffic spread across deployments (`docs/benchmarks.md`, run
      `2026-11-08T0818Z-d5b6ba1` from the bench workflow: under `peak_ewma`, `bench-fast` served
      71.0% of requests while it was twice as fast, 20.8% once it was slowed to twice as slow; live,
      20 sequential `chat-fast` requests went to four deployments, PLAN-NOTES "M14 real-provider
      checks").
- [x] 50 identical concurrent requests make one upstream call (the same run: 5 rounds of 50, 5 calls
      that reached the mock, 245 coalesced; `test/coalescing.test.ts`; live, 1 call and 9
      coalesced for 10 requests whose arrivals overlapped).
- [x] Retries stop at the budget during a provider outage (`routing/retry-budget.test.ts`).
- [x] With `peak_ewma`, tests show traffic spread across deployments, weighted toward the faster
      one, and moving off one that slows down (`routing/peak-ewma.test.ts`: a deployment twice as
      slow gets some requests but less than a tenth of the faster one's; traffic leaves one that
      slows down within two requests; concurrent requests spread by tries in flight; an
      unmeasured deployment is tried).
- [x] In a burst of failures, retries on a deployment stay within its budget, and in quiet traffic
      a single failure still retries (`routing/retry-budget.test.ts`: 10 retries for 50 failing
      requests in one window, against 50 without the budget).
- [x] 50 identical concurrent requests make one upstream call and 50 request records, 49 of them
      marked coalesced (`test/coalescing.test.ts` against Postgres and Redis through the worker,
      some streamed; `proxy/coalesce.test.ts` for the events).
- [x] Two deployments in one quota group stop together when the shared allowance runs out
      (`test/quota-groups.test.ts` against Redis).
- [x] The bench workflow runs when started by hand and uploads its results (run 42462355941,
      `workflow_dispatch` on `d5b6ba1`, artifact `bench-results`; its run is committed).
- [x] CI is green, and the git log and git grep checks are clean (checked before every push; CI
      results in PLAN-NOTES, "M14 run").

**PLAN-NOTES rows it closes**

- 2026-11-03 M11 "Every routed try now makes one Redis round trip…" (its OpenRouter part: one
  `:free` deployment because a shared quota could not be expressed).
- 2026-11-06 M13 "Cloudflare's 10,000 free Neurons a day are per account…".

### M14 plan (2026-11-08)

Order A → G. Each part is pushed in small commits, CI is checked after each push, and a part whose
CI stays red after three fixes is reverted and recorded. The local machine has little free memory,
so formatting is checked per file, the typecheck per package and only the affected unit tests run
locally; CI runs lint and every suite. Routing state (latency estimates, tries in flight, retry
budgets, flights being coalesced) lives in each instance's memory; only quota groups are shared,
through Redis, failing open like the quotas (ADR 025). Every new behaviour has a setting that
switches it off. Defaults borrowed from an algorithm's source are cited with the URL and the date
checked (2026-11-08):

- Finagle, "Clients" guide (<https://twitter.github.io/finagle/guide/Clients.html>): Peak EWMA's
  `decayTime` defaults to 10 seconds; the default retry budget allows about 20% of requests to be
  retried on top of 10 retries per second.
- tower, `load::peak_ewma` source (<https://docs.rs/tower/latest/src/tower/load/peak_ewma.rs.html>):
  cost = estimate x (pending + 1); a sample above the estimate replaces it, a lower one moves it by
  `1 - exp(-elapsed / decay)`; the estimate decays toward 0 while it is read without new samples;
  "an arbitrary default RTT of 1 second" for an endpoint with no samples.
- Envoy, `RetryBudget` (<https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto>):
  `budget_percent` defaults to 20%, `min_retry_concurrency` to 3.
- Linkerd, "Configuring Retries" (<https://linkerd.io/2.11/tasks/configuring-retries/>): retries
  add at most 20% to the request load plus 10 retries per second; example `ttl: 10s`.

**Part A — `peak_ewma`.** A new policy; `lowest_latency` is unchanged. A per-instance tracker keeps,
per deployment, two peak-sensitive estimates (streamed: time to first token; non-streamed: the whole
response), updated as tower does, and the tries in flight (from the start of a try until its
response or stream ends, failed and cancelled tries included). Score = estimate x (in flight + 1),
with the request's own mode's estimate, else the other mode's, else `PEAK_EWMA_DEFAULT_MS` (1,000,
tower). Two different deployments are picked with the injected random; the lower score goes first,
the rest follow lowest score first; last-resort targets stay last. Breakers, quotas, cooldowns,
capability filters and the budget's cheapest-first rule apply as for every policy. Samples: a
success records its latency (streams: time to first token), a try that ran its full `timeoutMs`
records `timeoutMs`, other failures and deadline cuts record nothing. Settings: `PEAK_EWMA_ENABLED`
(true; false orders `peak_ewma` routes as `lowest_latency`), `PEAK_EWMA_DECAY_MS` (10,000, Finagle),
`PEAK_EWMA_DEFAULT_MS`. `chat-fast` switches to `peak_ewma`. Prometheus:
`gateway_peak_ewma_estimate_seconds{deployment,mode}` and `gateway_upstream_in_flight{deployment}`.
The attempt's reason names both picks and their scores. Unit tests with a manual clock and a seeded
random: a deployment twice as slow gets some traffic but less; traffic leaves one that slows down
within a few requests; concurrent requests spread by tries in flight; an unmeasured deployment is
tried. ADR 030.

**Part B — retry budget.** Per deployment and instance, retries within a sliding window may be at
most a share of its first tries in that window, or a floor, whichever is larger (Envoy's
`max(min_retry_concurrency, budget_percent x active)`, counted over Linkerd's `ttl` window instead
of in-flight requests). Settings: `RETRY_BUDGET_ENABLED` (true), `RETRY_BUDGET_RATIO` (0.2: Envoy,
Finagle and Linkerd agree), `RETRY_BUDGET_MIN_RETRIES` (3 per window: Envoy's floor; Finagle's and
Linkerd's 10 a second would allow 100 retries in a window, far more than a free tier takes) and
`RETRY_BUDGET_WINDOW_MS` (10,000: Linkerd's `ttl`). A fallback is the next deployment's first try,
so it is never limited by the budget; breakers and `RETRY_MAX_ATTEMPTS` still are. A skipped retry
moves on to the next deployment, whose reason says `retry budget used up`;
`gateway_retry_budget_skips_total{deployment}` counts them. Unit tests: a burst of failures keeps
retries within the budget; a single failure in quiet traffic still retries. A dated note in ADR 011.

**Part C — coalescing.** Requests the cache would take (chat: `cacheable()`; embeddings: not
`x-gateway-cache: off`) are coalesced on this instance by their cache key (which holds the
project), whether `CACHE_ENABLED` is on or not; `COALESCE_ENABLED` (true) switches it off. After
admission and a cache miss, the first request with a key leads and runs as usual; requests with the
same key that arrive while it runs follow and wait for its answer, each within its own
`REQUEST_DEADLINE_MS` and until its own client leaves. The upstream call follows a signal that
aborts only when nobody waits (the leader's client and every follower gone); a streamed leader whose
client leaves while followers wait is read to its end in the background, so its record still holds
the attempt and the cost. Followers are recorded like cache hits (their own record, no attempts, no
quota, zero cost) plus `request_records.coalesced` (migration 0012), answered with
`x-gateway-cache: coalesced`, and a streamed follower gets the whole answer replayed as a stream.
A leader's failure is every follower's error. `gateway_coalesced_requests_total{endpoint}`.
Integration tests with the in-process mock: 50 identical concurrent requests (some streamed) make
one upstream call and 50 records, 49 coalesced; the leader fails; the leader's client leaves while
followers wait; a follower leaves early; two projects do not share a call. ADR 031. Coalescing
across instances is a PLAN-NOTES follow-up.

**Part D — quota groups.** The models file gets `quotaGroups` (a limit per minute and/or per day in
a named unit) and deployments a `quotaGroup` (the group, plus units per request and/or per million
input and output tokens). The quota script counts the group with the deployment's own quota in one
step (reserve before a try, correct to reported usage after, fail open). A deployment whose group is
used up is skipped with a reason naming the group. Cloudflare's two deployments share one group for
the free daily Neurons, with the rates from Cloudflare's pricing page (rechecked, with the date);
the Llama deployment's derived token quota is replaced by the group. OpenRouter stays as it is, with
a note in its row. Tests: two deployments stop together; reservations are corrected; Redis down
fails open. A dated note in ADR 025.

**Part E — benchmarks.** k6 scenarios `spread` (two HTTP mocks, one slower, the faster slowed
part-way through by a settings call on the bench mock) and `coalesce` (50 identical concurrent
requests checked against the mock's counter), in `pnpm bench` and the generated report. A
`workflow_dispatch`-only workflow runs `pnpm bench` on a hosted runner and uploads `bench/results`,
with actions pinned by SHA and read-only permissions (ADR 027). If Docker can run here, the new
scenarios run and their results and the regenerated report are committed; otherwise the resume note
says so.

**Part F — live checks**, only with `DEMO_BASE_URL` and `DEMO_API_KEY`: once the demo runs the new
code, 20 sequential `chat-fast` requests (the deployment of each), and 10 identical temperature-0
requests at once (one upstream, the rest coalesced or cache hits), each retried up to 3 times a
minute apart, into a PLAN-NOTES table "M14 real-provider checks". Without them, the commands.

**Part G — wrap-up.** README (the policy, the retry budget, coalescing, quota groups and their
settings), ADRs 030 and 031, PLAN-NOTES rows, ticked checks, and the "M14 run" row.

## M15 — Control and safety

**Goal.** A client's retry is never charged twice, owners are warned before a budget runs out or
a provider fails, and routing changes without a redeploy.

**Scope**

- `Idempotency-Key` support: replay the stored result instead of running the request again.
- Signed webhook alerts (budget at 50/80/100%, breaker opened, dead letters growing), delivered
  and retried by the worker.
- Routing edited from the dashboard, stored with a version and reloaded by every instance
  through Redis.

**Acceptance**

- [ ] A retried request with the same key is charged once.
- [ ] A failed alert is retried and delivered.
- [ ] A routing change shows on two instances within seconds.

**PLAN-NOTES rows it closes**

- 2026-10-21 M7 "Deployments and routing policies are shown read-only in Settings…" (the editing
  part).

### M15 plan (2026-11-09)

Order A → G, each part pushed in small commits with CI checked after each push; a part still red
after three fixes is reverted and recorded. Locally: formatting per file, the typecheck per package,
lint of changed files and the affected tests (CI runs everything). Every new behaviour has a setting
that switches it off; nothing new stores large or long-lived data in Redis. Migrations only add
(0013 onward). Sources, checked 2026-11-09:

- IETF draft "The Idempotency-Key HTTP Header Field", version -08 of 2026-10-22
  (<https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>): the field is an
  RFC 9651 Item whose value MUST be a String (quoted, printable ASCII, only `\"` and `\\`
  escaped; <https://www.rfc-editor.org/rfc/rfc9651.html#name-strings>); 409 while the first
  request is still processed; 422 when a key is reused with a different payload; the fingerprint
  and the expiry policy are the server's to define and publish. The draft names no replay header.
- Stripe (<https://docs.stripe.com/error-low-level>, <https://docs.stripe.com/api/idempotent_requests>):
  a replay carries `Idempotent-Replayed: true`; keys are kept for at least 24 hours; keys are up to
  255 characters.

**Part A — deployments that always fail.** A failed try of a kind that shows the deployment could
not serve (rate limited, server error, connection, invalid response, auth, not found, and timeouts
as before) records a penalty sample of the deployment's `timeoutMs`; rejected requests (400s),
cancelled tries and deadline cuts record nothing. With no new samples, an estimate (the default one
included) moves toward `PEAK_EWMA_DEFAULT_MS` at the same rate instead of toward zero:
`E' = D + (E - D) x exp(-elapsed / decay)`. One setting, `PEAK_EWMA_PENALIZE_FAILURES` (true; false
restores M14's rules). Unit tests with a seeded random: a deployment that always answers 429 at once
is first in the plan far less often than under M14's rules (numbers in the test and the ADR note); it
gets traffic again once it recovers; a fast, healthy deployment still wins most picks. Dated note in
ADR 030.

**Part B — a memory cap for the response cache.** Before a store, the cache reads `used_memory` and
`maxmemory` from `INFO memory` (at most every `CACHE_MEMORY_CHECK_INTERVAL_MS`) and stores only while
used memory is below `CACHE_MAX_MEMORY_SHARE` of `maxmemory` (default 0.5), or below
`CACHE_MAX_MEMORY_BYTES` when `maxmemory` is 0. If INFO fails or is not allowed, nothing is stored and
it is logged once. Lookups keep working; a skipped or failed store never fails the request.
`CACHE_MEMORY_GUARD_ENABLED` (true) switches the check off. Metrics: a counter of skipped stores by
reason and a gauge of the last reading. Unit tests with fake INFO replies; README: when
`CACHE_ENABLED` is safe on a small Redis with `noeviction`.

**Part C — `Idempotency-Key`.** On `POST /v1/chat/completions` and `/v1/embeddings`, after admission
and before the cache and coalescing. Parsed as the draft's String (1 to 255 characters, Stripe's
limit); anything else is 400 `invalid_idempotency_key`. A key belongs to (project, endpoint). The
fingerprint is a SHA-256 of the body without `stream`, `stream_options` and `user`, with object keys
sorted; a different fingerprint is 422 `idempotency_key_reused`. Keys live in a new table
`idempotency_keys` (migration 0013) with a unique (project, endpoint, key): the first request inserts
it `in_progress` with its instance and a lock time; a 2xx answer is stored as the answer itself (the
cache entry's form, so a replay can be JSON or a stream) with its status and replay headers, up to
`IDEMPOTENCY_MAX_BODY_BYTES`; above the cap the key is kept as completed without a body and a repeat
gets 409 `idempotency_answer_not_stored` (never a second call); a failure deletes the key. With a key,
a client that leaves does not cancel the upstream call: it runs within its timeouts and the request
deadline (a stream is read to its end), then is stored and accounted for (recorded `canceled` with
its cost, as a coalescing leader whose client left). A repeat while the first runs waits for it on
the same instance (a coalescing `Flight`); if the first runs elsewhere, or the wait would pass the
repeat's deadline, 409 `idempotency_key_in_progress` with `retry-after`. A lock older than
`IDEMPOTENCY_LOCK_MS` is taken over (a crashed instance). A replay is answered like a cache hit,
recorded at zero cost with `request_records.replayed` (migration 0013) and `Idempotent-Replayed:
true`. Keys expire after `IDEMPOTENCY_KEY_TTL_HOURS` (24, Stripe) and the worker deletes expired rows
in batches. `IDEMPOTENCY_ENABLED` (true) switches it off (the header is then ignored). Integration
tests: one call and one charge for two requests; 422; two at once; a client leaving mid-stream; a
failure releasing the key; expiry; two projects with one key. ADR 032.

**Part D — webhook alerts.** Tables (migration 0014): `alert_destinations` (project, name, kind
`discord` / `slack` / `generic`, the URL and the signing secret encrypted with AES-256-GCM, a masked
URL hint, events) and `alert_deliveries` (the outbox: a unique dedupe key per destination, payload,
status, attempts, next try, last error without the URL). The key is `ALERTS_ENCRYPTION_KEY` (32 bytes,
base64), else HKDF-SHA256 from `API_KEY_PEPPER` with its own label, so the demo needs no new setting
(changing the pepper means entering the URLs again). Events: monthly spend crossing 50, 80 and 100% of
the budget (once per threshold per month, detected by the worker where it adds spend, in the same
transaction); a breaker opening (detected by the gateway, at most once per deployment per
`ALERTS_BREAKER_INTERVAL_MS`); dead letters growing (detected by the worker, at most once per
`ALERTS_DEAD_LETTER_INTERVAL_MS`). Budget events go to that project's destinations; breaker and
dead-letter events to every destination that chose them. The worker sends due rows (`FOR UPDATE SKIP
LOCKED`), retrying with exponential backoff and full jitter up to `ALERTS_MAX_ATTEMPTS`, then marks
them failed. Discord and Slack get their incoming-webhook formats from their official docs; generic
receivers get JSON signed with HMAC-SHA256 over the timestamp and the body, following a published
webhook-signing spec for the header names (cited in the ADR), with a per-destination secret shown
once. SSRF: https only, the host resolved before each send and private, loopback, link-local,
unique-local, CGNAT and metadata addresses refused, the connection pinned to the checked address, no
redirects, a short timeout, at most a few KiB of the reply read. `ALERTS_ENABLED` (true; nothing is
sent without a destination). Admin API (admins write, viewers read) and a Settings section with
recent deliveries and "send test". Tests: each threshold once; a failed delivery retried then
delivered; a signature verifies and a changed body or an old timestamp fails; the SSRF cases refused.
ADR 033.

**Part E — routing edited from the dashboard, per project.** A new table `route_overrides`
(migration 0015): each change is a version (project, model, version, the full route or null for a
reset, the action, who, when). A project admin may change a file route's policy and targets (order,
weights, last resort) using only deployments that route lists; validated with the models file's rules.
Rollback writes a new version copying an old one; reset writes a null route (the file's route).
Every change is audited. Each instance keeps the active overrides in memory, loads them at start
(Postgres down: the file, retried), reloads a project's when a `routes` message arrives on the
existing invalidation channel, and reloads all every `ROUTE_OVERRIDES_REFRESH_MS` in case a message is
lost. `ROUTE_OVERRIDES_ENABLED` (true). Admin API: read, change, roll back, reset, history (viewers
read only); an editor with history and rollback on the Models page. The unused `routing_policies`
table is left alone. Tests: two gateway instances sharing Redis and Postgres (a change through one is
used by the other within seconds, and within the interval when the message is lost), rollback, reset,
an invalid override, a viewer refused; a browser test for the editor. ADR 034.

**Part F — live checks** with `DEMO_BASE_URL` and `DEMO_API_KEY`: the same chat request twice with
one key (the second replayed, same body), then a different body with it (422), retried up to 3 times
a minute apart, into "M15 real-provider checks"; steps for the owner to try a Discord alert and the
routing editor.

**Part G — wrap-up.** README, ADRs 032 to 034, PLAN-NOTES rows, ticked checks, the "M15 run" row.

## M16 — Guardrails

**Goal.** Per-project checks keep sensitive values from reaching a provider and catch JSON
answers that break their schema, and every action taken is recorded.

**Scope**

- Per-project checks before the model: mask emails, phone, card, Aadhaar and PAN numbers;
  blocked words; a prompt size cap.
- After the model: a JSON schema check.
- Actions block, mask or flag; each is recorded per request and shown on the Security page.

**Acceptance**

- [ ] Masked values never reach the provider (a test asserts it).
- [ ] Flags show on the dashboard.
- [ ] The approach for streamed answers is recorded in an ADR.

**ADR to write.** Guardrails on streamed answers: how the after-model checks apply when part of
the answer has already been sent.

## M17 — Cloud and operations

**Goal.** The gateway runs on Kubernetes from a chart CI has tested, one request can be followed
as a trace through gateway, provider and worker, alerts follow SLOs, and the raw request tables
stop growing without bound.

**Scope**

- A Helm chart tested in CI on a kind cluster (probes, autoscaling, pre-stop delay).
- OpenTelemetry spans to a local Jaeger.
- SLOs with burn-rate alert rules, checked by promtool.
- Monthly partitions and retention for the raw request tables.

**Acceptance**

- [ ] CI installs the chart on kind and passes a smoke test.
- [ ] A trace shows gateway, provider and worker.
- [ ] Old partitions are dropped on schedule.

**ADR to write.** Tracing with the OpenTelemetry SDK, superseding the "no tracing SDK" part of
ADR 017 (which left it out for its memory and startup cost on the free host).

**PLAN-NOTES rows it closes**

- 2026-10-21 M8 "Traces exist only as IDs in the logs…".
- 2026-10-21 M8 "The Grafana dashboard has no alert rules…".
- 2026-10-21 M6 "Raw `request_records`, `provider_attempts` and `usage_events` have no
  retention…", and the related 2026-10-20 M2 partitioning row.
- 2026-10-20 M10 "No pre-stop delay between SIGTERM and closing the listener…", on Kubernetes.

## Stretch

Pick one after M17:

- A semantic cache with a measured false-hit rate, using M13's embeddings.
- Experiments: a feedback endpoint and A/B splits between models, with quality compared per
  model.

## Not planned

- Hundreds of providers: breadth, not depth; the existing adapters already show the pattern.
- A rewrite for raw speed: model latency dominates the gateway's own milliseconds.
- Other request formats: large translation work.
- An MCP gateway, prompt management, and image, audio and realtime APIs: each is a separate
  product.
- Paid-only models: they have no free tier.

## Not scheduled

Future work with no milestone: cost-aware routing evaluated against a labelled prompt set; a
transactional outbox for usage events (closes the event-loss rows from M3 and M4); multi-region
deployment notes. PLAN-NOTES rows marked `open` that no milestone above closes stay open until
someone picks them up.
