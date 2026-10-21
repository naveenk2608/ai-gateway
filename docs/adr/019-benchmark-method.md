# ADR 019: Benchmarks with k6 in a container, against an HTTP mock, with a generated report

- Status: accepted
- Date: 2026-10-21
- Milestone: M9

## Context

The project needs numbers for what the gateway adds to a request (latency, time to first token,
throughput) and evidence that limits, accounting and the cache stay correct under concurrent load
across instances. Numbers in documents tend to drift from what any run produced, get rounded by
hand, or lose the machine and settings they came from. A laptop or a shared cloud VM is noisy, and
the free Render service must never be load-tested.

Constraints: no paid API and no local tool installs; everything runs from the repository with
Docker. The same upstream must serve both the gateway path and the direct path, or the
difference between them measures two different servers.

## Decision

- **Upstream**: the mock provider gets an HTTP surface in OpenAI's wire format
  (`node dist/mock-server/main.js`, settings in `MOCK_SETTINGS`), wrapping the same `MockProvider`
  the gateway runs in-process. The gateway reaches it through its `openai-compatible` adapter;
  k6 calls it directly for the baseline. Both servers send response headers with the first token,
  so k6's time to first byte is the time to first token on both paths.
- **Load generator**: k6 from the pinned `grafana/k6` image, run as a one-off container on the
  bench stack's Compose network (`bench/compose.yaml`: Postgres, Redis, the mock, two gateway
  instances, one worker; no published ports).
- **Scenarios** (`bench/k6/`): overhead as closed-loop VUs (10, 50, 100) direct vs through one
  gateway, streaming and not; rate-limit accuracy across two instances against the token-bucket
  ceiling; accounting through a worker crash (Postgres paused, worker killed and restarted, then
  rows, distinct request IDs and rollups counted against requests sent); cache hit ratio for a
  repeated temperature-0 workload, cross-checked with the mock's own request counter.
- **Results are data in git**: `pnpm bench` writes each k6 summary (minus setup data, which holds
  keys) and `machine.json` (CPU, memory, OS, virtualisation, Docker, image IDs, redacted config,
  timings) into `bench/results/<run>/`, and refuses to finish if a file contains the run's
  secrets or an API key. The stack is removed with its volumes at the end.
- **The report is generated**: `pnpm bench:report` renders `docs/benchmarks.md` from the newest
  run; every table links to its source file, and derived values (added latency, ceilings,
  ratios) are computed, never typed. CI runs `pnpm bench:report --check`, which fails when the
  committed report differs from what the committed results generate or a file is missing.
- **Labelled, never generalised**: the report names the machine and says that its numbers are
  for that machine only; they are not compared with the Render service or presented as
  production capacity.

## Alternatives considered

- Benchmarking the in-process mock (no HTTP hop): the direct baseline would not exist, and the
  gateway's real upstream path (undici, SSE parsing) would be skipped.
- autocannon, wrk or a Node script: k6 gives scenarios, arrival-rate executors, percentiles and a
  JSON summary in one pinned image; wrk needs Lua for bodies and has no streaming checks.
- Running k6 in CI: shared runners are noisier than any VM and would make every push slower;
  CI checks the report against the committed results instead.
- Hand-maintained tables: they drift and cannot be checked.
- xk6-sse for token-level TTFT: needs a custom k6 build; time to first byte is equivalent here
  because both servers flush headers with the first token.

## Consequences

- Anyone with Docker can reproduce a run with `pnpm bench`; a new run replaces the report only
  when its results are committed.
- All processes share one machine, so added latency includes contention with k6 and the other
  containers. The report states this; isolating them needs separate hosts (M10's AWS setup could
  host a run).
- One run per configuration: no repetitions or confidence intervals yet.
- The accounting scenario proves no loss and no double counting across a crash; how many events
  are re-delivered depends on what the worker held when killed, and the report shows the count.
- Ollama inference speed is a separate measurement, to be reported apart from gateway overhead
  and only from a real Ollama.
