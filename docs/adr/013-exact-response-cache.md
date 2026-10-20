# ADR 013: Exact-match response cache, scoped per project

- Status: accepted
- Date: 2026-10-20
- Milestone: M5

## Context

Identical deterministic requests (evaluations, retried jobs, fixed prompts) cost the same each
time. A cache must never return one tenant's answer to another, and must not freeze a sampled
answer that the caller expects to vary.

## Decision

- Key: SHA-256 over the project ID, the logical model and every field that can change the answer
  (messages with role, name and text, output cap, temperature, top_p, stop, penalties, seed), in a
  fixed order. The project is part of the key, so projects never share an entry. `stream`,
  `stream_options` and `user` are not, so streamed and plain requests share entries.
- A request uses the cache when `temperature` is 0, or when it sends `x-gateway-cache: on`
  (the caller accepts a reused sampled answer); `x-gateway-cache: off` always skips it.
- The cache is off unless `CACHE_ENABLED=true`: it keeps completions, and the plan rules out
  storing prompts or completions by default. Prompts are never stored, only hashed into the key.
- Entries live in Redis for `CACHE_TTL_SECONDS` (1 h); responses over `CACHE_MAX_ENTRY_BYTES`
  are not stored. Only complete responses are stored, from either path.
- The lookup happens after admission: a hit counts toward RPM, but is settled with zero tokens and
  zero cost. A hit is answered as JSON or replayed as SSE, with `x-gateway-cache: hit`.
- A hit is recorded like any request, with `cache_hit` set, no attempts and a usage row with the
  cached token counts at zero cost.
- The cache is an optimisation: a Redis error is a miss, never a failed request.

## Alternatives considered

- Semantic (embedding) cache: risk of wrong answers; future work with a measured false-hit rate.
- A global cache across projects: more hits, but a cross-tenant leak by design.
- Caching every request: callers asking for varied output would get the same text.

## Consequences

- Tested: the key ignores irrelevant fields and changes with every relevant one; identical
  requests from two projects each go upstream once; hits replay streamed and plain; a hit is
  recorded with no attempts and zero cost; sampled requests are cached only when opted in.
- With the cache on, completions of cacheable requests stay in Redis for the TTL; prompts appear
  only as part of a SHA-256 key.
