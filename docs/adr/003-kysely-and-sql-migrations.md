# ADR 003: Kysely for queries, plain-SQL migrations with node-pg-migrate

- Status: accepted
- Date: 2026-10-20
- Milestone: M2

## Context

The schema leans on Postgres features an ORM hides or fights: partial indexes, `UNIQUE NULLS NOT
DISTINCT`, check constraints, triggers (immutable price rows) and, later, partitioning and
`ON CONFLICT DO NOTHING` for idempotent ingestion. Queries must stay parameterized and typed.

## Decision

Queries go through Kysely, a typed SQL builder over the existing `pg` pool, with table types
written by hand in `packages/shared/src/node/db.ts`. Migrations are numbered plain-SQL files in
`db/migrations/`, applied by node-pg-migrate.

Pending migrations are applied when the gateway starts (`MIGRATE_ON_START`, default on) and by
`pnpm db:migrate`. The runner takes a session-level `pg_advisory_lock` on its own connection for
the whole run, so instances that start together migrate one at a time and the later ones find
nothing pending; a crash releases the lock with the session. All pending files run in one
transaction.

## Alternatives considered

- Prisma or TypeORM: their schema languages cannot express several of the constraints above, and
  generated SQL is harder to reason about under concurrency.
- Raw `pg` with hand-written types: no compile-time check that a query matches the schema.
- A separate migration job before deploy: not available on hosts without one-off jobs (Render's
  free plan), and easy to forget elsewhere.

## Consequences

- The Kysely types must be updated with every migration; integration tests catch drift.
- `bigint` columns (micro-dollars) are parsed to JavaScript numbers by a pool-level type parser
  that throws past 2^53, instead of strings.
- Migrations run under the gateway's database role, which therefore needs DDL rights. Deployments
  that separate roles can set `MIGRATE_ON_START=false` and run `pnpm db:migrate` instead.
- Tested: two runners started together on an empty database apply each migration exactly once.
