# ADR 016: Versioned prices, cost fixed at ingestion

- Status: accepted
- Date: 2026-10-20
- Milestone: M3

## Context

Provider prices change. A report of last month's spend must not move when today's price does,
and every cost must be traceable to the price that produced it.

## Decision

- `model_prices` rows hold a provider, the provider's model name, input and output prices in
  integer micro-dollars per million tokens, and `effective_from`. A trigger rejects `UPDATE`: a
  price change is a new row.
- The worker costs each request with the latest version whose `effective_from` is not after the
  request's start time, so late events still get the price of their time, and stores both the
  cost and that version's `price_id` on the usage row.
- Cost = ceil((prompt × input + completion × output) / 1,000,000), computed in integer
  arithmetic; no floating-point money.
- No price for the model, or `missing` usage: the cost is null, not zero.

## Alternatives considered

- Compute cost at query time: past reports change with every price edit.
- A single current price per model: no history to audit.

## Consequences

- Tested: changing a price leaves earlier costs unchanged, late events use the old price, and a
  price row cannot be edited.
- Prices are added with SQL or `pnpm db:seed` (demo mock prices) until the settings pages (M7).
- Estimated usage gets an estimated cost; `usage_source` says which.
