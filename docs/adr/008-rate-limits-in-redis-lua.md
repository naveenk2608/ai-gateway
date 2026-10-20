# ADR 008: Rate, token and concurrency limits in Redis Lua scripts

- Status: accepted
- Date: 2026-10-20
- Milestone: M4

## Context

Limits must hold across any number of gateway instances: 200 requests spread over two instances
against a concurrency limit of 10 must admit 10, not 20. Per-instance counters cannot do that,
and a check followed by a separate update races between instances. Limits apply per API key and
per project (all of its keys together), and a request rejected by one limit must not use up
another.

## Decision

- One Lua script checks every limit of a request and, only if all pass, takes them all. Redis
  runs scripts atomically, so instances see one consistent state and a rejection takes nothing.
- **RPM**: a token bucket per scope, `rpm` tokens refilled evenly over a minute.
- **TPM**: a token bucket per scope that reserves the estimated prompt tokens plus the output cap
  (`max_tokens`, or the deployment's `maxOutputTokens`, which is then sent upstream so the cap is
  real). When the request ends, the bucket is reconciled to the tokens actually used: unused
  tokens come back, an overshoot is taken. A request larger than the whole limit gets a 400.
- **Concurrency**: a sorted set of leases per scope, scored by expiry. Running requests renew
  their lease every third of `LIMITS_LEASE_TTL_MS` (30 s); a request whose gateway crashed stops
  renewing, and its lease expires and frees the slot.
- Time comes from the gateway's injected clock, passed into each script, so tests are
  deterministic. A bucket never moves its timestamp backwards, so a slightly slow instance clock
  cannot mint tokens.
- Rejections are 429 with `retry-after` and a reason code (`rpm_limit_exceeded`,
  `tpm_limit_exceeded`, `concurrency_limit_exceeded`, `budget_exceeded`), and each is recorded as a
  `rejected` request through the usage pipeline.
- Limits live on `projects` and `api_keys` and travel with the cached key record, so checking them
  costs no database query; admin changes invalidate the cache on every instance.
- Admin logins use the same bucket script, per email (keyed by a hash) and per client IP.

## Alternatives considered

- Fixed or sliding windows in plain Redis commands: bursts at window edges, and multi-key checks
  race without a script.
- `INCR` plus `EXPIRE` per limit: no all-or-nothing across limits.
- A rate-limit service or Envoy: another process to run for what one script does.

## Consequences

- Tested against real Redis: limits per key and per project, nothing taken on rejection, TPM
  reconciliation both ways, 50 simultaneous admissions against a limit of 10, lease renewal and
  expiry. End to end: exactly 10 of 200 parallel requests across two instances; a gateway process
  killed mid-request frees its slot after the lease TTL.
- Keys are not hash-tagged: Redis Cluster is not supported, one primary is.
- Instance clocks must be roughly in sync (NTP); skew shifts refill timing, never the limit.
