# Service level objectives

Two SLOs for the gateway's /v1 API (M17, [ADR 038](adr/038-slo-burn-rate-alerts.md)), measured
from the gateway's own Prometheus metrics over a rolling 30 days. The rules are in
[infra/compose/observability/rules/slo.yml](../infra/compose/observability/rules/slo.yml) and their
unit tests in [slo_test.yml](../infra/compose/observability/rules/slo_test.yml); CI runs
`promtool check rules` and `promtool test rules` on every push.

| SLO | Indicator | Target | Error budget (30 days) |
| --- | --- | --- | --- |
| Availability | Share of /v1 requests (chat and embeddings) answered without a 5xx | 99.5% | 0.5% of requests (about 3.6 hours of total outage) |
| Latency | Share of streamed chat requests whose first token reaches the client within 5 s | 95% | 5% of streams |

- **Availability** counts `gateway_http_request_duration_seconds_count` for routes under `/v1/`.
  A 5xx is the gateway's or a provider's failure as the client saw it (502 from every provider
  failing, 503 with every breaker open or Redis down in closed mode, 504 at the deadline). 4xx
  answers (validation, limits, budgets, guardrails, 429 quotas) are the client's or the policy's,
  and count as served. Health checks and the admin API are not counted.
- **Latency** uses `gateway_ttft_seconds` (time from arrival to the first token sent; cache hits
  excluded) and its 5 s bucket. Non-streamed requests are not in this SLO: their duration is
  mostly the model's generation, which the client chose (`max_tokens`).
- **Why these targets**: the gateway routes to free tiers that fail and rate-limit often (M11 and
  M14 live checks); 99.5% leaves room for that while still flagging a deployment or the gateway
  being down. 5 s to a first token is the slowest the free hosted models answered in the M11 live
  checks except NVIDIA's (12 s and more), which a route can keep as a fallback.

## Alerts

Multiwindow, multi-burn-rate alerts, as the Google SRE Workbook's chapter "Alerting on SLOs"
recommends (<https://sre.google/workbook/alerting-on-slos/>, checked 2026-11-10): an alert fires
only when both a long window and a short one (1/12 of it) burn the budget faster than the
threshold, so it starts soon and stops soon after the problem ends.

| Alert | Severity | Fires when the error (or slow) ratio exceeds | Budget used when it fires |
| --- | --- | --- | --- |
| `GatewayAvailabilityBudgetBurn`, `GatewayLatencyBudgetBurn` | page | 14.4 x budget over 1 h and 5 min, or 6 x budget over 6 h and 30 min | 2% in 1 h, or 5% in 6 h |
| `GatewayAvailabilityBudgetBurnSlow`, `GatewayLatencyBudgetBurnSlow` | ticket | 3 x budget over 1 d and 2 h, or 1 x budget over 3 d and 6 h | 10% in 1 d, or 10% in 3 d |

With the availability budget of 0.5%, a page means more than 7.2% of requests failing for an hour
(or 3% for six hours); with the latency budget of 5%, more than 72% of streams slow for an hour (or
30% for six hours).

## Where they run

The rules load into the Compose stack's Prometheus (`docker compose --profile full --profile
observability up`; Grafana and Prometheus as in ADR 017). There is no Alertmanager in the stack:
firing alerts show on Prometheus's Alerts page (<http://127.0.0.1:9090/alerts>). The live demo has
no Prometheus (Render's free plan), so its SLOs are not evaluated there.
