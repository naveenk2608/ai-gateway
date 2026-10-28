# ADR 021: A Playground client, and CORS for /v1 only

- Status: accepted
- Date: 2026-10-28
- Milestone: after M9 (feature work)

## Context

The plan lists "a chatbot UI or prompt playground" as a non-goal: the project is the gateway, and
a chat UI is not what it is meant to show. A small chat app that calls the gateway like any other
client is still useful, though: it shows routing, fallback, limits and budgets working from the
outside, against the live demo, with nothing but an API key. A browser app on another origin
needs the gateway to allow cross-origin calls, and the API key it holds must stay safe.

## Decision

Build `apps/playground` as a separate static site that uses only the public OpenAI-compatible API
(`GET /v1/models`, streaming `POST /v1/chat/completions`) with a gateway API key, and allow CORS
on `/v1` only, for exact origins listed in `ALLOWED_ORIGINS` (empty by default).

- The gateway adds `GET /v1/models` (the key's allowed and available models) and names the
  deployment that answered (`x-gateway-deployment`) and those passed over before it
  (`x-gateway-fallback-from`). CORS lets listed origins send `Authorization` and read those
  headers, `x-request-id`, `x-gateway-cache` and `retry-after`. Credentials are never allowed:
  `/v1` is authenticated by the bearer key, not cookies.
- The admin API, `/health`, `/ready` and `/docs` get no CORS headers. The admin session cookie
  (ADR 007) stays same-origin only.
- The Playground keeps the key in sessionStorage, or localStorage when the user opts in, and
  sends it only to the gateway URL. It loads no third-party code, and its host sends a strict
  Content-Security-Policy (scripts and styles from the site only, connections to HTTPS or a local
  gateway, no forms, no framing, no referrer).
- It reuses the dashboard's design tokens and base styles (ADR 020) and React + Vite (ADR 018).
  It has no backend, no access to the admin API and no conversation storage.

## Alternatives considered

- Chat inside the dashboard: same origin, so no CORS, but the dashboard holds an admin session.
  Mixing API keys into it blurs the line between admin users and API callers (ADR 007), and the
  dashboard is not meant to be public.
- A server-side proxy for the Playground: hides the key from the browser, but the user typed
  the key into the page anyway. It adds a backend to host, and the Playground would no longer
  call the gateway as a client.
- `Access-Control-Allow-Origin: *` on /v1: simple, but any site could then use a key it obtains
  from a visitor's browser storage. A list of exact origins keeps the reach explicit.
- `@fastify/cors`: a dependency for a few headers on one path prefix; the hook and preflight
  route are short and tested.

## Consequences

- The non-goal is narrowed, not dropped: the gateway gains no chat features, and the Playground
  is optional and separately deployed.
- Each origin that hosts the Playground (production, previews, local dev) must be listed in
  `ALLOWED_ORIGINS`; a browser on any other origin gets no CORS headers and cannot read replies.
- An API key in a browser is only as safe as that browser. The Playground keeps it out of URLs,
  logs and other origins; revoking a key in the dashboard ends its use.
- Tests: CORS (allowed and other origins, preflight, errors, admin routes untouched), the models
  list, the routing headers, and the Playground's client, storage and chat flow in jsdom. The
  OpenAI SDK contract test covers `models.list()`.
