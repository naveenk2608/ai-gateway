variable "region" {
  description = "AWS region, such as us-east-1."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region such as us-east-1."
  }
}

variable "project" {
  description = "Name prefix and Project tag."
  type        = string
  default     = "ai-gateway"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project))
    error_message = "project must be 2 to 31 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "instance_type" {
  description = "The one instance that runs everything. x86_64 only (the setup script installs x86_64 binaries)."
  type        = string
  default     = "t3.small"

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.instance_type)) &&
      !can(regex("^[a-z]+[0-9]+[a-z]*g[a-z]*\\.", var.instance_type))
    )
    error_message = "instance_type must be an x86_64 type such as t3.small; Graviton types (t4g, m7g, ...) are not supported yet."
  }
}

variable "root_volume_gb" {
  description = "Size of the encrypted gp3 root volume (Docker images and Postgres data live on it)."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_gb >= 16 && var.root_volume_gb <= 200
    error_message = "root_volume_gb must be between 16 and 200."
  }
}

variable "allowed_cidrs" {
  description = "IPv4 ranges allowed to reach the gateway on port 80, such as [\"203.0.113.4/32\"]. No default: choose who can reach a demo served over plain HTTP."
  type        = list(string)

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(cidrnetmask(c))])
    error_message = "allowed_cidrs must be a non-empty list of IPv4 CIDR blocks, such as 203.0.113.4/32."
  }
}

variable "admin_email" {
  description = "Email of the first dashboard owner. Its password is generated on the instance and never leaves it."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.admin_email))
    error_message = "admin_email must be an email address."
  }
}

variable "repository_url" {
  description = "Git repository the instance builds from."
  type        = string
  default     = "https://github.com/naveenk2608/ai-gateway.git"

  validation {
    condition     = startswith(var.repository_url, "https://")
    error_message = "repository_url must be an https:// URL."
  }
}

variable "git_ref" {
  description = "Tag or branch to build. The default is the tag that marks M10."
  type        = string
  default     = "m10-done"

  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.git_ref))
    error_message = "git_ref must be a tag or branch name."
  }
}

variable "extra_tags" {
  description = "Tags added to every resource, such as Owner or CostCenter."
  type        = map(string)
  default     = {}
}
