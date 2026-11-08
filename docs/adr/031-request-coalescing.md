# ADR 031: Request coalescing for identical requests in flight

- Status: accepted
- Date: 2026-11-08
- Milestone: M14

## Context

The exact-match cache (ADR 013) helps only after an answer is complete. Identical requests that
arrive together (a retried job, a fan-out of the same evaluation, a burst after a deploy) all go
upstream, each paying its own latency, quota and cost, even though each would accept a reused
answer. The cache is also off by default, since it stores completions in Redis.

## Decision

- **What is coalesced**: requests the cache would take (chat: temperature 0, or
  `x-gateway-cache: on`, never with `off`; embeddings: unless `off`, ADR 029), for chat and
  embeddings, keyed by the cache key, which holds the project, the model and every field that
  changes the answer. So two projects never share a call. It works whether `CACHE_ENABLED` is on or
  not: nothing is stored beyond the requests' own lifetime. `COALESCE_ENABLED` (true) switches it
  off.
- **Where**: on each instance, in memory. Render runs one instance; across instances, identical
  requests each lead their own flight (PLAN-NOTES follow-up).
- **Leader and followers**: after admission and a cache miss, the first request with a key leads
  and runs as usual (routing, retries, the deadline, quotas). Requests with the same key that
  arrive while it runs follow: they pass their own key checks, limits and budget admission first,
  then wait for the leader's answer. A flight leaves the table when it has its answer or error;
  later requests use the cache or lead a new flight.
- **Who keeps the call going**: the upstream call follows the flight's own signal, which aborts
  only when nobody waits any more. The leader's client leaving does not cancel it while followers
  wait; a follower leaving affects nobody else (unless it was the last one waiting). A flight that
  everyone has left is not joined: the next request leads a new one.
- **Deadlines**: each follower keeps its own `REQUEST_DEADLINE_MS`, counted from its own arrival;
  past it, it gets 504 `upstream_timeout` and leaves the flight.
- **Failures**: if the leader fails, every follower gets the same error (mapped as the leader's
  is), instead of all retrying at once.
- **Streams**: a streamed leader streams to its own client as usual; followers get the whole
  answer. A streamed follower gets it replayed as a stream, as a cache hit does, so it waits for the
  whole answer before its first token. If the leader's client leaves while followers wait, the
  gateway reads the rest of the upstream stream in the background, so the followers still get the
  answer.
- **Accounting**: each follower gets its own request record and usage row, answered like a cache
  hit: no attempts, no quota use, the leader's token counts at zero list and billed cost, plus
  `request_records.coalesced` (migration 0012) and `coalesced: true` on its usage event. Its budget
  reservation is released at zero. The leader is recorded as usual and carries the call's attempt,
  usage and cost; a leader whose client left while followers kept the call going is recorded as
  `canceled` (499, `client_closed_request`) with that attempt, usage and cost, since nothing else
  carries them. A follower whose leader failed is recorded as `error` with the leader's error code
  and no attempts.
- **Signals**: followers' replies carry `x-gateway-cache: coalesced`;
  `gateway_coalesced_requests_total{endpoint}` counts them; the admin request list and detail return
  `coalesced`, and the dashboard marks such requests.

## Alternatives considered

- Rely on the cache alone: identical requests in flight still all go upstream, and the cache is off
  by default.
- Coalescing across instances through Redis (a lock per key and a pub/sub answer): a round trip per
  cacheable request and answers passed through Redis, for a demo that runs one instance; it is the
  follow-up if several instances serve real traffic.
- Stream the leader's tokens to followers live: followers would start mid-answer or need a replay
  buffer per flight; replaying the whole answer as a cache hit does is simpler and already tested.
- Cancel the call when the leader's client leaves: every follower would then fail, or retry at
  once, which is the burst coalescing exists to avoid.
- Count a follower's list cost as "saved": that is a counterfactual price (which deployment would
  it have used?), and budgets count list cost (ADR 024), so a follower would spend budget it never
  used. Followers cost nothing, as cache hits do; the number of coalesced requests shows the effect.

## Consequences

- N identical cacheable requests in flight on one instance make one upstream call, one quota use and
  one charge; the other N - 1 cost nothing and wait at most the leader's latency.
- A follower of a streamed leader gets no tokens until the whole answer is ready.
- A leader whose client left still pays for the call when followers kept it going.
- Tested: `proxy/coalesce.test.ts` (the flight, its signal, followers leaving and timing out, the
  shared stream read to its end, and through the handler: 50 identical concurrent requests, some
  streamed, make one upstream call and 50 events, 49 coalesced; the leader's failure is every
  follower's; sampled requests are left alone) and `test/coalescing.test.ts` against Postgres and
  Redis (50 requests make one call and 50 records, 49 marked coalesced at zero cost; the leader's
  client leaving mid-stream does not cancel the call and its record is `canceled` with the attempt;
  a follower leaving early affects nobody; two projects do not share a call).
