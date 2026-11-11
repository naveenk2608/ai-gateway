# ADR 032: Idempotency-Key for /v1 requests

- Status: accepted
- Date: 2026-11-09
- Milestone: M15

## Context

A client that loses its connection while a chat or embeddings request runs cannot tell whether the
gateway called the provider. If it retries, the request runs again: a second call, a second use of
the free quota and a second charge. The cache (ADR 013) and coalescing (ADR 031) help only for
requests that accept a reused answer (temperature 0), and only while an entry or a flight exists.
Payment APIs solve this with an idempotency key the client sends with each request.

Sources, checked 2026-11-09:

- IETF draft "The Idempotency-Key HTTP Header Field", version -08 of 2026-10-22
  (<https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/>): the field is an
  RFC 9651 Item whose value MUST be a String; a resource SHOULD answer 409 while the first request
  is still being processed and 422 when a key is reused with a different payload; the fingerprint
  and the expiry policy are the resource's to define and publish. It names no header for a
  replayed response.
- RFC 9651, section 3.3.3 and 4.2.5 (<https://www.rfc-editor.org/rfc/rfc9651.html#name-strings>):
  a String is quoted, holds printable ASCII (%x20-7E), and only `\"` and `\\` are escapes.
- Stripe (<https://docs.stripe.com/error-low-level>, <https://docs.stripe.com/api/idempotent_requests>):
  a replay carries `Idempotent-Replayed: true`; keys are kept for at least 24 hours; keys are up to
  255 characters.

## Decision

- **Where**: `POST /v1/chat/completions` and `POST /v1/embeddings` accept an optional
  `Idempotency-Key`. It is parsed as the draft's String: one quoted string of 1 to 255 printable
  ASCII characters (255 is Stripe's limit), with no parameters after it. Anything else is 400
  `invalid_idempotency_key`, before limits are spent. `IDEMPOTENCY_ENABLED=false` ignores the
  header.
- **Scope and fingerprint**: a key belongs to a project and an endpoint, so two projects (or chat
  and embeddings) never share one. The fingerprint is a SHA-256 of the validated body without
  `stream`, `stream_options` and `user` (fields the cache key also leaves out), with object keys
  sorted. The same key with another fingerprint is 422 `idempotency_key_reused`.
- **Order**: after authentication, the model checks and admission (a replay counts toward request
  limits, as a cache hit does), before the cache, coalescing and routing.
- **Storage**: Postgres, table `idempotency_keys` (migration 0013), never Redis (small free Redis,
  ADR 010). The first request inserts its row `in_progress` with its instance and a lock until
  `IDEMPOTENCY_LOCK_MS` (10 minutes); the unique (project, endpoint, key) constraint makes that the
  only lead across instances. A 2xx answer is stored with its status, the routing headers a replay
  repeats (`x-gateway-deployment`, `x-gateway-fallback-from`) and the answer itself (for chat the
  response ID, creation time and the assembled answer; for embeddings the data as sent and usage),
  so a replay can be JSON or a stream whatever the first request asked for. A failure deletes the
  row, so the client may retry with the key.
- **Above the cap**: an answer larger than `IDEMPOTENCY_MAX_BODY_BYTES` (256 KiB, like the cache's
  entry cap) is not kept; the row stays completed without it and a repeat gets 409
  `idempotency_answer_not_stored`. Running the request again would charge it twice, which the key
  exists to prevent; the message tells the client to use a new key.
- **A client that leaves**: with a key, the client leaving does not cancel the upstream call. It
  runs within its deployment timeouts and `REQUEST_DEADLINE_MS`; a stream is read to its end in
  the background (the coalescing code's shared stream, ADR 031). The answer is stored and the
  request recorded `canceled` (499) with its attempt, usage and cost, so the retry gets the answer.
- **Repeats while the first runs**: on the same instance a repeat waits for the first request's
  answer (a coalescing `Flight`), within its own deadline; past it, or when the first runs on
  another instance, it gets 409 `idempotency_key_in_progress` with `retry-after` (the seconds left
  of the first request's deadline, at least 1). A lock older than `IDEMPOTENCY_LOCK_MS` (a crashed
  instance) is taken over by the next request with the key.
- **Replays** are answered like a cache hit, with `Idempotent-Replayed: true` (Stripe's documented
  name, since the draft names none), the same response ID, and recorded at zero cost with no
  attempts and `request_records.replayed` (migration 0013) and `replayed: true` on the usage event.
- **Expiry**: keys expire `IDEMPOTENCY_KEY_TTL_HOURS` (24, Stripe's documented window) after their
  first use; an expired key is treated as new, and the worker deletes expired rows in batches with
  its hourly rollup retention.
- **Postgres down**: a request with a key gets 503 `idempotency_unavailable` (retryable), since
  running it unchecked could charge it twice. Requests without the header are unaffected.

## Alternatives considered

- Keys in Redis: faster, but the free Redis is small, refuses writes when full and the gateway
  fails closed when it does (ADR 010); answers kept 24 hours do not belong there.
- Storing the raw response bytes: a stream's bytes cannot be replayed as JSON (or the other way
  round), and an SSE body is larger than the answer it carries.
- Replaying stored errors as Stripe does: a provider's 5xx or 429 says nothing about a later try,
  and the draft leaves it open; releasing the key lets the retry run.
- Running the request again above the size cap: a second charge, the thing the key prevents.
- Waiting across instances through Redis pub/sub: one instance serves the demo; the 409 with
  `retry-after` is what the draft describes for a request still being processed.

## Consequences

- A retried request with the same key and body is charged once, also when the client left before
  the answer came.
- Every request with a key costs one or two Postgres round trips before routing.
- A crashed instance's keys stay `in_progress` until their lock ends (10 minutes); repeats until
  then get 409.
- Tested: `proxy/idempotency.test.ts` (parsing, fingerprint) and `test/idempotency.test.ts` against
  Postgres and Redis (one call and one charge for a repeat, also asked as a stream; 422 for another
  body and 400 for a malformed key; a repeat waiting on the same instance; 409 while another
  instance holds the key; a client leaving mid-stream; a failure releasing the key; expiry and the
  worker's deletion; two projects with one key; an answer above the cap; embeddings).

## Note (2026-11-11, M19): a replay is the first answer as the guardrails allow it now

A replay is the first request's answer as the project's output guardrails (ADR 035) allow it when
the replay is served: if output masking was turned on after the answer was stored, the replay is
masked, and its findings are recorded on the replaying request. The stored row keeps what was
stored; the answer is masked on the way out, so turning masking off later serves it as first sent.
The JSON schema check is not repeated. Everything else a replay repeats (status, routing headers,
the response ID) is unchanged (`test/idempotency.test.ts`).
