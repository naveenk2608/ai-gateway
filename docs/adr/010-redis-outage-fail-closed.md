# ADR 010: Limits fail closed when Redis is down, configurably

- Status: accepted
- Date: 2026-10-20
- Milestone: M4

## Context

Limits and budgets live in Redis (ADR 008, ADR 009). When Redis cannot be reached, the gateway
must choose between availability and enforcement. Silently dropping security limits is not
acceptable; some deployments would still rather serve traffic.

## Decision

- `LIMITS_FAIL_MODE=closed` (default): a request whose key or project has any limit or budget gets
  503 `limits_unavailable` with `retry-after: 1`, and is recorded as rejected.
- `LIMITS_FAIL_MODE=open`: such requests are admitted unchecked and each is logged as a warning.
- Requests with no limits and no budget never touch Redis, so they are served in either mode.
- The Redis client does not queue commands while disconnected, so an outage fails fast instead of
  hanging requests. Releasing limits after a request is best effort: leases expire and buckets
  refill on their own.
- Admin login limits follow the same mode.

## Alternatives considered

- Always closed: an outage of a cache-like dependency stops all limited traffic, with no choice.
- Always open: an outage, or an attacker able to cause one, disables every limit and budget.
- Per-instance fallback limits: they would not hold across instances, which is the point of limits.

## Consequences

- Tested against an unreachable Redis: closed mode returns 503 for limited projects and 200 for
  unlimited ones; open mode admits past an RPM limit of 1.
- `/ready` reports Redis as failing, so a load balancer can stop routing to an instance.
- Usage events wait in the gateway's bounded buffer during the outage (ADR 005).
