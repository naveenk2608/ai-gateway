# AI Gateway

A self-hostable, OpenAI-compatible AI gateway: auth, limits and budgets, routing with failover,
and per-request accounting. Architecture decisions are recorded in [docs/adr/](docs/adr/).

**Status: M0 (foundation).** The gateway serves `/health` and `/ready`, the worker is a process
shell, and the dashboard shows live gateway readiness. The proxy endpoint arrives in M1.

## Requirements

- Node 22 LTS (`.nvmrc`), pnpm via corepack (`corepack enable`)
- Docker with Compose v2.20+

## Quick start

```bash
pnpm install
cp .env.example .env          # optional: defaults match the Compose stack
docker compose up -d          # Postgres 16 + Redis 7 on 127.0.0.1
pnpm dev                      # gateway :8080, worker, dashboard :5173
curl -i http://127.0.0.1:8080/ready
```

Run everything in containers instead:

```bash
docker compose --profile full up -d --build
curl -i http://127.0.0.1:8080/ready   # gateway
# dashboard: http://127.0.0.1:3000
```

## Endpoints (M0)

| Endpoint | Meaning |
| --- | --- |
| `GET /health` | Process is up. Always 200 while the server runs. |
| `GET /ready` | 200 when Postgres and Redis both answer within `READY_CHECK_TIMEOUT_MS`, else 503 with the failing check. |

Every response carries a server-generated `x-request-id` (UUIDv7); every log line for that request
carries the same `requestId`. Errors use the OpenAI error shape and never include stack traces.

On SIGTERM the gateway stops accepting connections, lets in-flight requests finish, then closes
its pools. `SHUTDOWN_TIMEOUT_MS` bounds the whole shutdown; if it passes, remaining connections
are closed and the process exits with code 1.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Gateway and worker with `tsx watch`, dashboard with Vite; loads `.env` if present |
| `pnpm build` | Compile all packages (`dist/`) and build the dashboard |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:int` | Integration tests; needs `docker compose up -d` |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc`, Prettier |

Configuration is read from environment variables and validated at startup; see
[.env.example](.env.example) for every variable. Invalid config exits with a message naming each
problem.

## Layout

```text
apps/gateway     Fastify API (/health, /ready; /v1 proxy from M1)
apps/worker      background process (usage consumer from M3)
apps/dashboard   React + Vite
packages/shared  config, logger, ids, Postgres/Redis clients
infra/compose    Docker Compose stack (compose.yaml at the root includes it)
docs/adr         architecture decision records
```

## Notes

- Local Postgres uses trust auth and every Compose port binds to 127.0.0.1, so the repo holds no
  database password. Real deployments pass credentials in `DATABASE_URL`.
- The SIGTERM process tests are skipped on Windows, where signals terminate processes without
  running handlers. They run in CI (Linux).
