# ADR 036: A Helm chart, tested on a kind cluster in CI

- Status: accepted
- Date: 2026-11-10
- Milestone: M17

## Context

The gateway runs on Render (one container) and has Compose files and a never-applied Terraform
setup for AWS (ADR 022). Teams that run Kubernetes need a way to install it that sets the things
the code depends on: readiness on `/ready`, a drain on SIGTERM (`SHUTDOWN_TIMEOUT_MS`), a separate
worker, and secrets kept out of manifests. A chart nobody installs in CI drifts from the code.

## Decision

- **Chart** `infra/helm/ai-gateway`: a gateway Deployment and Service, a worker Deployment (when a
  worker image is set; otherwise the gateway runs the consumer in-process), the models file as a
  ConfigMap mounted read-only at `MODELS_CONFIG_PATH`, an HPA on CPU, a PodDisruptionBudget, and
  `values.schema.json`.
- **Secrets** are referenced by name (`secretName`), never created: `DATABASE_URL`, `REDIS_URL`
  and `API_KEY_PEPPER` (and optional provider keys) come from an existing Secret through
  `envFrom`.
- **Probes**: readiness `/ready` (Postgres and Redis reachable), liveness and startup `/health`.
  The worker serves only `/metrics`, which may need a token, so its probes connect to that port.
- **Shutdown**: a preStop `sleep` (5 s by default) lets endpoints stop sending traffic before
  SIGTERM; the termination grace period is the preStop wait plus the drain time plus 10 s (25 s by
  default), so the drain is never cut by SIGKILL. This closes the M10 note about a missing pre-stop
  delay, on Kubernetes.
- **Hardening**: non-root user 1000, read-only root filesystem (an `emptyDir` at `/tmp`), no
  privilege escalation, every capability dropped, the RuntimeDefault seccomp profile, no service
  account token. The schema refuses values that turn these off.
- **Resources**: requests and limits for both processes; the HPA scales the gateway on CPU
  (70% of requests, 2 to 6 replicas by default), and the PDB keeps one gateway up.
- **CI** (job "Helm chart"): `helm lint --strict`; `helm template` with values the schema must
  refuse; then a kind cluster (pinned kind release and node image digest, checksums checked), the
  gateway and worker images built from the Dockerfile and loaded, test-only Postgres and Redis
  (`infra/helm/ci`), a server-side dry run of every rendered manifest, `helm install --wait`, one
  chat request with a throwaway bootstrap key through the Service, and its usage row awaited in
  Postgres. The cluster is deleted at the end.

## Alternatives considered

- Plain manifests or Kustomize: no values schema and no templating for the grace period and the
  in-process worker switch.
- Creating the Secret from values: secrets would sit in values files and Helm release records.
- A real cluster in CI: costs money; kind is free and close enough for probes, rollouts and the
  request path.

## Consequences

- The chart is installed and exercised on every push; a broken probe, port or setting fails CI.
- The published image is the gateway's; a separate worker needs its image built from the
  Dockerfile's `worker` target (CI builds both).
- kind has no metrics server, so the HPA is not exercised there (it is rendered and validated).
