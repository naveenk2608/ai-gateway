# ADR 030: Power of two choices over peak EWMA latency

- Status: accepted
- Date: 2026-11-08
- Milestone: M14

## Context

`lowest_latency` (ADR 011) sends every request to the deployment with the lowest moving average of
its time to first byte. On free tiers that means one fast deployment takes all the traffic, and
uses up its quota, until it slows down or fails; the others are measured once and then idle. A
plain moving average also reacts slowly when a deployment gets slower, and it ignores how many
requests a deployment is already serving. Load balancers in service meshes solve the same problem
with "power of two choices" over a peak-sensitive latency estimate weighted by outstanding requests
(Finagle's `p2cPeakEwma`, Linkerd's proxy, tower's `PeakEwma`).

## Decision

- A new policy, `peak_ewma`. `lowest_latency` stays as it is. `chat-fast` uses `peak_ewma`.
- Each instance keeps, per deployment, two estimates in memory: streamed requests (time to first
  token) and non-streamed ones (the whole response). Updates follow tower's `RttEstimate`
  (<https://docs.rs/tower/latest/src/tower/load/peak_ewma.rs.html>, checked 2026-11-08): a sample
  `s` above the estimate `E` replaces it at once; a lower one gives
  `E' = E x w + s x (1 - w)` with `w = exp(-elapsed / decay)`, where `elapsed` is the time since
  the estimate was last updated. Reading an estimate for a score first decays it toward zero for the
  time since its last update (`E x w`, tower's `PeakEwma::load`), so a deployment that was slow is
  tried again after a while, and its next sample sets the estimate back if it still is.
- It also counts this instance's tries in flight per deployment, from the start of a try until its
  response or stream ends, failed and cancelled tries included.
- Score = estimate x (tries in flight + 1) (tower: `estimate * (pending + 1)`). A request is scored
  with its own mode's estimate, else the other mode's, else `PEAK_EWMA_DEFAULT_MS`; the default
  decays from the first time the deployment was scored, as tower's initial estimate does, so a new
  deployment gets some traffic without getting all of it.
- Order: two different deployments are picked at random (the injected random), the lower score goes
  first (the first picked on a tie), and every other deployment follows as a fallback, lowest score
  first. Last-resort targets stay last. Capability filters (ADR 028), breakers (ADR 012), quotas and
  cooldowns (ADR 025) and the budget's cheapest-first rule (ADR 024) apply exactly as for the other
  policies.
- Samples: a successful try records its latency (streams: the time to first token); a try that ran
  its full `timeoutMs` records `timeoutMs`; other failures record nothing (breakers and cooldowns
  handle them), and neither does a try the request deadline cut short (ADR 012, note of
  2026-11-06) or an idle timeout after the first event.
- The reason on the first attempt names both picks and their scores, e.g.
  `peak EWMA: picked a 120 (120 ms x 0 in flight + 1) over b 400 (200 ms x 1 in flight + 1)`;
  fallbacks read `peak EWMA fallback 1: c 600 (...)`.
- Settings: `PEAK_EWMA_ENABLED` (true; false orders `peak_ewma` routes as `lowest_latency`, so the
  policy can be switched off without editing the models file), `PEAK_EWMA_DECAY_MS` (10,000:
  Finagle's `decayTime` default of 10 seconds, <https://twitter.github.io/finagle/guide/Clients.html>,
  checked 2026-11-08) and `PEAK_EWMA_DEFAULT_MS` (1,000: tower's documented "arbitrary default RTT
  of 1 second", same tower page).
- Prometheus: `gateway_peak_ewma_estimate_seconds{deployment,mode}` (measured estimates, decayed to
  the scrape time without changing them) and `gateway_upstream_in_flight{deployment}`.

## Alternatives considered

- Keep `lowest_latency` and add in-flight counts to it: still a single winner whenever the counts
  are equal, which is always the case for sequential traffic.
- Least outstanding requests only: ignores that free providers differ in latency by several times.
- Round robin or `weighted`: no reaction to a deployment that slows down.
- Shared estimates in Redis: a round trip on every routing decision for numbers that are only
  meaningful per instance (each instance measures its own network path and its own load).
- Scoring every deployment and always taking the best: herds every instance onto one deployment
  between samples; two random choices avoid that while staying close to the best.

## Consequences

- Traffic spreads across a route's deployments, weighted toward the faster ones, and leaves one that
  slows down at its next sample. A slower deployment still gets an occasional request (each time
  its decayed estimate falls below the faster one's), so its estimate stays current, at the cost of
  that request's latency.
- Estimates are per instance and start over on restart; a new instance spreads its first requests
  across deployments it has not measured yet.
- With two deployments the random picks always choose both, so the order is decided by the scores
  alone.
- Tested (`routing/peak-ewma.test.ts`, manual clock and seeded random): the update rules and the
  decay; mode fallback; the reason text; a deployment twice as slow gets some traffic but less than
  a tenth; traffic leaves a deployment that slows down within two requests; concurrent requests
  spread by tries in flight; an unmeasured deployment is tried without taking most traffic; tries in
  flight are released after failures, timeouts record `timeoutMs`, and deadline cuts record nothing.

## Note (2026-11-09, M15): failures record a penalty, and estimates decay toward the default

Under the rules above, a deployment whose every try failed fast (Mistral Small answers this
account 429 at once) recorded no sample, so its default estimate decayed toward zero and it went
first whenever it was drawn (PLAN-NOTES, 2026-11-08 M14 row). Two changes, each with its own
setting, both on by default:

- `PEAK_EWMA_FAILURE_PENALTY` (true): a try that failed because the deployment could not serve
  (rate limited, server error, connection, invalid response, auth, not found) records the
  deployment's `timeoutMs` as a sample. Timeouts keep their rule (a full timeout records
  `timeoutMs`, a deadline cut nothing); a rejected request (400) or a cancelled try records nothing.
  A stream that broke after its first event counts as a failure too.
- `PEAK_EWMA_DECAY_TO_DEFAULT` (true): reading an estimate decays it toward `PEAK_EWMA_DEFAULT_MS`
  instead of toward zero, at the same rate: `E' = D + (E - D) x exp(-elapsed / decay)`. The default
  estimate of an unmeasured deployment therefore stays at the default. A penalty fades to the
  default (from 60 s to within 0.5 s of 1 s takes about 48 s at a 10 s decay), never below it.

Measured with `runRouted` (`routing/peak-ewma.test.ts`, seeded random, four deployments answering in
0.3, 1.5 and 2.5 s and one answering 429 in 5 ms, 600 requests a second apart, breakers kept closed
so only the scores decide): the failing deployment was tried first 297 times under M14's rules and
24 times under these (seed 21). With another seed (22), it was first 25 times of 600 while failing,
and 221 of the next 600 once it answered in 0.2 s; the 0.3 s deployment was first most often in
both phases (298 and 282).

Consequence: with decay toward the default, an idle deployment faster than the default drifts up
toward it, so in light, sequential traffic the measured fastest deployments keep the traffic and an
unmeasured or recovered one goes first only when paired with one scored above the default (slower,
or busy with tries in flight), or as a fallback. Under tower's decay toward zero it would be
re-tried every `decay x ln(ratio)`. Setting `PEAK_EWMA_DECAY_TO_DEFAULT=false` restores that
exploration while keeping the penalty.
