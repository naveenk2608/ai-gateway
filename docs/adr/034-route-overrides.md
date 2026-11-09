# ADR 034: Per-project route overrides edited from the dashboard

- Status: accepted
- Date: 2026-11-09
- Milestone: M15

## Context

Routing comes from the models file (ADR 011, ADR 028): changing a model's order or policy means
editing the file and redeploying. Owners want to react to a provider's trouble, or try another
policy, from the dashboard, and see the change everywhere within seconds. Roles are per project
(ADR 007), so a project admin cannot be allowed to change routing for other projects, and the file
holds what must not be edited from a browser: deployments, base URLs and the names of key
variables. The `routing_policies` table from migration 0001 was never used, and its CHECK predates
`peak_ewma`.

## Decision

- **What may change**: per project, a model's policy (any of the five, `peak_ewma` included) and
  its targets: their order, weights and last-resort flags, using only the deployments the models
  file lists for that model, each once. No new models, deployments, URLs or keys. Validation uses
  the file's rules for targets (1 to 10, weights 1 to 1,000) plus that subset rule, with errors that
  name the target and the allowed deployments (400 `invalid_route`).
- **Versions**: a new table `route_overrides` (migration 0015). Each change is a new version holding
  the whole route, who made it and when; a rollback is a new version copying an old one (its route
  is checked against the current file again); a reset is a new version with no route (the file's
  route applies). The active override is the highest version. Versions are numbered under a
  transaction-scoped advisory lock per (project, model). Every change writes an audit row
  (`route.update`, `route.rollback`, `route.reset`) in the same transaction. `routing_policies` is
  left alone.
- **Applying it**: the chat and embeddings handlers take the file's route from the registry and
  apply the project's active override: its policy, and its targets in its order, keeping only
  deployments enabled on this gateway; if none is left, the file's route. Capability filters,
  breakers, quotas, the budget's cheapest-first rule and the retry budget apply as before.
- **Reloading**: each instance keeps the active overrides in memory. It loads them at start in the
  background (with Postgres down, the file's routes apply and loading is retried), reloads one
  project's when a `routes` message arrives on the existing invalidation channel (the instance that
  made the change reloads before answering), reloads all after a reconnect of that channel, and
  reloads all every `ROUTE_OVERRIDES_REFRESH_MS` (30 s) in case a message is lost.
- **API and dashboard**: `GET /admin/projects/:projectId/routes` and `.../routes/:model/history`
  for viewers; `PUT .../routes/:model`, `POST .../rollback` and `POST .../reset` for admins. The
  Models page has an editor (model, policy, ordered targets with weights and last resort, save,
  reset) with the history and rollback; viewers see it read-only.
- `ROUTE_OVERRIDES_ENABLED` (true) switches it off: every project uses the file, and changes are
  refused with 409.

## Alternatives considered

- Editing the models file from the dashboard: global, not per project, and it would expose URLs
  and key names; a redeploy would also undo it.
- Reusing `routing_policies`: its shape (one policy row per model, no versions) and its CHECK do
  not fit; a new table keeps the old one untouched (migrations only add).
- Overrides in Redis: small, and they must outlive a Redis restart; Postgres is the record and
  Redis only carries the reload message.
- Reloading only on messages: a message lost while an instance reconnects would leave it on the old
  route until restart; the interval bounds that.

## Consequences

- A change reaches every instance within about the time a Redis message takes, and within
  `ROUTE_OVERRIDES_REFRESH_MS` if the message is lost.
- An override keeps working while its deployments exist in the file; one removed from the file is
  skipped, and an override with none left falls back to the file's route.
- Per-instance routing state (peak EWMA estimates, latency, retry budgets) is kept per deployment,
  so a project that reorders a route does not reset what other projects measured.
- Tested: `routing/overrides.test.ts` (validation, applying an override, disabled deployments, off),
  `test/route-overrides.test.ts` with two gateway instances sharing Postgres and Redis (a change
  through one used by the other within seconds; rollback and reset; a change written without a
  message picked up within the interval; an invalid override and a viewer refused),
  `test/admin.test.ts` (other projects get 404, viewers 403, every change audited), the dashboard's
  page tests and `e2e/routing.spec.ts` in Chromium at 375 px.
