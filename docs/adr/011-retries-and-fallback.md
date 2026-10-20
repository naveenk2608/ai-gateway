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
