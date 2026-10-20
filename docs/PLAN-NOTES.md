# Plan notes

Deferred work, open questions and known issues found while building. Newest first.

| Date | Milestone | Note | Status |
| --- | --- | --- | --- |
| 2026-10-20 | M1 | `POST /v1/chat/completions` is unauthenticated until API keys arrive in M2; the gateway binds to 127.0.0.1 by default. | planned M2 |
| 2026-10-20 | M1 | The Ollama and OpenAI-compatible adapters are verified only against local fake servers that follow each documented wire format. No real Ollama (not installed on the dev machine) or paid API was called. Next: a smoke test against a real Ollama. | open |
| 2026-10-20 | M1 | The mock provider runs in-process, so its settings and counters are per gateway instance. M5 ("mock heals" at runtime) and M9 (direct-to-mock benchmark) need a control or HTTP surface for it. | planned M5/M9 |
| 2026-10-20 | M1 | Unsupported OpenAI parameters are rejected with a 400 naming the field: tools/function calling, `response_format`, `logprobs`, image content, `n > 1`. `GET /v1/models` is not implemented. Add when a client needs them. | open |
| 2026-10-20 | M1 | Upstream 400s reach clients as a generic `upstream_rejected_request`. Known upstream codes (e.g. context length exceeded) could map to specific safe messages. | open |
| 2026-10-20 | M1 | Usage is null when a provider omits counts (Ollama with a cached prompt) or a stream is interrupted; M3 records these as `estimated` or `missing`. | planned M3 |
| 2026-10-20 | M1 | No SSE keep-alive comments are sent while waiting for a slow first token; proxies with short idle timeouts (the ALB in M10) may need them. | planned M10 |
| 2026-10-20 | M1 | `pnpm typecheck` runs packages one at a time because parallel `tsc` ran out of memory on the 8 GB dev machine. | by design |
| 2026-10-20 | M0 | CI workflow (`.github/workflows/ci.yml`) passed on GitHub for commit `0d8c049`: lint/typecheck/unit tests/build, integration tests (Postgres + Redis) and container images all green. | done |
| 2026-10-20 | M0 | Toolchain pins below latest: TypeScript 6.0.3 (typescript-eslint 8.72 supports `<6.1`; TS 7 is out) and pnpm 10.34.7 (corepack 0.32 bundled with Node 22.16 cannot run pnpm 12). Revisit when typescript-eslint supports TS 7. | open |
| 2026-10-20 | M1 | Drain marks responses `Connection: close` in `onSend`. SSE responses send headers before a drain can start, so M1 must end or flag streams on drain itself (and the drain timeout must cover long streams). Resolved: a stream that started before the drain finishes, then its socket is closed (tested); `SHUTDOWN_TIMEOUT_MS` still bounds long streams. | done |
| 2026-10-20 | M1 | ADR 002 (Fastify + Zod + OpenAPI) file is written in M1 with the OpenAPI work; M0 already uses Fastify. Written, with ADR 004 (undici, abort per attempt). | done |
| 2026-10-20 | M2 | Root script `db:migrate` is added with the first migrations (node-pg-migrate, ADR 003). | planned M2 |
| 2026-10-20 | M3 | Worker has no consumer yet; it holds the Postgres pool and Redis client the consumer will use. The pg pool's client-side query timeout defaults to 5 s; batch inserts may need a larger value. | planned M3 |
| 2026-10-20 | M5 | Dashboard libraries from ADR 018 (TanStack Query/Table, Recharts) are added with the pages that need them. | planned M5/M7 |
| 2026-10-20 | M8 | ADR 017 file (observability) is written in M8; M0 provides pino JSON logs with `requestId` only. | planned M8 |
| 2026-10-20 | M9 | Root script `bench` is added with the k6 scripts. | planned M9 |
| 2026-10-20 | M10 | No pre-stop delay between SIGTERM and closing the listener. Behind an ALB, rely on target deregistration delay; revisit if the load balancer keeps routing to a draining instance. | planned M10 |
| 2026-10-20 | M0 | Local Compose Postgres uses trust auth bound to 127.0.0.1 so no password is committed. Production must supply credentials in `DATABASE_URL` (Secrets Manager, M10). | by design |
| 2026-10-20 | M0 | On this Windows machine, `pnpm` scripts launched from Git Bash fail (`'node' is not recognized` under cmd); they work from PowerShell. SIGTERM tests skip on win32 by design. | known |
