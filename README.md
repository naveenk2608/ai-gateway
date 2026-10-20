# AI Gateway

A self-hostable, OpenAI-compatible AI gateway: auth, limits and budgets, routing with failover,
and per-request accounting. Architecture decisions are recorded in [docs/adr/](docs/adr/).

**Status: M3 (usage accounting).** `POST /v1/chat/completions` works in OpenAI format,
streaming and non-streaming, in front of a deterministic mock provider, Ollama, or any
OpenAI-compatible API. Callers authenticate with per-project API keys; an admin API (session
login, roles, key management, audit log) manages projects and keys. Every request is recorded,
with its upstream attempts, tokens and cost, through a Redis Stream that the worker writes to
Postgres exactly once in effect.

## Requirements

- Node 22 LTS (`.nvmrc`), pnpm via corepack (`corepack enable`)
- Docker with Compose v2.20+
- Optional: [Ollama](https://ollama.com) for real local models

## Quick start

```bash
pnpm install
cp .env.example .env          # then set API_KEY_PEPPER=$(openssl rand -hex 32)
docker compose up -d          # Postgres 16 + Redis 7 on 127.0.0.1
pnpm db:seed                  # migrations + demo project, admin and API key (printed once)
pnpm dev                      # gateway :8080, worker, dashboard :5173

export GW_KEY=gw_...          # the key db:seed printed
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model": "mock-1", "messages": [{"role": "user", "content": "Hello"}]}'

curl -sN http://127.0.0.1:8080/v1/chat/completions \
  -H "authorization: Bearer $GW_KEY" -H 'content-type: application/json' \
  -d '{"model": "mock-1", "stream": true, "messages": [{"role": "user", "content": "Hello"}]}'
```

Run everything in containers instead:

```bash
docker compose --profile full up -d --build
curl -i http://127.0.0.1:8080/ready   # gateway
# dashboard: http://127.0.0.1:3000, API docs: http://127.0.0.1:8080/docs
```

### With the OpenAI SDK

Point any OpenAI client at the gateway; nothing else changes.

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: process.env.GW_KEY });
const stream = await client.chat.completions.create({
  model: 'mock-1',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta.content ?? '');
```

## Models

Clients send a logical model name; [apps/gateway/config/models.json](apps/gateway/config/models.json)
maps each name to a deployment (a provider, its own model name and timeouts). Set
`MODELS_CONFIG_PATH` to use another file. The file is validated at startup.

| Provider | Talks to | Notes |
| --- | --- | --- |
| `mock` | nothing (in-process) | Deterministic; timing and failures come from config. |
| `ollama` | Ollama's `/api/chat` | `baseUrl` defaults to `OLLAMA_BASE_URL`. |
| `openai-compatible` | any `/v1/chat/completions` API | `apiKeyEnv` names the variable holding the key; without it the deployment is disabled. |

The default file ships mock models for every scenario (`mock-1`, `mock-slow`,
`mock-rate-limited`, `mock-error`, `mock-flaky`, `mock-drop`), `llama3.2` on Ollama and
`gpt-4o-mini` on OpenAI (enabled only when `OPENAI_API_KEY` is set).

Mock settings: `latencyMs` (non-streaming delay), `ttftMs` (time to first token),
`tokensPerSecond`, `completionTokens`, `errorRate` with `seed` (repeatable failures), `failWith`
(`429` or `500`), `retryAfterMs` and `dropAfterTokens` (mid-stream drop).

Timeouts, per deployment: `timeoutMs` bounds a non-streaming call, or the wait for a stream's
first token; `streamIdleTimeoutMs` bounds the silence between tokens after that. A client that
disconnects cancels the upstream call.

## Endpoints

| Endpoint | Meaning |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions. `stream: true` returns SSE chunks ending with `data: [DONE]`; `stream_options.include_usage` adds a usage chunk. |
| `/admin/...` | Admin API for the dashboard; see [Admin API](#admin-api). |
| `GET /docs` | Swagger UI; the OpenAPI 3.1 spec is at `/docs/json`. **Authorize** with an API key to try `/v1` from the page. |
| `GET /health` | Process is up. Always 200 while the server runs. |
| `GET /ready` | 200 when Postgres and Redis both answer within `READY_CHECK_TIMEOUT_MS`, else 503 with the failing check. |

The request body accepts OpenAI's text chat parameters (`messages`, `max_tokens` or
`max_completion_tokens`, `temperature`, `top_p`, `stop`, `seed`, penalties, `user`) and rejects
anything else (tools, `response_format`, images, `n > 1`) with a 400 naming the field. Bodies
over 1 MiB get 413.

Every response carries a server-generated `x-request-id` (UUIDv7); every log line for that request
carries the same `requestId`, and each upstream call is logged once with its `attemptId`.

### Errors

Errors use the OpenAI shape `{"error": {"message", "type", "param", "code"}}` and never include
stack traces or the provider's own error text. `x-should-retry` tells OpenAI SDKs whether a retry
can help, and upstream rate limits pass on `Retry-After`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | The body failed validation. |
| 401 | `invalid_api_key` | Missing, unknown, revoked or expired API key. |
| 403 | `model_not_allowed` | The model is outside the project's allow-list. |
| 404 | `model_not_found` | No such model, or its deployment is disabled. |
| 429 | `upstream_rate_limited` | The provider rate-limited the call. |
| 502 | `upstream_error`, `upstream_unavailable`, `upstream_invalid_response`, `upstream_auth_failed`, `upstream_model_not_found` | The provider failed, could not be reached, or is misconfigured. |
| 504 | `upstream_timeout` | The deployment's timeout passed. |

A failure after a stream has started is sent as a final `{"error": ...}` event, and the stream
ends without `[DONE]`.

On SIGTERM the gateway stops accepting connections, lets in-flight requests and streams finish,
then closes its pools. `SHUTDOWN_TIMEOUT_MS` bounds the whole shutdown; if it passes, remaining
connections are closed and the process exits with code 1.

## API keys and the admin API

Keys look like `gw_<keyId>_<secret>` (ADR 006). Only an HMAC-SHA256 of the secret, keyed with
`API_KEY_PEPPER`, is stored; the full key is shown once, when it is created. Each instance caches
a verified key for `API_KEY_CACHE_TTL_MS` (30 s): revoking or rotating a key tells every instance
through Redis pub/sub, and the TTL bounds how long a key can outlive its revocation if that
message is lost. Rotation returns a new key and keeps the old one working for a grace period
(`gracePeriodSeconds`, default `API_KEY_ROTATION_GRACE_SECONDS`). A project's `allowedModels`
limits which logical models its keys may call (`null` allows all).

### Admin API

The dashboard's API (ADR 007). `POST /admin/auth/login` with an email and password sets an
HTTP-only, `SameSite=Strict` session cookie; every other admin route requires it. Roles are per
project: `viewer` reads, `admin` also manages keys and settings, `owner` also manages members.

| Route | Role |
| --- | --- |
| `POST /admin/auth/login`, `POST /admin/auth/logout`, `GET /admin/me` | any user |
| `GET /admin/projects`, `POST /admin/projects` (creator becomes owner) | any user |
| `GET /admin/projects/:projectId` | viewer |
| `PATCH /admin/projects/:projectId` (name, `allowedModels`) | admin |
| `GET /admin/projects/:projectId/members` | viewer |
| `POST`, `PATCH`, `DELETE /admin/projects/:projectId/members[/:userId]` | owner |
| `GET /admin/projects/:projectId/api-keys` | viewer |
| `POST /admin/projects/:projectId/api-keys`, `.../:apiKeyId/revoke`, `.../:apiKeyId/rotate` | admin |
| `GET /admin/projects/:projectId/audit-logs` | admin |
| `GET /admin/requests/:requestId` (the `x-request-id` header): request, usage, attempts | viewer |

A project the caller does not belong to answers 404, exactly like one that does not exist. Every
change writes an `audit_logs` row in the same transaction, tagged with the request ID.

## Usage accounting

Each `/v1` request that passes authentication and validation becomes one `request.completed`
event: the request (status, timings, error code), one record per upstream attempt (its
`attemptId`, deployment, outcome) and its tokens. The gateway hands the event to a bounded
in-memory buffer and returns; a background loop writes it to the Redis Stream `EVENTS_STREAM`.
If Redis is down, events wait in the buffer (`EVENTS_BUFFER_MAX`) and are retried; past that they
are dropped and counted in the logs. Events carry counts and timings, never prompts or output.

The worker (ADR 014) reads the stream in a consumer group, writes each batch (request record,
attempts, usage row) in one transaction with `ON CONFLICT DO NOTHING`, and acknowledges only
after the commit. So a crash re-delivers instead of losing, and a re-delivery changes nothing.
Entries a dead worker left behind are claimed after `WORKER_CLAIM_IDLE_MS`; an entry delivered
more than `WORKER_MAX_DELIVERIES` times goes to `EVENTS_DLQ_STREAM` and the `failed_events`
table without holding up the others. While Postgres is unreachable the worker retries in place.

`usage_source` says where the tokens came from: `reported` by the provider, `estimated` by the
gateway (about four characters per token) when a stream was cut off or the provider sent no
counts, or `missing` when nothing was produced. Cost, in integer micro-dollars, uses the
`model_prices` version in effect when the request started (ADR 016); price rows cannot be edited,
so a price change is a new row and past costs never move. `pnpm db:seed` adds demo prices for
the mock provider.

### Database

Plain-SQL migrations live in [db/migrations](db/migrations) (node-pg-migrate, ADR 003). The
gateway applies pending ones at startup (`MIGRATE_ON_START`), holding a Postgres advisory lock so
that instances starting together migrate once; `pnpm db:migrate` does the same by hand.

### Hosted setup with no shell (Render)

Some hosts (Render's free plan) have no shell or one-off jobs. Everything needed runs at startup:
migrations, and an optional bootstrap from environment settings that creates a project, an owner
and an API key if they are missing (existing users, passwords and keys are never changed):

| Variable | Purpose | Value |
| --- | --- | --- |
| `API_KEY_PEPPER` | Secret for API-key hashes (required) | `openssl rand -hex 32`, or Render's *Generate* |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | First owner, to log in to `/admin` | your email; a password of 12+ characters |
| `BOOTSTRAP_API_KEY` | First API key, to call `/v1` | `pnpm key:generate` on your machine |
| `BOOTSTRAP_PROJECT_NAME` | Name of that project (optional) | default `Default project` |
| `RUN_WORKER_IN_PROCESS` | Run the usage consumer inside the gateway (no worker service) | `true` |

Then open `/docs`, click **Authorize**, paste the key, and call `POST /v1/chat/completions`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Gateway and worker with `tsx watch`, dashboard with Vite; loads `.env` if present |
| `pnpm build` | Compile all packages (`dist/`) and build the dashboard |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:int` | Integration and SDK contract tests; needs `docker compose up -d` |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc`, Prettier |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:seed` | Migrations plus a demo project, admin and API key (printed once) |
| `pnpm key:generate` | Print a new random API key, e.g. for `BOOTSTRAP_API_KEY` |

Configuration is read from environment variables and validated at startup; see
[.env.example](.env.example) for every variable. Invalid config exits with a message naming each
problem.

## Layout

```text
apps/gateway     Fastify API: /v1 proxy, providers, auth, /admin API, health
db/migrations    numbered plain-SQL migrations
apps/worker      usage-event consumer (also runs inside the gateway with RUN_WORKER_IN_PROCESS)
apps/dashboard   React + Vite
packages/shared  config, clock, logger, ids, Postgres/Redis clients
infra/compose    Docker Compose stack (compose.yaml at the root includes it)
docs/adr         architecture decision records
```

## Notes

- Login attempts are not rate-limited yet (limits arrive in M4); use a strong admin password.
- Local Postgres uses trust auth and every Compose port binds to 127.0.0.1, so the repo holds no
  database password. Real deployments pass credentials in `DATABASE_URL`.
- In Compose, the gateway reaches Ollama on the host at `host.docker.internal:11434`.
- The SIGTERM process tests are skipped on Windows, where signals terminate processes without
  running handlers. They run in CI (Linux).
