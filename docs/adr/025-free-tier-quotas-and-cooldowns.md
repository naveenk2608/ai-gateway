# ADR 025: Free-tier quotas and shared 429 cooldowns in Redis, failing open

- Status: accepted
- Date: 2026-11-03
- Milestone: M11

## Context

Free tiers have small published limits (Groq: 30 requests a minute and 1,000 a day per model;
OpenRouter `:free`: 20 a minute and 50 a day per account; Cloudflare: 10,000 Neurons a day). When
one is used up, every request to that deployment fails with a 429 until the window resets, and
each failure costs an attempt and a retry before the fallback. Circuit breakers (ADR 012) learn
this per instance and only after several failures. Several gateway instances share one provider
account, so the count has to be shared too.

## Decision

- A deployment may set `quota` in the models file: `requestsPerMinute`, `requestsPerDay`,
  `tokensPerMinute`, `tokensPerDay`, taken only from the provider's published free limits, with
  the source and date in `docs/providers.md`. Providers that publish no per-model numbers get no
  quota.
- Before each try, the gateway runs one Lua script (like the limiter, ADR 008) that checks the
  deployment's cooldown and its quota in fixed UTC minute and day windows and, if both allow it,
  counts one request and the tokens it may use (prompt estimate plus output cap). Instances share
  the counts, so two cannot both take the last request of a window.
- When the try ends, its tokens are corrected to the reported total (or the prompt estimate when
  none was reported). If the provider sends `x-ratelimit-limit-*` / `-remaining-*` headers whose
  limit equals a configured quota, the count is raised to the provider's (limit minus remaining);
  it is never lowered.
- A deployment whose quota would be exceeded is skipped, and the reason goes on the next
  attempt's routing reason: `skipped groq-gpt-oss-120b (quota, 1,000 of 1,000 requests today)`.
  When every deployment of a model is skipped this way, the request gets a 429
  (`upstream_quota_exhausted`) with `retry-after` until the earliest window ends.
- An upstream 429 puts the deployment on a cooldown in Redis for its `Retry-After`, or
  `PROVIDER_COOLDOWN_MS` (30 s) when it sent none; every instance skips it until then (429
  `upstream_rate_limited` when nothing else is left). A retry on the same deployment after its own
  429 has already waited the Retry-After (ADR 011), so it checks the quota but not the cooldown.
- **Redis down: fail open.** Each check waits at most 250 ms; on any Redis error the deployment
  is tried as if it had quota left, and corrections and cooldowns are skipped (logged). The
  provider's own 429 still protects its limit, and a free tier cannot overspend money. This is the
  opposite of the limits' default (ADR 010), which protect the gateway's own users and budgets.
- `GET /admin/models/quotas` returns each deployment's counts, limits and cooldown; Prometheus has
  `gateway_provider_skips_total{deployment,reason}`, `gateway_provider_cooldowns_total` and
  `gateway_provider_quota_used_ratio` (the tightest quota's share, read from Redis at scrape time).

## Alternatives considered

- Per-instance counters: N instances would allow N times the quota.
- Sliding windows: closer to some providers' accounting, but more Redis work per request; the
  providers that publish limits describe minutes and days, and the provider's 429 covers the edges.
- Fail closed when Redis is down: a Redis outage would stop all real traffic to protect a free
  quota that the provider enforces anyway.
- Relying on circuit breakers alone: each instance needs five failures to open, and breakers say
  nothing about why or for how long.

## Consequences

- Every routed try costs one Redis round trip (also for deployments without a quota, to read the
  cooldown); requests with no limits no longer avoid Redis entirely.
- Fixed windows can admit up to twice a per-minute quota across a minute boundary, as the provider
  sees it; the provider's 429 and the cooldown absorb the excess.
- Token quotas count the output cap up front, so with a tight per-minute token quota concurrent
  requests can be skipped though their actual use would fit; the correction frees the difference
  as soon as each try ends.
- Tested: the window math; a mock deployment with a quota of 3 requests a day is skipped on the
  4th request, with the reason stored, and refused with a 429 when it is the only one; a 429 on
  one instance makes a second instance skip a deployment that would have answered it.
