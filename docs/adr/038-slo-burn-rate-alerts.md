# ADR 038: SLOs with multiwindow, multi-burn-rate alerts

- Status: accepted
- Date: 2026-11-10
- Milestone: M17

## Context

The Grafana dashboard (ADR 017) shows rates and percentiles but nothing tells anyone when users
are hurt: there were no alert rules (PLAN-NOTES, M8). Alerting on raw error rates either pages on
every blip or reacts hours late.

## Decision

- Two SLOs, defined in `docs/slo.md`: availability (99.5% of /v1 requests without a 5xx) and
  latency (95% of streamed chat requests with a first token within 5 s), over 30 days.
- Recording rules compute the error and slow ratios over 5 min, 30 min, 1 h, 2 h, 6 h, 1 d and 3 d
  from the gateway's existing histograms (`gateway_http_request_duration_seconds`,
  `gateway_ttft_seconds`); no new metric.
- Alerts follow the Google SRE Workbook's recommended multiwindow, multi-burn-rate parameters
  (<https://sre.google/workbook/alerting-on-slos/>, checked 2026-11-10): page at 14.4x over 1 h and
  5 min or 6x over 6 h and 30 min; ticket at 3x over 1 d and 2 h or 1x over 3 d and 6 h. No `for:`
  clause: the short windows provide the reset.
- `promtool check rules` and `promtool test rules` run in CI, with unit tests for a fast burn, a slow
  burn, a healthy day and a latency burn. The Compose Prometheus loads the rules.

## Alternatives considered

- Static thresholds on error rate or p95 latency: either noisy or slow, and not tied to a budget.
- A single burn-rate window: fires late or keeps firing long after recovery.
- Including non-streamed request duration in the latency SLO: it mostly measures how many tokens
  the client asked for.

## Consequences

- An owner with Prometheus gets a page for fast budget burn and a ticket for slow burn, with
  documented targets to change.
- No Alertmanager is shipped: alerts show in Prometheus; routing them is left to the deployment.
- The live demo has no Prometheus, so its SLOs are not evaluated.
