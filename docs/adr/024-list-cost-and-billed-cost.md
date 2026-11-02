# ADR 024: List cost and billed cost; budgets count list cost

- Status: accepted
- Date: 2026-11-03
- Milestone: M11

## Context

The demo runs on free tiers (Groq, Gemini, Mistral, NVIDIA, OpenRouter `:free`, Cloudflare,
Z.AI). Until M11 every request was costed at the model's price (ADR 016), so the dashboard showed
spend that nobody paid, and there was no way to tell it apart from real spend. Showing $0 instead
would make budgets meaningless on a free tier and hide what the traffic would cost on a paid plan.
Some free endpoints have no per-token price of their own (NVIDIA's, OpenRouter's `:free` models,
Z.AI's GLM-4.7-Flash), and some models have no paid price anywhere.

## Decision

- Each deployment in the models file sets `billing: free_tier | paid` (default `paid`, so a
  forgotten setting never under-counts). The gateway puts the deployment's billing on each attempt
  of the usage event.
- The worker stores two costs per request, both fixed at ingest:
  - **list cost** (`cost_micro_usd`, unchanged meaning): tokens at the `model_prices` version in
    effect when the request started (ADR 016); null when the model has no price or usage is
    missing;
  - **billed cost** (`billed_cost_micro_usd`): 0 on `free_tier`, the list cost on `paid`.
  The billing itself is stored on the usage row. Because both come from the event, changing a
  deployment's billing later never changes past rows, and a re-delivered event changes nothing
  (ADR 014).
- Rollups, the analytics API and the dashboard report list cost, billed cost and **saved** (list
  minus billed), plus the number of requests with usage but no list price. A model with no price
  shows "no list price", never a $0 that looks like a price.
- **Budgets count list cost**, as they did before: reservations (ADR 009) and the monthly ledger
  use the list price, so a budget on a free tier still stops traffic at the configured amount.
- List prices for free endpoints come from, in order: the provider's own price for the paid
  version of the same endpoint; the model maker's own paid API price (DeepSeek's for the NVIDIA
  DeepSeek deployment); OpenRouter's paid listing of the same model (`/api/v1/models`). With none,
  the model has no list price. Each price row records its source and the date it was checked.
- Rows ingested before M11 had no billing; their billed cost is set to their list cost, which is
  how they were counted then.

## Alternatives considered

- Bill $0 for free tiers and drop the list price: budgets would never trigger on the demo, and the
  dashboard could not say what the traffic would cost on a paid plan.
- Budgets on billed cost: correct for money, but a free tier's budget would never move, so the
  feature could not be shown or tested on the demo. A per-project choice can be added later.
- Compute billed cost at query time from the current models file: past rows would change when a
  deployment moves from a free tier to a paid one, which ADR 016 rules out.
- A price of $0 for models without one: indistinguishable from a real free price, and silently
  lowers totals.

## Consequences

- A budget on a free tier is enforced against money that is not actually spent; the dashboard
  labels it as list cost so this is visible. A project that pays for some providers and not others
  sees both numbers side by side.
- Unpriced requests add nothing to list cost or budgets (as in ADR 009); the dashboard counts them
  separately instead of hiding them.
- Tested: free-tier, paid and pre-M11 events, an unpriced model, rollup sums and a re-delivered
  event in the worker; a database migrated to M10 keeps every id, price and cost through the M11
  migrations; a free-tier request through the gateway and worker shows a list cost and $0 billed.
- A deployment whose key moves to a paid plan must change its `billing` to `paid`; requests before
  the change keep their recorded billed cost.
