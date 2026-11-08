# ADR 011: Bounded retries with full jitter, never after the first byte

- Status: accepted
- Date: 2026-10-20
- Milestone: M5

## Context

Providers fail transiently (timeouts, 429, 5xx, dropped connections), and a model can be served
by several deployments. Retrying blindly duplicates output once a stream has started, multiplies
load during an outage (retry storms), and repeats requests that fail the same way every time.

## Decision

- A logical model lists one or more deployments and a routing policy (`priority`, `weighted`,
  `lowest_latency` by EWMA of time to first byte, `cost_aware` by worst-case price). The policy
  orders them; later ones are fallbacks.
- A failure is **retried on the same deployment** only if it is retryable (timeout, rate limited,
  server error, connection) and that deployment has tries left (`RETRY_PER_DEPLOYMENT`, 2).
  The wait before retry n is a random value in `[0, min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS x
  2^(n-1)))` (full jitter); a provider's `Retry-After` is honoured when it is within the maximum,
  and a longer one skips straight to the next deployment.
- A failure **falls back** to the next deployment when another one might succeed: the retryable
  kinds plus an invalid response, rejected credentials or an unknown model. A rejected request
  (400) or a client that left is never retried or rerouted.
- `RETRY_MAX_ATTEMPTS` (3) bounds attempts per request across all deployments.
- An attempt counts as started output only when its first event arrives (streams) or its whole
  response does; the request handler commits to it only then. After the first byte reaches the
  client, a failure ends the stream with an error event; nothing is retried.
- Every attempt is stored with the policy and a reason, e.g. `priority 2 of 2; fallback after
  mock-error failed (server_error)` or `retry 1 on mock-error after server_error, waited 31 ms`.

## Alternatives considered

- Retry inside each provider adapter: no fallback across deployments, and no single place to bound
  attempts or record reasons.
- Fixed or exponential backoff without jitter: synchronized retries from many clients.
- Retrying mid-stream by replaying: the client would receive duplicated or inconsistent output.

## Consequences

- Tested: retry then fallback with the recorded reasons; doubling backoff ceilings with jitter;
  Retry-After within and beyond the maximum; no retry for 400 or a gone client; the attempt cap; a
  stream that drops after its first tokens is tried once even though the drop is retryable, while
  one that fails before its first token falls back.
- Failed attempts are not charged: their usage is unknown. Budgets reserve the costliest
  deployment of the route, since attempts run one at a time.
- Retries add latency to failing requests (bounded by the attempt cap and maximum delay).

## Note (2026-11-08, M14): a retry budget per deployment

`RETRY_MAX_ATTEMPTS` bounds the tries of one request, but nothing bounded retries across requests:
when a provider struggled, every request retried it, adding load just when it could least take it.
Each instance now keeps a retry budget per deployment: within a sliding window of
`RETRY_BUDGET_WINDOW_MS` (10 s), retries on a deployment may be at most `RETRY_BUDGET_RATIO` (0.2) of
its first tries in the window, or `RETRY_BUDGET_MIN_RETRIES` (3), whichever is more, so a single
failure in quiet traffic still gets its retry. The model is Envoy's retry budget, whose
`budget_percent` defaults to 20% and `min_retry_concurrency` to 3
(<https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/circuit_breaker.proto>,
checked 2026-11-08); Envoy counts retries in flight against requests in flight, while this budget
counts them over a window, as Finagle's and Linkerd's do (Linkerd's example `ttl: 10s`, and
"at most an additional 20% to the request load", <https://linkerd.io/2.11/tasks/configuring-retries/>,
checked 2026-11-08). Their floor of 10 retries a second would allow 100 retries in a window, more
than a free tier takes, so the floor is Envoy's 3. A first try is any try that is not a retry on
the same deployment, so a fallback (the next deployment's first try) is never limited by the
budget; breakers and `RETRY_MAX_ATTEMPTS` still are. When the budget is used up, the request
moves on to the next deployment, whose reason reads
`fallback after a failed (server_error), retry budget used up`, and
`gateway_retry_budget_skips_total{deployment}` counts the retry not made. `RETRY_BUDGET_ENABLED=false`
switches it off. The budget lives in each instance's memory: N instances allow N budgets. Tested in
`routing/retry-budget.test.ts`: in a burst of 50 failing requests, 10 retries (against 50 without
it) and the rest fall back at once; in quiet traffic a single failure still retries.
