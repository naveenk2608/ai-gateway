# ADR 033: Webhook alerts through a Postgres outbox

- Status: accepted
- Date: 2026-11-09
- Milestone: M15

## Context

Owners learn that a budget is nearly spent, a provider keeps failing or usage events are being
lost only by opening the dashboard. They want a message where they already look (Discord, Slack,
or their own endpoint). Sending a webhook from the request path would add latency and lose the
alert when the receiver is down; the URLs hold the receiver's token, and letting a project admin
make the gateway call any URL is a server-side request forgery risk.

Sources, checked 2026-11-09:

- Discord, Execute Webhook (<https://docs.discord.com/developers/resources/webhook>): `content` of
  up to 2,000 characters; Allowed Mentions (<https://docs.discord.com/developers/resources/message>):
  `"allowed_mentions": {"parse": []}` suppresses every mention.
- Slack, incoming webhooks
  (<https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/>): a JSON body with
  `text`, answered with HTTP 200 and `ok`; `&`, `<` and `>` in text are escaped.
- Standard Webhooks (<https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md>):
  headers `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature` (`v1,` and the
  base64 HMAC-SHA256 of `id.timestamp.body`), secrets `whsec_` plus 24 to 64 random bytes in
  base64, a payload of `type`, `timestamp` and `data`, and a retry schedule of 5 s, 5 min, 30 min,
  2 h, 5 h, 10 h, 14 h, 20 h and 24 h with exponential backoff and jitter.
- Stripe, webhooks (<https://docs.stripe.com/webhooks>): its libraries reject a timestamp more than
  5 minutes from the receiver's clock; redirects are treated as failures.

## Decision

- **Destinations** belong to a project: a name, a kind (`discord`, `slack` or `generic`), an https
  URL and the events it gets (`budget`, `breaker`, `dead_letters`). Admins add, delete and test
  them; viewers see them. The URL and a generic destination's signing secret are stored encrypted
  with AES-256-GCM (random 12-byte nonce, 16-byte tag), table `alert_destinations` (migration
  0014). The key is `ALERTS_ENCRYPTION_KEY` (32 bytes, base64), or, unset, HKDF-SHA256 over
  `API_KEY_PEPPER` with the label `ai-gateway alert destinations v1`, so the demo needs no new
  setting. Changing either means entering the URLs again. The API returns only a masked hint
  (scheme, host, last 4 characters); the secret is returned once, when the destination is created.
  Audit rows name the destination, never its URL.
- **Events**, each detected where it is already known:
  - a project's monthly spend crossing 50, 80 and 100% of its budget: the worker, in the ingest
    transaction that adds the spend (spend before the batch is the new total less what the batch
    added), deduplicated per project, month and threshold, so each alerts once a month; it goes to
    that project's destinations;
  - a breaker opening: the gateway, at most once per deployment per `ALERTS_BREAKER_INTERVAL_MS`
    (15 minutes), deduplicated by the interval's number so several instances queue it once;
  - dead letters growing: the worker, when it dead-letters an event, at most once per
    `ALERTS_DEAD_LETTER_INTERVAL_MS` (1 hour), with the count of the last interval. Breaker and
    dead-letter alerts go to every destination that chose them, whatever its project: deployments
    and the pipeline are shared.
- **Outbox**: detection inserts one row per destination into `alert_deliveries`, unique on
  (destination, dedupe key). The worker (or the gateway with `RUN_WORKER_IN_PROCESS`) polls every
  `ALERTS_POLL_INTERVAL_MS`, claims due rows with `FOR UPDATE SKIP LOCKED` and leases them (a
  worker that dies mid-send leaves them due again), and sends each. A 2xx marks it delivered;
  anything else waits the next delay of the Standard Webhooks schedule, half of it plus a random
  part of the other half (the injected random), until `ALERTS_MAX_ATTEMPTS` (10, the schedule's
  length), then it is marked failed. Delivered and failed rows are deleted after
  `ALERTS_DELIVERY_RETENTION_DAYS` (30). "Send test" queues one test delivery.
- **Formats**: Discord gets `content` (cut to 2,000 characters) with mentions disabled; Slack gets
  `text` with its escapes; generic receivers get the payload as JSON, signed as Standard Webhooks
  describes, with the delivery's ID as `webhook-id`. Messages hold project names, thresholds,
  amounts, deployment names and counts: never prompts, keys or URLs.
- **SSRF**: before each send the URL must be https without credentials, and its host is resolved;
  if any address is private (RFC 1918), loopback, link-local, unique local (RFC 4193), shared
  (RFC 6598), reserved, documentation, multicast or a cloud metadata address (169.254.169.254,
  100.100.100.200, fd00:ec2::254), including IPv4-mapped and NAT64 forms, the delivery fails for
  good. The connection is pinned to the address checked (its DNS lookup returns it), so a DNS
  answer that changes between the check and the connection cannot redirect it. Redirects are not
  followed, a send has `ALERTS_SEND_TIMEOUT_MS` (5 s), and nothing of the reply is read beyond its
  status. A host that does not resolve is retried.
- `ALERTS_ENABLED` (true) switches detection and sending off. Nothing is sent until a project adds
  a destination, so it stays on for the demo.

## Alternatives considered

- Sending from the request path or the breaker's callback: latency and lost alerts when the
  receiver is down; the outbox makes delivery durable and retried.
- Redis for the queue: small and fails closed when full (ADR 010); alerts must survive a restart.
- Storing URLs in plain text with database access as the protection: a database dump would hand
  out every receiver's token.
- Allowing http and private addresses for self-hosted receivers: the SSRF risk outweighs it; a
  receiver on a private network can be reached through a public https endpoint.
- Our own signature header names: receivers can reuse Standard Webhooks libraries instead.

## Consequences

- A budget threshold alerts once a month per destination, a flapping breaker at most once per
  interval, and a receiver that is down gets the alert when it comes back (within about three
  days of retries).
- The standalone worker needs `API_KEY_PEPPER` or `ALERTS_ENCRYPTION_KEY` to send; without either,
  alerts are queued and stay pending (logged once).
- Changing the pepper or the key makes stored URLs unreadable: such deliveries fail with "cannot
  decrypt the URL" until the destinations are added again.
- Tested: `alerts/alerts.test.ts` (address rules, URL checks, Discord, Slack and signed formats, a
  signature that verifies and fails for a changed body or an old timestamp, thresholds) and
  `test/alerts.test.ts` in the worker (each threshold queued once, a failed delivery retried after
  the first delay and then delivered, a last attempt marked failed, refused addresses never sent,
  a changed key, dead-letter alerts once per interval) and in the gateway (encrypted storage,
  masked URLs, the secret shown once, https only, test deliveries, breaker alerts once per
  interval).
