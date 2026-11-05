# ADR 027: Pinned actions, a scanned image and keyless signatures

- Status: accepted
- Date: 2026-11-05
- Milestone: M12

## Context

CI ran third-party GitHub Actions by moving tags (`@v7`), built images nobody scanned, and
published nothing: every host built its own image, and nothing let a user check that an image
came from this repository. In March 2026, attackers force-pushed 76 of the 77 tags of
`aquasecurity/trivy-action` to credential-stealing code and published a malicious Trivy release
(GHSA-69fq-xp46-6x23). Workflows that pinned the action to a safe commit SHA, or the image by
digest, were not affected. LiteLLM, the most widely used open-source gateway, had two
supply-chain compromises in 2026. Everything here must stay at $0.

## Decision

- **Pins.** Every `uses:` names the full commit SHA of a release, read from the action's own
  repository, with the version in a comment. Dependabot proposes updates weekly (npm and
  github-actions, minor and patch grouped).
- **Least privilege.** Workflows default to `contents: read`, and checkouts do not keep the token.
  Only the `publish-image` job may write packages and request an OIDC token. It runs only on
  pushes to `main`, after every other job has passed, and runs only GitHub's own
  `download-artifact`, `docker` and cosign.
- **Tools without third-party actions.** Trivy and cosign run from their release binaries, each
  checked against a SHA-256 pinned in the workflow, taken from the checksums file of an immutable
  release (Trivy 0.76.2, cosign v3.1.4). A changed download fails the job.
- **Scan and SBOM.** A `gateway-image` job builds the Dockerfile's `gateway` stage, writes a
  CycloneDX SBOM and the full Trivy result as build artifacts, and fails on CRITICAL
  vulnerabilities that have a fix. `.trivyignore` holds exceptions, each with a reason. It runs on
  pull requests too, so a Dependabot update is scanned before it is merged.
- **Publish and sign.** On `main`, the scanned image itself (handed over as a build artifact, not
  rebuilt) is pushed to `ghcr.io/naveenk2608/ai-gateway` as `<commit SHA>` and `main`, signed by
  digest with cosign keyless signing (GitHub's OIDC token, Sigstore's public Fulcio and Rekor; no
  stored key), and verified in the same job with the identity a user checks:
  `https://github.com/naveenk2608/ai-gateway/.github/workflows/ci.yml@refs/heads/main`.

## Alternatives considered

- `aquasecurity/trivy-action`, `sigstore/cosign-installer` and the Docker actions, pinned by SHA:
  fine once pinned, but each is more third-party code running with the job's token, and the
  publish job would hold write and OIDC permissions while they run.
- Scanning and publishing in one job: every step there, the scanner included, could request an
  OIDC token and sign as this workflow.
- A signing key stored as a secret: one more secret to guard and rotate; keyless signing ties the
  signature to this workflow instead.
- Docker Hub: rate limits and an account to manage; GHCR is free for a public repository.

## Consequences

- An image on GHCR was built from a commit on `main` whose checks all passed, has no fixable
  CRITICAL vulnerability that was not explicitly accepted, and verifies with `cosign verify`.
- Trivy's and cosign's versions are updated by hand (version and checksum together); Dependabot
  does not see them.
- A newly published fixable CRITICAL vulnerability in the base image or a dependency fails CI
  until the image is updated or the finding is accepted in `.trivyignore`.
- The image on GHCR is not used by the live demo (Render builds from the Dockerfile) or by the AWS
  setups (their boot scripts build at boot; PLAN-NOTES).
- Whether the package is public is a setting of the package on GitHub, outside this repository.
