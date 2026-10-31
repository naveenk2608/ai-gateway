# The full layout: a load balancer in front of two gateway instances, one worker instance, RDS
# Postgres, ElastiCache Redis, an SQS queue with a dead-letter queue for usage events, Secrets
# Manager, CloudWatch logs and alarms, and an AWS Budgets alert. No NAT gateway: the instances sit
# in public subnets (security groups admit only the load balancer), and RDS and ElastiCache sit in
# private subnets with no route out.

locals {
  name = "${var.project}-full"
  tags = merge(var.extra_tags, {
    Project     = var.project
    Environment = "full"
    ManagedBy   = "terraform"
    Repository  = "github.com/naveenk2608/ai-gateway"
  })
  azs   = slice(data.aws_availability_zones.available.names, 0, 2)
  https = var.certificate_arn != null
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_partition" "current" {}

# The latest Amazon Linux 2023 AMI, from AWS's public parameter.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  cidr_block         = var.vpc_cidr
  availability_zones = local.azs
  private_subnets    = true
  tags               = local.tags
}

module "docker_host" {
  source = "../modules/docker-host"
}
