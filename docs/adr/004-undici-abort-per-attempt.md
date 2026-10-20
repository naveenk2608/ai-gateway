# ADR 004: undici with an AbortController per attempt

- Status: accepted
- Date: 2026-10-20
- Milestone: M1

## Context

Upstream model calls are slow and sometimes stall. A request whose client has gone away, or that
has run past its deadline, must stop at the provider too: otherwise it keeps a connection, a
concurrency slot (M4) and upstream cost busy for nothing. Streaming makes this harder, because a
long generation is normal and only silence is a problem.

## Decision

Upstream HTTP goes through undici's `request()` with one `Agent` (connection pool) per deployment.
Each attempt gets its own `AbortController`, aborted by whichever comes first:

- the client disconnecting (the response closes before it finished);
- the attempt's deadline: the whole response for non-streaming calls; for streams, the first
  event (`timeoutMs`) and then the gap between events (`streamIdleTimeoutMs`), so a long but
  steady generation is never cut off.

The attempt also races the provider call against its own abort, so the gateway answers on time
even if an adapter is slow to notice the signal. The in-process mock provider honours the same
signal, which is how tests count cancellations.

## Alternatives considered

- Node's global `fetch`: built on undici, but with no access to pool settings, and web-stream
  bodies for streaming.
- Provider SDKs: one client per provider with its own retry, timeout and error behaviour, which
  would have to be undone to normalize errors and apply our own policies.
- A single total timeout for streams: either kills long answers or waits far too long for a
  stalled one.

## Consequences

- Tested end to end: a client hanging up mid-stream, and a silent upstream hitting the timeout,
  both close the upstream connection.
- undici is pinned to 7.30.0; undici 8 requires Node 22.19 or newer.
- Timeouts live per deployment in `config/models.json`.
- Retries (M5, ADR 011) start from this boundary: an attempt fails before the first streamed byte
  with a normal HTTP error, so it can still be retried; after it, failures are reported in-stream.
