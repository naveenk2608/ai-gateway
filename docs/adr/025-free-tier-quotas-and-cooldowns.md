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

## Note (2026-11-08, M14): quota groups

Some free allowances belong to the provider account, not to one model: Cloudflare's 10,000 free
Neurons a day are spent by every Workers AI model of the account, and OpenRouter's `:free` limit
counts every `:free` model. A per-deployment quota cannot express that: two deployments each
counted as if they had the whole allowance (PLAN-NOTES rows of 2026-11-03 and 2026-11-06).

- The models file gets `quotaGroups`: a named allowance with a `unit` (e.g. `neurons`) and a limit
  `perMinute` and/or `perDay`, from the provider's own docs. A deployment joins one with
  `quotaGroup`: the group, and how its use converts to the unit (`perRequest`,
  `perMillionInputTokens`, `perMillionOutputTokens`, e.g. Cloudflare's Neurons per million tokens
  for that model). Config validation refuses an unknown group and a share with no rate.
- The same Lua script counts the group together with the deployment's own quota, in the same fixed
  UTC windows: before a try, the units of its prompt estimate and output cap (rounded up) are
  reserved if the group has room; when the try ends, they are corrected to the units of its
  reported input and output tokens (the prompt estimate when it reported none). A group that would
  be exceeded skips the deployment like its own quota, and the reason names the group:
  `skipped cloudflare-llama-4-scout (quota group cloudflare-free-neurons, 9,990 of 10,000 neurons
  today)`. Every deployment in the group stops at once, since they share the counter.
- Redis down: fail open, as for the quotas above.
- Configured: `cloudflare-llama-4-scout` (24,545 and 77,273 Neurons per million input and output
  tokens) and `cloudflare-bge-large-en-v1.5` (18,582 per million input tokens) share
  `cloudflare-free-neurons` (10,000 Neurons a day), from
  <https://developers.cloudflare.com/workers-ai/platform/pricing/> (rechecked 2026-11-08). The Llama
  deployment's derived token quota (129,000 a day) is replaced by the group; both keep their
  per-model requests per minute. OpenRouter still has a single `:free` deployment, so its own
  quota is the account's; a second one would join a group for the account's limit.
- Tested: the unit conversion and the skip reason (`routing/quota.test.ts`), config validation
  (`models-config.test.ts`, `default-models.test.ts`), and against Redis (`test/quota-groups.test.ts`):
  two deployments of a group are refused together once the allowance would be exceeded, a
  reservation corrected to the reported tokens frees the difference, and with Redis down every
  deployment is tried.
- Not yet shown: the group's use in `GET /admin/models/quotas` and the quota gauge, which read
  per-deployment counts only (PLAN-NOTES).
