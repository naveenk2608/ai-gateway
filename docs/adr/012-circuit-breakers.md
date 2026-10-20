# ADR 012: Per-instance circuit breakers with active health checks and shared visibility

- Status: accepted
- Date: 2026-10-20
- Milestone: M5

## Context

When a deployment is down, sending each request to it first wastes an attempt and adds latency
before the fallback. Instances need to stop using a failing deployment quickly and start again
once it recovers, without a coordination round trip on every request.

## Decision

- Each instance keeps a breaker per deployment: **closed** until `BREAKER_FAILURE_THRESHOLD` (5)
  consecutive failures, then **open** (the router skips the deployment and records the skip).
- An open breaker becomes **half-open** after `BREAKER_OPEN_MS` (30 s), or sooner when an active
  health check passes: every `HEALTH_CHECK_INTERVAL_MS` (5 s) each open deployment is probed with
  its provider's cheap check, which runs no model (Ollama `GET /api/tags`, OpenAI-compatible
  `GET /models`), so probes cost nothing on paid APIs.
- Half-open admits one trial request at a time; its success closes the breaker, its failure opens
  it again. A trial that ends without a verdict (the client left) frees the slot.
- Failures that count: timeouts, rate limits, server errors, connection errors, invalid responses,
  rejected credentials and unknown models. Rejected requests and client disconnects do not.
- If every deployment of a model is open, the request fails at once with 503
  `deployments_unavailable` and a `retry-after` until the earliest trial.
- Transitions are written, off the request path, to a Redis hash per deployment (one field per
  instance: the fleet's current view) and to `provider_health_events` (history).

## Alternatives considered

- One shared breaker in Redis: a round trip per request, and Redis becomes part of every routing
  decision.
- Passive recovery only (wait out the open period): slow recovery, or flapping with a short period.
- Health checks that send a real completion: they would cost money on paid providers.

## Consequences

- Instances can briefly disagree: each learns a deployment is down from its own failures (the
  known limitation in the plan).
- Tested: the state machine with a manual clock; end to end, a primary failing every request fails
  over, its breaker opens, requests skip it, and after the mock heals the health check half-opens
  the breaker and the next request closes it, with all three transitions recorded.
- A provider whose probe passes while its chat endpoint fails will be half-opened and re-opened by
  the trial; the cost is one failed request per health-check interval.
