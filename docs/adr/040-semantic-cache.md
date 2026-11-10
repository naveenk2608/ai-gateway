# ADR 040: Semantic cache in Postgres with pgvector, opt-in, with a measured false-hit rate

- Status: accepted
- Date: 2026-11-10
- Milestone: M18

## Context

The exact cache (ADR 013) answers only byte-identical requests. Requests that ask the same thing in
other words, or with other casing or punctuation, each go upstream. ADR 013 left a semantic
(embedding) cache as future work "with a measured false-hit rate": answering a request from a
different but similar one is a wrong answer when the two only look alike. M13 added embeddings
(ADR 029), and coalescing (ADR 031) already shares calls between identical requests in flight.
Redis on the free host is small and fails closed when full (ADR 010), so vectors cannot live
there. Neon offers pgvector on every plan, including Free (pgvector 0.8.0 on Postgres 16 and 17;
<https://neon.com/docs/extensions/pgvector>, checked 2026-11-10).

## Decision

- **Where**: vectors and answers in Postgres, table `semantic_cache_entries`, with pgvector.
  Migration 0018 creates the `vector` extension where the server offers it and the role may, and
  the table only where the type exists, so a Postgres without pgvector still migrates; the
  gateway then logs that the cache is unavailable. No vector index: vector sizes depend on the
  embedding model (Gemini's 3,072 is above the 2,000 dimensions HNSW and IVFFlat take for
  `vector`), and each project's row cap bounds the scan. CI, Compose and the kind job use
  `pgvector/pgvector:0.8.6-pg16`, pinned by digest.
- **Switches**: `SEMANTIC_CACHE_ENABLED` (false) for the gateway; per project, `mode` `off`
  (default), `header` (only requests sending `x-gateway-semantic-cache: on`) or `all` (every
  eligible request unless it sends `off`), a threshold (null: the measured default), a TTL (1 h,
  as the exact cache) and a row cap (1,000), set by project admins (audited) and loaded with the
  API key.
- **Which requests**: those the exact cache would take (temperature 0 or `x-gateway-cache: on`,
  never `off`), after an exact-cache miss (or with the exact cache off), whose last message is a
  user message of text only, and which send no tools (tool calls carry arguments taken from the
  text). The lookup runs after coalescing has chosen a leader, so followers wait for its answer
  and a burst makes one embedding call. It runs after the guardrails, so a masked value is never
  embedded.
- **What is compared**: only the last user message's text is embedded. Everything else (the
  project, the logical model, the system prompt and earlier messages with roles and names, every
  parameter, the embedding model) goes into a SHA-256 context key, the exact cache's key over the
  request with that text left empty, which must match exactly. A hit is the nearest unexpired
  entry with the same project, model and context key whose cosine similarity
  (`1 - (embedding <=> query)`) is at or above the threshold.
- **The embedding call** goes through `SEMANTIC_CACHE_EMBEDDING_MODEL`'s route (breakers, quotas,
  the request's remaining deadline) with one try, on a trace of its own so it is never an attempt
  of the chat request. Any failure of the call or the query makes the request a normal miss
  (`outcome: error`).
- **Storing**: on a miss, the complete answer (from either path, after the output guardrails) is
  stored with the vector already computed, then the project's expired rows and its oldest rows
  beyond the cap are deleted. The worker deletes expired rows on its retention schedule. Prompts
  are never stored; vectors, texts and answers are never logged.
- **Answers and accounting**: a hit is answered as an exact hit is (JSON, or replayed as a
  stream), with `x-gateway-cache: semantic` and `x-gateway-semantic-similarity`, and recorded
  like a cache hit (`cache_hit`, no attempts, a zero-cost usage row with the stored answer's
  tokens). The usage event carries `semanticCache`: outcome, similarity, the embedding call
  (deployment, provider, model, billing, tokens) and, on a hit, who made the stored answer. The
  worker stores it on the request record (migration 0018 columns), prices the embedding call at
  the price in effect when the request started (ADR 016; billed 0 on a free tier, ADR 024), adds
  it to the project's budget spend, and stores for a hit what the stored answer's tokens cost at
  its model's price (the cost avoided). The admin summary and the Cost page show hits, misses,
  errors, the embedding cost of every lookup, the cost avoided and the net, which can be negative.
- **The default threshold is measured**, not chosen: hand-labelled pairs in `bench/semantic/`
  (surface variants and paraphrases that should hit, near misses such as kilometres to miles and
  miles to kilometres that must not), vectors computed once and committed, and
  `pnpm bench:semantic` with a CI test that recomputes the hit and false-hit rates per threshold
  (`bench/semantic/results.md`). The default is the lowest threshold measured that answers no near
  miss. The vectors come from `nomic-embed-text` v1.5, the model of the free local
  `ollama-nomic-embed-text` deployment and the default `SEMANTIC_CACHE_EMBEDDING_MODEL`, computed
  locally (no provider keys were available) and recorded with the model revision and date.

## Alternatives considered

- Vectors in Redis (RediSearch or a list per project): the free Redis is small, refuses writes when
  full and takes limits and budgets down with it (ADR 010).
- Embedding the whole conversation: a long shared history makes every request look alike, and a
  different system prompt or earlier answer would still be "similar"; the exact context key keeps
  those apart.
- A threshold picked by hand, such as 0.9 or 0.95: on the labelled set they answer about a third
  and a quarter of the near misses, which is a wrong answer each time.
- An HNSW index: faster nearest-neighbour search, but approximate, limited to 2,000 dimensions, and
  not needed for at most `maxEntries` rows per project and context.
- Retrying the embedding call: a lookup is an optimisation; a failure costs only the miss.

## Consequences

- Measured on the labelled set with `nomic-embed-text`, near misses (direction swaps, other
  numbers, other entities) are as close as paraphrases or closer, so the default threshold is
  high: it catches the same question with other casing, spacing or punctuation and few or no
  paraphrases (`bench/semantic/results.md` and the README give the measured rates). Lower
  thresholds are a project's informed choice. A threshold measured for one embedding model does
  not carry over to another; `bench/semantic/embed.ts` recomputes the vectors through a gateway.
- Every lookup costs an embedding call and its latency, hit or miss, which can outweigh what the
  hits save; the Cost page shows the net.
- Vectors reveal roughly what a text said (embedding inversion), and answers are kept for the TTL:
  one reason the cache is opt-in per project and off on the demo.
- The embedding call's cost is not reserved at admission; the worker adds it to spend after.
- Embedding calls are not in the analytics rollups or the spend chart; the semantic cache panel
  shows them.
- Tested: `src/semantic/semantic-cache.test.ts` (which text is embedded, the context key, the
  policy and header, threshold decisions, failures), `test/semantic-cache.test.ts` against
  Postgres with pgvector (hits answered plain and streamed; no hit across projects, models or
  parameters; the threshold both ways; modes and headers; one embedding call for a burst; a
  streamed miss stored; an embedding failure falling back; TTL, the worker's pruning and the row
  cap; the request records, the usage rows, the budget spend and the admin summary), and
  `bench/semantic.test.ts`.
