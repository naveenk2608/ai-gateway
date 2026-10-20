# AI Gateway

A self-hostable, OpenAI-compatible AI gateway: auth, limits and budgets, routing with failover,
and per-request accounting. Architecture decisions are recorded in [docs/adr/](docs/adr/).

**Status: M1 (core proxy).** `POST /v1/chat/completions` works in OpenAI format, streaming and
non-streaming, in front of a deterministic mock provider, Ollama, or any OpenAI-compatible API.
There is no authentication yet (API keys arrive in M2), so the gateway listens on 127.0.0.1 by
default.

## Requirements

- Node 22 LTS (`.nvmrc`), pnpm via corepack (`corepack enable`)
- Docker with Compose v2.20+
- Optional: [Ollama](https://ollama.com) for real local models

## Quick start

```bash
pnpm install
cp .env.example .env          # optional: defaults match the Compose stack
docker compose up -d          # Postgres 16 + Redis 7 on 127.0.0.1
pnpm dev                      # gateway :8080, worker, dashboard :5173

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "mock-1", "messages": [{"role": "user", "content": "Hello"}]}'

curl -sN http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
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

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'unused-until-m2' });
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
| `GET /docs` | Swagger UI; the OpenAPI 3.1 spec is at `/docs/json`. |
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
| 404 | `model_not_found` | No such model, or its deployment is disabled. |
| 429 | `upstream_rate_limited` | The provider rate-limited the call. |
| 502 | `upstream_error`, `upstream_unavailable`, `upstream_invalid_response`, `upstream_auth_failed`, `upstream_model_not_found` | The provider failed, could not be reached, or is misconfigured. |
| 504 | `upstream_timeout` | The deployment's timeout passed. |

A failure after a stream has started is sent as a final `{"error": ...}` event, and the stream
ends without `[DONE]`.

On SIGTERM the gateway stops accepting connections, lets in-flight requests and streams finish,
then closes its pools. `SHUTDOWN_TIMEOUT_MS` bounds the whole shutdown; if it passes, remaining
connections are closed and the process exits with code 1.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Gateway and worker with `tsx watch`, dashboard with Vite; loads `.env` if present |
| `pnpm build` | Compile all packages (`dist/`) and build the dashboard |
| `pnpm test` | Unit tests (no services needed) |
| `pnpm test:int` | Integration and SDK contract tests; needs `docker compose up -d` |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | ESLint, `tsc`, Prettier |

Configuration is read from environment variables and validated at startup; see
[.env.example](.env.example) for every variable. Invalid config exits with a message naming each
problem.

## Layout

```text
apps/gateway     Fastify API: /v1 proxy, providers, health
apps/worker      background process (usage consumer from M3)
apps/dashboard   React + Vite
packages/shared  config, clock, logger, ids, Postgres/Redis clients
infra/compose    Docker Compose stack (compose.yaml at the root includes it)
docs/adr         architecture decision records
```

## Notes

- No authentication until M2: do not expose the gateway beyond localhost yet.
- Local Postgres uses trust auth and every Compose port binds to 127.0.0.1, so the repo holds no
  database password. Real deployments pass credentials in `DATABASE_URL`.
- In Compose, the gateway reaches Ollama on the host at `host.docker.internal:11434`.
- The SIGTERM process tests are skipped on Windows, where signals terminate processes without
  running handlers. They run in CI (Linux).
