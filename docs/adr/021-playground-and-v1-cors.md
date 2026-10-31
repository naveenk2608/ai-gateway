# ADR 021: The Playground in the dashboard, and CORS for /v1 only

- Status: accepted (revised 2026-10-31: the Playground moved from a separate static site into
  the dashboard, which the gateway now serves)
- Date: 2026-10-28
- Milestone: after M9 (feature work)

## Context

The plan lists "a chatbot UI or prompt playground" as a non-goal: the project is the gateway, and
a chat UI is not what it is meant to show. A small chat that calls the gateway like any other
client is still useful: it shows routing, fallback, limits, budgets and cost tracking working
from the outside, on the live demo.

The first version (2026-10-28) was a separate static site where the user pasted a gateway API
key; it needed CORS on `/v1`, a second deployment, and a key kept in browser storage. The
dashboard already has a logged-in admin and the admin API that creates keys, but it was served
by its own nginx container that proxied the API under `/api`, and the live demo (one Render web
service) did not serve it at all.

## Decision

The Playground is a page of the dashboard, and the gateway serves the built dashboard on its own
origin.

- **Serving:** the gateway serves the `vite build` output from `DASHBOARD_DIR` at `/dashboard/`
  (set in the image; unset, nothing is served and `GET /` redirects to `/docs`). `GET /` and
  `/dashboard` redirect to `/dashboard/`. The files are read into memory at startup, so no
  request path reaches the file system; unknown paths get the gateway's JSON 404 (pages are
  routed in the URL hash). `index.html` is revalidated on every load, hashed assets are cached as
  immutable, text is gzipped when the browser accepts it, and every response carries a strict
  Content-Security-Policy (scripts, styles, connections and images from the same origin only;
  inline styles allowed for the charts; no framing, no referrer). The dashboard calls the admin
  API at `/admin`, `/ready` and `/v1` on that origin, so the `SameSite=Strict` session cookie
  (ADR 007) works with no proxy; the Vite dev server proxies those paths in development. The
  nginx image and its `/api` prefix are removed.
- **Key:** when the page opens, the dashboard creates an API key named `playground` for the
  selected project through the admin API, with `expiresInSeconds: 3600` (a new optional field on
  key creation, 60 s to one year). The plaintext is held only in the page's memory. The page
  revokes the key when it unmounts (another page or project) and on `pagehide` (tab closed,
  with `keepalive`), makes a new one five minutes before expiry or on "Start a new key" (revoking
  the old), and makes a new one when restored from the back/forward cache. The gateway refuses
  the key after the hour whatever the page does. Key creation needs the `admin` role, so only
  owners and admins can use the page; viewers see why.
- **Calls:** the page calls `GET /v1/models` and streaming `POST /v1/chat/completions` with the
  key as a bearer token and `credentials: 'omit'`, so `/v1` sees an ordinary API caller: the
  project's limits, budget, model allow-list, routing, cache and usage accounting all apply, and
  its requests appear under the `playground` key on every dashboard page.
- **Per reply:** the model, the provider and deployment that served it (`x-gateway-deployment`),
  the deployments passed over first (`x-gateway-fallback-from`), latency measured in the browser,
  the tokens the stream reported, the cost the worker recorded (polled from
  `GET /admin/requests/:id` until the record exists) and a link to `#requests/<id>`, which opens
  that request's panel on the Requests page in a new tab, so the chat stays open.
- **CORS:** kept for other browser clients. `ALLOWED_ORIGINS` (empty by default) lists exact
  origins that may call `/v1` with an `Authorization` header and read `x-request-id`, the routing
  headers, `x-gateway-cache` and `retry-after`. Credentials are never allowed. The admin API,
  `/health`, `/ready`, `/docs` and `/dashboard` get no CORS headers. `GET /v1/models` stays.

## Alternatives considered

- Keep the separate static site: a second deployment, a key pasted by the user and kept in
  browser storage, and an origin to list in `ALLOWED_ORIGINS`; usage could not be tied to the
  logged-in admin.
- Call `/v1` with the admin session instead of a key: no key to manage, but `/v1` would gain a
  second authentication path, and the Playground's requests would bypass the per-key limits and
  attribution that every other client gets.
- A long-lived key per user, stored server-side: fewer keys in the list, but a secret at rest
  for a convenience feature; a key that dies within the hour bounds what a leak can do.
- Keep the nginx container for the dashboard: it does not exist on single-service hosts like
  Render's free plan, and it served the API under a second prefix.
- `@fastify/static`: a dependency for a fixed set of build files; the in-memory handler is short,
  never maps a URL to a path, and is tested.

## Consequences

- The non-goal is narrowed, not dropped: the gateway gains no chat features, the Playground uses
  only the public API, and it is reachable only by logged-in owners and admins.
- Each visit creates a key and an audit row; revoked and expired `playground` keys accumulate in
  Settings → API keys.
- A browser that crashes or is killed leaves its key working until it expires (at most an hour);
  `pagehide` covers normal tab closes.
- The cost appears a moment after the reply (the worker records it asynchronously), and shows
  "no price for this model" when `model_prices` has no row for it.
- The gateway holds the dashboard build in memory (about 0.9 MB, plus gzipped copies).
- Tests: dashboard serving (redirects, CSP, caching, gzip, 404s, missing build), key expiry
  through the admin API on two instances, CORS (allowed and other origins, preflight, admin
  routes untouched), the models list and routing headers, the Playground's client and page in
  jsdom (key creation and revocation, models, streaming, stop, fallback, cost, request link,
  viewers), the deep link to a request, and the page at 375 px in Chromium.
