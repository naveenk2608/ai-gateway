# Trade-offs

Where the gateway gives up something on purpose, how much, and what bounds it. The decisions
themselves are in [adr/](adr/); this page puts the costs side by side.

## Consistency

The gateway has two stores with different jobs. Redis holds what the request path must decide
on now: rate and token buckets, concurrency leases, budget totals and reservations, breaker views
and the cache. Postgres holds the record: requests, attempts, usage, costs and the budget ledger.
Postgres is written only by the worker, after the response (ADR 005, ADR 014).

| What | Guarantee | Bounded by |
| --- | --- | --- |
| Limits across instances | One Lua script checks and takes every limit at once, so all instances see one state (ADR 008) | One Redis primary; Redis Cluster is not supported |
| Usage records | Effectively once: at-least-once delivery plus inserts that ignore duplicates (ADR 014) | Events lost if the event bus is unreachable longer than the gateway's buffer lasts (ADR 005); a transactional outbox would close this |
| Analytics and dashboard | Eventually consistent: a request appears when the worker has stored it, normally within a second | Worker lag, shown on the Infrastructure page and in metrics |
| Budget totals in Redis vs the Postgres ledger | Rebuilt from Postgres when Redis has no total for the month (ADR 009) | After a rebuild, usage still in transit is not counted, normally under a second of traffic |
| Circuit breakers | Each instance decides from its own failures; the fleet view is shared for display only (ADR 012) | Instances can briefly disagree; each opens after its own `BREAKER_FAILURE_THRESHOLD` failures |
| Revoked keys | Invalidated on every instance through pub/sub at once, and at most `API_KEY_CACHE_TTL_MS` later without it | The key cache TTL |

When Redis is down, limits and budgets fail closed by default (503 for limited projects), and can
be configured to fail open (ADR 010). Requests with no limits are served either way.

## Retries

Retries buy availability with latency and upstream load (ADR 011).

- Only retryable failures are retried (timeouts, rate limits, server and connection errors), at
  most `RETRY_PER_DEPLOYMENT` times per deployment and `RETRY_MAX_ATTEMPTS` per request, with
  full-jitter backoff so failing clients do not retry in step. A provider's `Retry-After` longer
  than `RETRY_MAX_DELAY_MS` skips to the next deployment instead of waiting.
- Nothing is retried after the first byte has reached the client: a second attempt could not
  continue the first one's output, so the client would see two answers spliced together. A stream
  that breaks mid-way ends with an error event, and its usage is estimated.
- Failed attempts are not charged (their usage is unknown), and every attempt is stored with the
  reason it was made, so the cost of retrying is visible per request.
- Circuit breakers stop retrying a deployment that keeps failing, and health checks (which run no
  model, so cost nothing) let it back in.

The price: a failing request can take up to the attempt cap times the timeout before it fails,
and a provider sees up to that many calls for one client request.

## Reservation accuracy

Budgets reserve a request's worst-case cost before it runs and settle the actual cost afterwards
(ADR 009). The worst case is the estimated prompt plus the output cap, at the costliest
deployment of the route.

- **Over-reserving** holds back budget while requests run: a project near its limit is refused
  sooner than its actual spend requires. Lower `max_tokens` (or the deployment's
  `maxOutputTokens`) tightens the reservation.
- **Under-reserving** happens when the provider counts more prompt tokens than the gateway's
  estimate, or when a reservation expires while its request still runs (its gateway stopped
  renewing). Spend can then pass the budget, by at most
  **in-flight requests x the most one request can cost**. A project concurrency limit and
  `max_request_cost_micro_usd` make that number concrete.
- Token-per-minute limits use the same reserve-then-reconcile scheme (ADR 008): an overshoot is
  taken from the bucket when the request ends, so the next requests pay for it.
- Unpriced models cost nothing in Redis and Postgres alike: a budget does not limit them.

## Cache correctness

The cache is exact-match only and off by default (ADR 013).

- **No cross-project hits:** the project is part of the key, so two projects never share an
  entry, even for the same prompt.
- **No wrong answers for different requests:** the key covers every field that can change the
  answer (messages, model, output cap, temperature, top_p, stop, penalties, seed). Fields that
  cannot (`stream`, `user`) are left out, so a streamed and a plain request share an entry.
- **Non-deterministic requests are not cached** unless the caller asks with
  `x-gateway-cache: on`, because a sampled answer reused is not what a new sample would be.
- **Staleness:** entries live for `CACHE_TTL_SECONDS`. A deployment or price change does not
  invalidate them; a hit is served at zero cost.
- **Privacy:** with the cache on, completions of cacheable requests are kept in Redis for the TTL;
  prompts appear only hashed into the key. This is why it is off by default.
- A cache error is a miss, never a failed request.

A semantic cache would hit more often, but at the price of answering a different question
sometimes; it is future work, to be measured against a false-hit rate first.
