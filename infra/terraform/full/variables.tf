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
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.project))
    error_message = "project must be 2 to 21 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "vpc_cidr" {
  description = "The VPC's address range (a /16 is split into /24 subnets)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be an IPv4 range of /16 or larger."
  }
}

variable "gateway_count" {
  description = "Gateway instances behind the load balancer, spread over two availability zones."
  type        = number
  default     = 2

  validation {
    condition     = var.gateway_count >= 1 && var.gateway_count <= 6
    error_message = "gateway_count must be between 1 and 6."
  }
}

variable "gateway_instance_type" {
  description = "x86_64 instance type for the gateways."
  type        = string
  default     = "t3.small"

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.gateway_instance_type)) &&
      !can(regex("^[a-z]+[0-9]+[a-z]*g[a-z]*\\.", var.gateway_instance_type))
    )
    error_message = "gateway_instance_type must be an x86_64 type such as t3.small; Graviton types are not supported yet."
  }
}

variable "worker_instance_type" {
  description = "x86_64 instance type for the worker."
  type        = string
  default     = "t3.small"

  validation {
    condition = (
      can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.worker_instance_type)) &&
      !can(regex("^[a-z]+[0-9]+[a-z]*g[a-z]*\\.", var.worker_instance_type))
    )
    error_message = "worker_instance_type must be an x86_64 type such as t3.small; Graviton types are not supported yet."
  }
}

variable "root_volume_gb" {
  description = "Size of each instance's encrypted gp3 root volume."
  type        = number
  default     = 16

  validation {
    condition     = var.root_volume_gb >= 12 && var.root_volume_gb <= 100
    error_message = "root_volume_gb must be between 12 and 100."
  }
}

variable "db_instance_class" {
  description = "RDS instance class for Postgres."
  type        = string
  default     = "db.t4g.micro"

  validation {
    condition     = startswith(var.db_instance_class, "db.")
    error_message = "db_instance_class must be an RDS class such as db.t4g.micro."
  }
}

variable "db_engine_version" {
  description = "Postgres major version; RDS picks its current minor version."
  type        = string
  default     = "16"
}

variable "db_allocated_storage_gb" {
  description = "RDS storage (gp3)."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage_gb >= 20 && var.db_allocated_storage_gb <= 1000
    error_message = "db_allocated_storage_gb must be between 20 and 1000."
  }
}

variable "db_multi_az" {
  description = "A standby in a second zone. Doubles the database cost."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Automated backups kept by RDS (0 turns them off)."
  type        = number
  default     = 1

  validation {
    condition     = var.db_backup_retention_days >= 0 && var.db_backup_retention_days <= 35
    error_message = "db_backup_retention_days must be between 0 and 35."
  }
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database. Off by default so `terraform destroy` leaves nothing billing."
  type        = bool
  default     = false
}

variable "db_final_snapshot" {
  description = "Take a final snapshot on destroy. A kept snapshot keeps billing for storage."
  type        = bool
  default     = false
}

variable "cache_node_type" {
  description = "ElastiCache node type for Redis."
  type        = string
  default     = "cache.t4g.micro"

  validation {
    condition     = startswith(var.cache_node_type, "cache.")
    error_message = "cache_node_type must be an ElastiCache type such as cache.t4g.micro."
  }
}

variable "cache_engine_version" {
  description = "Redis OSS version on ElastiCache."
  type        = string
  default     = "7.1"
}

variable "alb_allowed_cidrs" {
  description = "IPv4 ranges allowed to reach the load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.alb_allowed_cidrs) > 0 && alltrue([for c in var.alb_allowed_cidrs : can(cidrnetmask(c))])
    error_message = "alb_allowed_cidrs must be a non-empty list of IPv4 CIDR blocks."
  }
}

variable "alb_idle_timeout_seconds" {
  description = "How long the load balancer keeps a quiet connection open. Raised from the default 60 s so long SSE streams with slow first tokens are not cut."
  type        = number
  default     = 300

  validation {
    condition     = var.alb_idle_timeout_seconds >= 120 && var.alb_idle_timeout_seconds <= 4000
    error_message = "alb_idle_timeout_seconds must be between 120 and 4000."
  }
}

variable "certificate_arn" {
  description = "An ACM certificate for HTTPS on the load balancer. Without one, it serves plain HTTP and the session cookie cannot be HTTPS-only."
  type        = string
  default     = null

  validation {
    condition     = var.certificate_arn == null || can(regex("^arn:aws[a-z-]*:acm:", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN."
  }
}

variable "admin_email" {
  description = "Email of the first dashboard owner; the password is generated into Secrets Manager."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.admin_email))
    error_message = "admin_email must be an email address."
  }
}

variable "alarm_email" {
  description = "Where CloudWatch alarms are emailed (the subscription must be confirmed). Null sends them nowhere but the console."
  type        = string
  default     = null

  validation {
    condition     = var.alarm_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address."
  }
}

variable "budget_email" {
  description = "Who the AWS Budgets alert emails."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "budget_email must be an email address."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget for the whole account: an email at 80 % of actual spend and at 100 % of forecast spend. The full setup alone costs about $115 a month (docs/aws-deployment.md)."
  type        = number
  default     = 150

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}

variable "log_retention_days" {
  description = "How long CloudWatch keeps the gateway and worker logs."
  type        = number
  default     = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "log_retention_days must be one of CloudWatch's values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180 or 365."
  }
}

variable "worker_max_deliveries" {
  description = "Deliveries before the worker moves an event to the dead-letter queue itself (WORKER_MAX_DELIVERIES)."
  type        = number
  default     = 5

  validation {
    condition     = var.worker_max_deliveries >= 1 && var.worker_max_deliveries <= 50
    error_message = "worker_max_deliveries must be between 1 and 50."
  }
}

variable "repository_url" {
  description = "Git repository the instances build from."
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

variable "groq_api_key" {
  description = "Optional Groq key for the hosted deployments in config/models.json. Stored in Secrets Manager (and in the Terraform state)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "gemini_api_key" {
  description = "Optional Gemini key, stored like groq_api_key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "extra_tags" {
  description = "Tags added to every resource, such as Owner or CostCenter."
  type        = map(string)
  default     = {}
}
