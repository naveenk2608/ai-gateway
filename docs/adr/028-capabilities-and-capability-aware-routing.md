# ADR 028: Per-deployment capabilities and capability-aware routing

- Status: accepted
- Date: 2026-11-06
- Milestone: M13

## Context

M13 accepts tools, JSON output (`response_format`) and image input on `/v1/chat/completions`. The
deployments behind one logical model differ: Groq's gpt-oss models call tools but take no images,
Gemini's take images but only as `data:` URLs on its OpenAI-compatible endpoint, Z.AI's free model
documents none of the three, and the mock is a last resort in most routes. Sending a tools request
to a deployment that cannot serve it fails at the provider with a 400, which the gateway never
retries or reroutes (ADR 011), so the request fails even when another deployment of the same model
could answer. Providers also differ in which request fields they take (`strict` on tools,
`parallel_tool_calls`, `tool_choice` values, the form of tool-call IDs, streaming of structured
output).

## Decision

- Each deployment in the models file has `capabilities`: `tools`, `json_object`, `json_schema`
  and `vision`, filled from the provider's docs for that exact model. Unknown is false; the mock
  has all four. Every value has its source in `docs/providers.md`.
- What a provider's API takes, as opposed to what its model can do, is a dialect in the adapter
  (`providers/dialects.ts`), keyed by the provider name and taken from the provider's docs:
  the `tool_choice` values it documents, whether it takes `strict`, `parallel_tool_calls` and
  images by URL, the tool-call ID form, and whether structured output can be streamed or combined
  with tools. Fields a provider does not document count as not taken.
- The adapter adapts what it can without changing what the request asks for: it drops `strict`
  and `parallel_tool_calls` where they are not taken, replaces tool-call IDs that do not fit the
  provider's form with derived ones (and turns them back in the answer), and sends a streamed
  `json_schema` request to a provider that cannot stream it as one plain call, replayed as a stream.
- Before admission, the route keeps only the deployments whose capabilities and dialect fit the
  request: tools (or a conversation that already holds tool calls or tool results), a
  `tool_choice` other than `auto`, a response format, images, images by URL. The others are named
  in the first try's routing reason, like breaker skips (`skipped x (no tools)`). The budget
  reservation and cost-aware ordering only see the deployments left.
- If none is left, the request gets 400 `model_capability_unsupported`, naming what the first
  deployment lacks and the field (`param`), before any provider call, quota count or reservation.
- Prompt estimates (limits and budgets) count tool definitions, tool calls, tool results and a
  `json_schema`, plus a fixed 2,048 tokens per image. Billing still uses reported usage.
- The exact-match cache key (ADR 013, version 2) covers tools, `tool_choice`,
  `parallel_tool_calls`, `response_format`, image parts, tool calls and tool results.

## Alternatives considered

- Pass everything through and let providers refuse: a refused request is a 400, which is not
  rerouted, so a model with one capable deployment would still fail when another one comes first.
- Fall back on a provider's 400: a 400 usually means the request itself is wrong, and retrying it
  everywhere would multiply failed calls (ADR 011).
- Capabilities per logical model: a model's deployments differ, and the point is to route between
  them.
- Silently dropping fields that change the answer (`tool_choice: "required"`, a JSON schema): the
  client would believe they took effect; the gateway's schema is strict for the same reason.
- Fetching image URLs for providers that take only `data:` URLs: the gateway would fetch
  arbitrary URLs on a client's behalf (server-side request forgery), with size and time limits to
  enforce.

## Consequences

- A capability the docs do not state stays false, so a deployment that could serve a request may
  be skipped; setting the flag in the models file (with its source) enables it.
- A route's mock fallback serves tools and JSON too, so `chat-default` answers a tools request even
  with no provider key, with the mock's fixed tool call.
- Dialect values are code, not config: a new provider that differs from OpenAI needs an entry.
- Tested: the schema; the assembler (pieces, whole calls, missing index or ID) and ID mapping; the
  OpenAI-compatible and Ollama request bodies and answers per dialect; the mock's tool calls and
  schema-shaped JSON; capability skips in the routing reason and the 400 with no provider call;
  the estimate and the cache key; and, with the OpenAI SDK, the tool loop by hand and with
  `runTools` (streamed and not), `json_schema`, and a tools request on a route without tool
  support.

## Note (2026-11-11, M19): a body limit that fits the image limits

The image limits above (3 images, 512 KiB per `data:` URL) did not fit the 1 MiB body limit every
route had, so a request with two full-size images already got 413. `POST /v1/chat/completions`
now has its own body limit, computed from the constants: `MAX_IMAGES_PER_REQUEST` x
`MAX_IMAGE_DATA_URL_BYTES` plus the 1 MiB other routes keep (2.5 MiB); every other route stays at
1 MiB. Before raising it, the handler was read for copies of the body: the guardrail input scan
and the provider request reuse the same strings, and the Idempotency-Key fingerprint, the exact
cache key and the semantic cache's context key each serialize the request only to hash it (they
keep the SHA-256 digest); nothing stores image data, and each attempt sends it upstream as
before. Tests: three 512 KiB images reach the mock, a chat body over the new limit gets 413, and
`/v1/embeddings` still refuses a body over 1 MiB.
