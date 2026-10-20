# ADR 018: React + Vite + TypeScript for the dashboard

- Status: accepted
- Date: 2026-10-20
- Milestone: M0

## Context

The dashboard shows operational data (requests, cost, reliability) from the admin API. It needs
typed data access, tables and charts, and should stay small enough that it does not eat the
schedule.

## Decision

React with Vite and TypeScript (strict). TanStack Query for server state, TanStack Table for
tables and Recharts for charts, each added in the milestone whose pages need them (M5, M7). The
dashboard talks to the gateway through a same-origin `/api` prefix: Vite's dev proxy locally,
nginx in the container image.

## Alternatives considered

- Next.js: server rendering and routing conventions we do not need for an internal SPA, and a
  heavier deployment.
- Server-rendered templates from the gateway: mixes UI with the API process (against ADR 001).

## Consequences

- One static build served by nginx; no Node runtime in the dashboard image.
- Same-origin `/api` keeps the admin session cookie (ADR 007) simple: no CORS, no cross-site cookie
  settings.
- The dashboard only renders data returned by the backend; empty data shows an empty state.
