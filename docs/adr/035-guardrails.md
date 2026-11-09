# ADR 035: Guardrails before and after the model, and on streamed answers

- Status: accepted
- Date: 2026-11-09
- Milestone: M16

## Context

Projects send prompts that can hold personal data (email addresses, phone numbers, payment cards,
Indian Aadhaar numbers and PANs) to third-party providers, and ask for JSON answers that providers
do not always produce. Owners want, per project, to keep such values from reaching a provider, to
refuse some requests outright, to catch broken JSON, and to see what was done, without the gateway
itself becoming a store of the data it protects.

Formats and their sources are listed in docs/ROADMAP.md ("M16 plan", checked 2026-11-09): UIDAI
(12 digits, Verhoeff check), the Income Tax Department (PAN: five letters, four digits, a letter),
the Department of Telecommunications' numbering plan (10-digit mobile numbers, series 6 to 9),
ITU-T E.164 (at most 15 digits), ISO/IEC 7812 (cards of 12 to 19 digits, Luhn check) and the HTML
Standard's valid email address. Where an official page could not be read, the narrower pattern was
used and the choice is recorded in PLAN-NOTES.

## Decision

- **Policy**: per project, in `projects.guardrails` (jsonb, `{}` by default: nothing runs), set
  by project admins on the Security page (`PUT /admin/projects/:projectId/guardrails`, audited)
  and loaded with the API key, so a change reaches every instance through the key cache's
  invalidation message. `GUARDRAILS_ENABLED` (true) turns the feature off for every project.
- **Before the model**: each detector is `off`, `mask` (a typed placeholder such as `[EMAIL]`),
  `block` (400 `guardrail_blocked`, naming the type, never the value) or `flag` (recorded only);
  blocked words and phrases (case-insensitive, whole words) `block` or `flag`; a cap on estimated
  prompt tokens (400 `guardrail_prompt_too_large`). The checks read every text a provider would
  see: message text in every role (strings and text parts), tool results and earlier tool-call
  arguments, and embeddings input. Images are not read; their count is recorded. Card and Aadhaar
  numbers count only when their check digit is valid; a value that fails its checksum is left as
  it is.
- **Order**: after authentication and admission, before the idempotency fingerprint, the cache
  key, coalescing and routing. The masked request is what is hashed, cached, coalesced, stored for
  replays and sent; the unmasked one is never kept.
- **After the model**: for `json_schema` requests the answer must parse and match the schema
  (Ajv 8.20.0, MIT, already in the lockfile through Fastify); for `json_object` it must parse.
  Per project: `flag`, or `retry` once on the route's next deployment (the one that answered is
  left out) and then 502 `guardrail_output_failed`. The detectors run on answers (text and
  tool-call arguments) with `mask` or `flag`. Answers are masked before they are cached, shared
  with coalesced followers or stored for an Idempotency-Key.
- **Streamed answers**:
  - Masking holds back the last `MAX_MATCH_LENGTH` (256) characters of each channel (the content,
    and each tool call's arguments): the longest a match can be (an email address of 254
    characters, RFC 5321), moved back further to the start of any match that reaches past it.
    Everything before that is sent on with values replaced; the rest is sent, masked, just before
    the finish event. A value split across chunks is therefore found whole. The client sees text up
    to 256 characters later than without masking, and a short answer only at its end.
  - A schema check needs the whole answer, but a stream cannot be retried once its first byte is
    sent (ADR 011). So a streamed `json_schema` or `json_object` request whose policy is `retry` is
    called upstream without streaming, checked (and retried) like any other, then replayed to the
    client as a stream, as cache hits are; its first token comes with the whole answer. With `flag`
    the stream is not delayed: the check runs when it has ended and is only recorded.
- **Records**: per request, which checks found something and what they did (stage, check, count,
  action), in the usage event and then in `guardrail_results` (migration 0016); never a value.
  The Security page lists flagged, blocked, masked and retried requests with filters (`GET
  .../guardrails/results`), and the Overview page shows how many requests were blocked, flagged and
  masked in the range (`GET .../guardrails/summary`).

## Measured cost

`pnpm bench:guardrails` (bench/guardrails.ts; its output is `bench/guardrails-latency.json`) runs
the input checks with every detector on `mask` and three blocked phrases, over prompts with an
email, phone, card and PAN every ~1,900 characters. On this laptop (Node 22.16.0, Intel Core
i3-1115G4, 4 cores), as written in that file on 2026-11-09: 10,000 characters p50 0.73 ms (p95
1.19 ms); 100,000 characters p50 4.81 ms (p95 7.73 ms); 400,000 characters p50 20.25 ms (p95 28.03
ms). That is small next to a model's latency (ADR 019); requests with no checks on skip the scan.

## Alternatives considered

- Masking streams per chunk: a value split across two chunks escapes.
- Buffering every streamed answer whose policy masks: correct but loses streaming entirely;
  holding back 256 characters keeps it.
- Ending a stream with an error event when its JSON fails the schema: the client has already
  received the text, so it is not a retry; calling without streaming keeps `retry` honest.
- Storing the values found (or their hashes) for review: a hash of a 12-digit number is easily
  reversed, and the point is that the gateway does not keep them.
- Named-entity models for detection: no free model, and false positives on numbers are already
  limited by the checksums.

## Consequences

- Masked values never reach a provider, the cache, a replay or a log; only types and counts are
  kept.
- Masking and blocking change what the model sees: a model asked to "repeat my email" answers with
  `[EMAIL]`.
- Numbers that happen to pass a checksum (about one in ten 12-digit numbers passes Verhoeff, one in
  ten 12-to-19-digit numbers Luhn) are treated as that type; the action is the project's choice.
- A `retry` costs a second provider call when the first answer is invalid.
- Tested: `guardrails/detectors.test.ts` (each detector with valid and invalid checksums, grouped
  and split numbers, priorities, whole-word terms), `guardrails/scan.test.ts` (every role, tool
  results and arguments, images, blocking messages, stream hold-back across chunks, schema
  checks), `proxy/guardrails.test.ts` (through the handlers: what the provider received for every
  detector, block and flag, blocked words, the prompt cap, embeddings, the cache never holding an
  unmasked value, schema retry and failure, a value split across stream chunks),
  `test/guardrails.test.ts` (the admin API, the results and counts against Postgres) and the
  worker's `test/guardrail-records.test.ts`.
