# ADR 001: Modular monolith with separate gateway and worker processes

- Status: accepted
- Date: 2026-10-20
- Milestone: M0

## Context

The gateway sits on the request path and must stay fast under load. Usage accounting, rollups and
dead-letter handling are background work that can lag without hurting clients. The two scale
differently, but the project is built by one person and must run locally on a laptop.

## Decision

One pnpm workspace, one codebase, two deployable processes: `apps/gateway` (Fastify API) and
`apps/worker` (stream consumer). Shared config, schemas and infrastructure helpers live in
`packages/shared`; the dashboard is a third app (`apps/dashboard`).

## Alternatives considered

- Single process doing both: simplest, but a backlog in accounting would compete with request
  handling for the same event loop, and the two cannot be scaled separately.
- Microservices per concern (auth, limits, routing, accounting): network hops on the hot path and
  operational overhead with no benefit at this scale.

## Consequences

- Gateway and worker scale and restart independently; each has its own container image built from
  the same Dockerfile.
- Shared code must not import process-specific modules. `@ai-gateway/shared` exposes an isomorphic
  entry and a Node-only `@ai-gateway/shared/node` entry so the dashboard can later import schemas
  without pulling in `pg` or `ioredis`.
- Both processes share the startup and shutdown contract: config validated once at startup, JSON
  logs, SIGTERM handled with a bounded graceful stop.
