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

**Goal.** Close two known problems from PLAN-NOTES, and make what CI builds and publishes
verifiable.

**Scope**

- The dead-letter fix from PLAN-NOTES: claim a retried batch with `XCLAIM ... JUSTID` before
  each wait.
- A per-IP limit for unknown API keys.
- `x-ratelimit-*` headers on successful replies.
- GitHub Actions pinned to commit SHAs, Dependabot, an SBOM, a Trivy image scan, and signed
  images published to GHCR.

**Acceptance**

- [ ] A two-worker Postgres-outage test dead-letters nothing.
- [ ] An unknown-key flood gets 429s without a Postgres lookup each.
- [ ] The image signature verifies.

**PLAN-NOTES rows it closes**

- 2026-10-31 M10 "Found while writing the Postgres-outage test… with two or more workers on the
  Redis Stream…".
- 2026-10-20 M4 "Requests with unknown API key IDs are not rate-limited per client IP…".
- 2026-10-20 M4 "No `x-ratelimit-limit/remaining/reset` headers on successful responses…".

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

- [ ] The OpenAI SDK's tool-calling example works through the gateway, streaming and not.
- [ ] An embeddings request is recorded with its cost.

**PLAN-NOTES rows it closes**

- 2026-10-20 M1 "Unsupported OpenAI parameters are rejected with a 400…", for tools,
  `response_format` and image content (`logprobs` and `n > 1` stay rejected).

## M14 — Smarter routing

**Goal.** Lowest-latency routing spreads load instead of sending everything to the single
fastest deployment, retries stay bounded during an outage, and identical requests in flight
share one upstream call.

**Scope**

- Power-of-two-choices with PeakEWMA for lowest-latency routing.
- A retry budget per deployment.
- Request coalescing for identical cacheable requests in flight.

**Acceptance**

- [ ] A benchmark shows traffic spread across deployments.
- [ ] 50 identical concurrent requests make one upstream call.
- [ ] Retries stop at the budget during a provider outage.

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
