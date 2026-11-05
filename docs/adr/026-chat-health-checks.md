# ADR 026: A chat health check for providers that list models they will not serve

- Status: accepted
- Date: 2026-11-05
- Milestone: M12

## Context

ADR 012 probes an open breaker's deployment with a check that runs no model (`GET /models` for
OpenAI-compatible providers), so probes cost nothing on paid APIs, and a passing probe half-opens
the breaker. In M11's live checks, NVIDIA listed Nemotron 3 Super in `GET /models` but answered
every chat call for it with 404 for this account. Each passing probe half-opened the breaker that
the 404s had opened, so requests kept trying a deployment that could not answer. ADR 012 accepted
this cost ("one failed request per health-check interval"); with NVIDIA's model list it is every
interval, for as long as the deployment stays configured.

## Decision

- A deployment can set `healthCheck: "chat"`. Its probe sends one non-streamed request for the
  deployment's model with `max_tokens` 1, instead of `GET /models`.
- Like every probe, it runs only while the deployment's breaker is open, and at most once per
  `HEALTH_CHECK_CHAT_INTERVAL_MS` (60 s) per deployment, against 5 s for the free check. Its timeout
  is the deployment's own `timeoutMs` when that is longer than `HEALTH_CHECK_TIMEOUT_MS`, since a
  free endpoint can take tens of seconds to answer.
- The probe passes when the model answers, or when the provider refuses only the request (400):
  either shows the model is served. Any other failure keeps the breaker open until the next chat
  check has run (`holdOpen`), so the open period's timer does not half-open it in between.
- The probe counts against the deployment's free-tier quota and is skipped while that quota is
  used up or the deployment is on a 429 cooldown (ADR 025). A 429 from the probe starts a cooldown,
  and a skipped probe does not hold the breaker.
- NVIDIA's deployments use it. Every other deployment keeps `models` (or `none`, ADR 012).

## Alternatives considered

- Chat checks everywhere: on paid providers each probe is a billed call, and on free tiers it
  spends quota. Only providers known to list models they will not serve need one.
- Checking `GET /models` for the model ID: NVIDIA's list includes the model, so it would still
  pass.
- Taking a failing model out of its routes by hand (as M11 did with `chat-variety`): needed
  anyway, but the breaker should not keep reopening in the meantime.
- Never half-opening a breaker after `not_found`: an account can be granted the model later, and
  nothing would notice.

## Consequences

- While a chat-checked deployment is down, it costs one single-token request per
  `HEALTH_CHECK_CHAT_INTERVAL_MS`, counted in its quota; nothing while its breaker is closed.
- A deployment that recovers is noticed within `HEALTH_CHECK_CHAT_INTERVAL_MS` plus one
  `HEALTH_CHECK_INTERVAL_MS`, instead of `BREAKER_OPEN_MS`.
- A provider that refuses `max_tokens` 1 with something other than a 400 would fail every check;
  such a deployment should keep `models`.
- Tested: unit tests for the breaker's hold and the checker (one token asked for, counted in the
  quota, a 400 passing, the interval, a 429 cooldown, a skip); an integration test where a fake
  provider lists the model and answers 404, so the chat-checked breaker stays open while a
  `models`-checked one against the same provider half-opens.
