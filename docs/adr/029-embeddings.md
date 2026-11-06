# ADR 029: Embeddings: routes that never mix models, input-only prices, exact caching

- Status: accepted
- Date: 2026-11-06
- Milestone: M13

## Context

M13 adds `POST /v1/embeddings` in OpenAI's format. Clients store embedding vectors in an index and
compare new vectors with them; a vector only means something next to vectors from the same model
at the same size. Chat routing (ADR 011) falls back freely between deployments of different
models, which is fine for text but would silently corrupt an index for embeddings: a fallback from
Gemini (3,072 numbers) to Mistral (1,024) or to the mock would return vectors that cannot be
compared with the ones already stored. Embedding providers price input tokens only. The free
providers the gateway uses document no per-request batch limit, and answers can be large (a
3,072-dimension vector is about 64 KB of JSON).

## Decision

- A deployment is `"type": "embeddings"` with `embedding.dimensions` (its vector size, from the
  provider's docs), optionally `dimensionsRange` (the sizes a client may ask for with
  `dimensions`; without it `dimensions` gets a 400) and `maxInputs` (a documented per-request
  limit). Deployments are `chat` by default.
- Config validation, at startup, refuses an embeddings model whose deployments differ in provider
  model, dimensions or range, or that mixes the mock with real deployments, and refuses any model
  that mixes chat and embeddings deployments. So an embeddings route can only fall back between
  deployments of the same model at the same size (another key, account or region). Each endpoint
  refuses the other's models with 400 `model_endpoint_mismatch`.
- A try whose answer has another number of vectors than inputs, or vectors of another size than
  configured (or requested), is an invalid response from that deployment (it counts against its
  breaker and can fall back), so a wrong size never reaches a client.
- The request uses the chat path's parts: key and allow-list, admission with the estimated input
  tokens and no output tokens (`clientMaxTokens: 0`), quotas and cooldowns, breakers, retries, the
  request deadline, and one usage event. The event carries `endpoint`, which the worker stores in
  `request_records.endpoint` (migration 0010, default `chat`, so older rows and events from older
  gateways read as chat).
- Prices: embedding models are priced on input only, so their `model_prices` rows have an output
  price of 0 (migration 0011, with the official list price, its source and date). Free-tier
  deployments are billed nothing and keep the list cost (ADR 024).
- Caps per request: 2,048 inputs and 300,000 estimated tokens (OpenAI's documented limits for this
  format, since none of the providers documents its own), the deployment's `maxInputs` if set, and
  inputs times dimensions at most 393,216, so an answer stays within the 10 MiB the gateway reads
  from a provider. Each input's own length is left to the provider.
- Cache (ADR 013): exact match on project, model, inputs in order, `dimensions` and
  `encoding_format`, used whenever `CACHE_ENABLED` is on unless the request sends
  `x-gateway-cache: off`. There is no temperature to check: a model gives one input the same vector
  each time. The entry holds the data as sent and the provider's usage; hits cost nothing.
- The gateway always asks providers for floats and encodes `base64` itself (little-endian float32,
  as OpenAI does), so every provider supports both encodings.
- The mock's vectors are deterministic: a PRNG seeded with a hash of the input, normalized to unit
  length, at the deployment's size or the requested `dimensions`.

## Alternatives considered

- Fall back between any embedding models, as chat does: answers would arrive, but an index built
  from one model would be queried with another's vectors, which fails silently.
- Pass `encoding_format: base64` through to providers: some document only floats, and the cache
  would need both forms anyway.
- Cache embeddings only at temperature 0 or with the opt-in header, as chat: there is no sampling,
  so that would only lower the hit rate.
- A separate budget for embeddings: one project budget with input-only prices keeps spend in one
  place.

## Consequences

- An embeddings model has no cross-provider fallback; when its one deployment is down, requests
  fail (503 once the breaker is open) rather than return incompatible vectors.
- Gemini's `gemini-embedding-001` vectors are 3,072 long, so a request holds at most 128 inputs.
- During a deploy, an old worker stores embeddings events as `chat` (the column's default) until
  the new one runs.
- Tested: config validation of mixed routes; the request schema and caps; adapters' request bodies
  and answers; the mock's vectors; the vector-size check; the reservation of input tokens only;
  and, with the OpenAI SDK against the gateway and worker, one input, a batch, base64 and
  `dimensions`, a rate limit, the per-request cost cap, the stored record (endpoint, tokens, cost)
  and the budget's spend, the admin APIs' `endpoint`, and a cache hit with no upstream call.
