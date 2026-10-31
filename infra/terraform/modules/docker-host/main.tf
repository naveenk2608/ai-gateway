# The shell that prepares an Amazon Linux 2023 (x86_64) instance to build and run the images:
# Docker, the Compose and Buildx plugins (pinned versions, checked against their published
# SHA-256 sums) and a swap file, because building the images needs more memory than a small
# instance has. Both setups put it at the top of their user data.

terraform {
  required_version = ">= 1.10.0"
}

variable "swap_gb" {
  description = "Size of the swap file used while building the images."
  type        = number
  default     = 2

  validation {
    condition     = var.swap_gb >= 1 && var.swap_gb <= 8
    error_message = "swap_gb must be between 1 and 8."
  }
}

locals {
  # https://github.com/docker/compose/releases/tag/v5.6.0 (checksums.txt)
  compose_version = "v5.6.0"
  compose_sha256  = "40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a"
  # https://github.com/docker/buildx/releases/tag/v0.38.0 (checksums.txt)
  buildx_version = "v0.38.0"
  buildx_sha256  = "4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287"
}

output "script" {
  description = "Shell commands, for a template that starts with set -euo pipefail."
  value = templatefile("${path.module}/install-docker.sh.tftpl", {
    compose_version = local.compose_version
    compose_sha256  = local.compose_sha256
    buildx_version  = local.buildx_version
    buildx_sha256   = local.buildx_sha256
    swap_gb         = var.swap_gb
  })
}
