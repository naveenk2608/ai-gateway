# ADR 022: AWS deployment layout, tested without an AWS account

- Status: accepted (the Terraform is written and tested with a mocked provider; it has not been
  applied to a real account)
- Date: 2026-10-31
- Milestone: M10

## Context

The gateway should have a documented AWS deployment that a fresh account can create and destroy
cheaply, with two gateway instances behind a load balancer so the distributed limits can be shown
across real machines. The project is built at zero cost: no AWS account is used while writing it,
and CI must never hold AWS credentials. The largest risk is an unexpected bill.

## Decision

Two Terraform root modules in `infra/terraform/`, sharing a network module and a Docker setup
script:

- **demo**: one EC2 instance (t3.small) runs the whole Compose stack (gateway, worker, Postgres,
  Redis) in a VPC with one public subnet. No NAT gateway, no load balancer, no managed data
  services. Port 80 is open only to `allowed_cidrs` (no default); there is no SSH, shell access is
  through Session Manager. Secrets are generated on the instance at first boot and never leave it.
- **full**: an ALB in front of two gateway instances in two zones, one worker instance, RDS
  Postgres and ElastiCache Redis in private subnets, an SQS usage queue with a dead-letter queue
  (ADR 023), Secrets Manager, CloudWatch logs and alarms, and an account-wide AWS Budgets alert.

Shared choices:

- **No NAT gateway.** Instances that need the internet (packages, the repository, model
  providers, AWS APIs) sit in public subnets with public addresses, and their security groups
  admit only the load balancer (gateways) or nothing (worker). RDS and ElastiCache sit in private
  subnets with no route out; they need none.
- **EC2 with Docker, not ECS.** Each instance builds its image from the repository at a pinned
  `git_ref` (the `m10-done` tag by default) on first boot. No image registry, no task
  definitions, and the same Dockerfile as everywhere else. Docker Compose and Buildx are
  downloaded at pinned versions and checked against their SHA-256 sums.
- **ALB settings for SSE.** Idle timeout 300 s (default 60 s), so a stream whose first token is
  slow is not cut. Health checks call `/ready`, so an instance that cannot reach Postgres or
  Redis stops receiving traffic. Deregistration delay 30 s, longer than the gateway's 10 s drain.
  HTTPS is used when an ACM certificate is given, and then the session cookie is HTTPS-only;
  `TRUST_PROXY=1` for the client IP in login limits.
- **Secrets.** RDS manages the database password in Secrets Manager
  (`manage_master_user_password`), so it never appears in Terraform's plan or state. The app
  secret (API key pepper, first admin password, Redis token, optional provider keys) is generated
  by Terraform into Secrets Manager. Instances read secrets at boot through their role; user data
  holds none. Each role is allowed only what it uses.
- **Hardening.** IMDSv2 only (two hops on full, so the container can use the role for SQS),
  encrypted volumes, TLS to RDS with the server certificate verified, TLS and a token for Redis,
  encrypted queues, the VPC's default security group emptied.
- **Cost bound.** An AWS Budgets alert for the whole account (80 % of actual spend, 100 % of
  forecast), CloudWatch alarms emailed through SNS, defaults that let `terraform destroy` remove
  everything (no deletion protection, no final snapshot), and log retention of 14 days.
- **Tests without AWS.** `terraform test` runs every setup against `mock_provider "aws"`; a
  schema-based script checks that every taggable resource is tagged, that there is no NAT
  gateway, and that the demo has no load balancer. CI runs fmt, validate, the tests and the
  check with no credentials.

## Alternatives considered

- ECS on Fargate: no instances to manage, but an image registry and a push step, and Fargate
  tasks in public subnets still pay for public addresses; more moving parts for a demo.
- Private subnets with NAT gateways: the usual layout, but at about $33 a month per zone
  before traffic it would be the largest line of the demo's bill. VPC interface endpoints for
  SQS, Secrets Manager and CloudWatch Logs cost about $7.30 a month each per zone and still leave
  model providers unreachable.
- Postgres and Redis as containers on the full setup's instances: cheaper, but the point of the
  full setup is two gateways sharing one Redis and one Postgres that survive an instance.
- A pre-built image in GHCR or ECR: faster boots, but publishing images is a release process the
  project does not have yet.
- Applying to a real account in CI: needs credentials in CI and costs money on every run.

## Consequences

- Nothing here has run on AWS. The mocked tests check the configuration (resources, wiring,
  policies, scripts), not that AWS accepts it or that the instances boot. The boot scripts in
  particular are untested on a real instance, and the M10 acceptance checks that need an account
  (apply, the k6 smoke test against the ALB, the two-instance limits test, destroy with nothing
  left billing) are not done; `docs/aws-deployment.md` describes them for whoever does.
- First boot takes several minutes: each instance builds its image. A newer AMI does not replace
  instances (`ignore_changes = [ami]`).
- Instances have public IPv4 addresses ($0.005 an hour each) and outbound internet access.
- The Terraform state holds the generated app secrets and the Redis token: keep it in an
  encrypted, access-controlled backend.
- x86_64 only: Graviton instances are refused until the setup script installs arm64 binaries.
- ElastiCache runs one node without failover, like the self-hosted Redis; a node replacement
  resets limits (budgets are rebuilt from Postgres).
