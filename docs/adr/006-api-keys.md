# ADR 006: API keys as `gw_<keyId>_<secret>`, stored as HMAC-SHA256 with a pepper

- Status: accepted
- Date: 2026-10-20
- Milestone: M2

## Context

Every `/v1` request carries an API key, so verification sits on the hot path. Keys must not be
recoverable from a database dump, revocation must take effect quickly on every instance, and
rotation must not break clients mid-deploy.

## Decision

- Format `gw_<keyId>_<secret>`: a 16-hex-character public key ID for lookup and a 64-hex-character
  (256-bit) random secret. The prefix makes keys easy to spot in leaks and logs.
- Stored: `HMAC-SHA256(secret, API_KEY_PEPPER)` only. The pepper lives in the environment, not the
  database. High-entropy secrets need no slow hash; comparison is constant-time.
- Lookup by key ID, cached per instance for `API_KEY_CACHE_TTL_MS` (30 s). The secret is checked
  on every request; only the row is cached.
- Revocation, rotation and allow-list changes publish an invalidation on Redis pub/sub; each
  instance drops the affected entries, and drops everything after a Redis reconnect. Pub/sub is
  best effort, so the TTL is the guaranteed bound on how long a revoked key can still work.
- Rotation creates a new key and sets the old key's `expires_at` to now plus a grace period
  (default `API_KEY_ROTATION_GRACE_SECONDS`, settable per call). Expiry is checked against the
  cached row, so it is exact.
- The full key is returned once, by the create or rotate call, with `Cache-Control: no-store`.

## Alternatives considered

- bcrypt or argon2 for keys: tens of milliseconds per request for no gain on 256-bit secrets.
- Plain SHA-256 without a pepper: a database dump alone would allow offline checks.
- No cache: one Postgres read per request, putting the database on the request path.
- JWTs: revocation needs a deny-list anyway, and tokens cannot be shown "once".

## Consequences

- Changing `API_KEY_PEPPER` invalidates every key; rotating it needs dual-pepper support (not
  built).
- A revoked key can work for up to the TTL on an instance that missed the invalidation. Tested:
  with invalidation isolated, the key is accepted just before the TTL and rejected at it; with
  pub/sub, another instance rejects it within milliseconds.
- Unknown key IDs are not cached, so random keys reach Postgres; rate limits (M4) cover floods.
