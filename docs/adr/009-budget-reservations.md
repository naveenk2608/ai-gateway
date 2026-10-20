# ADR 009: Budgets reserve the worst case in Redis and reconcile to actual

- Status: accepted
- Date: 2026-10-20
- Milestone: M4

## Context

A project's monthly budget must hold under concurrent requests on several instances, and the
true cost of a request is known only after it ends. Postgres learns costs later still, through
the usage pipeline (ADR 014). On hosts like Render's free plan, Redis keeps no data across
restarts, so totals kept only in Redis would silently restart from zero.

## Decision

- Budgets are per project per UTC calendar month (`projects.monthly_budget_micro_usd`), optional
  `max_request_cost_micro_usd` caps what one request may reserve. Money is integer micro-dollars.
- Before the call, the admission script (ADR 008) reserves the request's worst-case cost: the
  estimated prompt plus the output cap, at the price in effect (prices are held in memory and
  reloaded every `PRICES_REFRESH_INTERVAL_MS`). It admits only if `spent + reserved + new <=
  limit`. When the request ends, the reservation is released and the actual cost is charged.
- Reservations renew with the request's lease. A sweeper on every instance releases reservations
  whose request stopped renewing (its instance crashed) and records each as `expired` in
  `budget_reservations`; a request that finishes after all is charged and its row reconciled.
- Postgres is the durable ledger: the worker adds each new usage row's cost to
  `budget_periods.spent_micro_usd` in the same transaction as the row (only rows it inserted, so a
  re-delivered event adds nothing), and records each reservation with its actual cost.
- When the Redis totals for a month are missing (its first request, or Redis lost its data), the
  gateway rebuilds them from `budget_periods` before admitting, instead of starting from zero.
- Unpriced models cost nothing, in Redis and in Postgres alike. If prices could not be loaded yet
  (Postgres down at startup), budgeted requests follow the Redis fail mode (ADR 010).

## The bound

If every request costs at most what it reserved, spend never exceeds the budget. A request can
cost more than it reserved when the provider counts more prompt tokens than the gateway estimated,
or when its reservation expired while it still ran. Each such request was admitted while the
totals fit, so the overspend is at most the requests in flight at once times the most one request
can cost: **spend <= budget + in-flight requests x max request cost**. Set a project concurrency
limit and `max_request_cost_micro_usd` to make the bound concrete.

Two gaps are documented rather than hidden: after a rebuild, usage still in transit (events not
yet in Postgres) is not counted, normally under a second of traffic; and in `open` fail mode
budgets are not enforced while Redis is down.

## Alternatives considered

- Check `spent < limit` with no reservation: unbounded overspend with concurrent requests.
- Keep the totals in Postgres with row locks: a database write on the request path, and a hot row.
- Charge only after the call: the same unbounded race.

## Consequences

- Tested: a $1.00 budget with $0.05 requests admits exactly 20 of 100 parallel requests across two
  instances and records exactly $1.00; with requests that cost more than they reserved, spend stays
  within the bound above; when Redis loses the totals, they come back from Postgres and the budget
  still stops at the right request; expired reservations are swept once and audited.
- The request path touches Postgres only to rebuild a month's totals (first request of the month
  per project, or after a Redis restart).
