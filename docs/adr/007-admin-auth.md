# ADR 007: Admin auth with argon2id passwords, session cookies and per-project roles

- Status: accepted
- Date: 2026-10-20
- Milestone: M2

## Context

Dashboard users are people, not programs: they log in with a password, act on one or more
projects, and must not see other projects at all. Every change they make must be traceable.

## Decision

- Passwords: argon2id (19 MiB, 2 passes, OWASP minimum). Logins for unknown emails run a decoy
  check so response time does not reveal which emails exist.
- Sessions: a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in
  production); only its SHA-256 is stored, in `user_sessions`, with an expiry
  (`SESSION_TTL_SECONDS`). Logout deletes the row.
- Roles per project in `project_members`: `viewer` reads; `admin` also manages keys and project
  settings; `owner` also manages members. A project always keeps at least one owner.
- Isolation: every project-scoped route first resolves the caller's membership. Not a member: 404,
  the same answer as a project that does not exist. Member with too low a role: 403.
- Audit: every admin change writes an `audit_logs` row inside the same transaction as the change,
  with the actor, action, target, request ID and non-secret details.

## Alternatives considered

- JWT sessions: cannot be revoked server-side without a store, which removes their benefit.
- Sessions in Redis: would tie dashboard logins to Redis availability; admin traffic is small and
  already reads Postgres.
- Global admin role: not needed yet; every privilege is scoped to a project.

## Consequences

- CSRF relies on `SameSite=Strict` and JSON-only bodies; a token scheme would be needed if the
  dashboard is ever served from another site.
- Login is not rate-limited until M4.
- Tested for every route: another project's resources return 404 (the test fails if a new
  project-scoped route is not in its table), and every mutating route writes exactly one audit row
  tagged with its request ID.
