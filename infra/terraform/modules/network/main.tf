# A VPC with public subnets (internet gateway) and optional private subnets with no route out.
# No NAT gateway, on purpose: one costs about $33 a month per AZ before any traffic, more than
# the rest of the demo. Instances that need the internet sit in public subnets behind security
# groups; databases sit in private subnets and need no internet at all.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.69.1"
    }
  }
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
}

variable "cidr_block" {
  description = "The VPC's address range."
  type        = string
}

variable "availability_zones" {
  description = "One public (and, if wanted, one private) subnet per zone."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 1
    error_message = "Give at least one availability zone."
  }
}

variable "private_subnets" {
  description = "Also create a private subnet per zone (for RDS and ElastiCache)."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags for every resource."
  type        = map(string)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(var.tags, { Name = var.name })
}

# The VPC's default security group allows all traffic between its members; with no rules here,
# Terraform empties it, so nothing can use it by accident.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-default-unused" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = var.name })
}

resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.cidr_block, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = merge(var.tags, { Name = "${var.name}-public-${count.index}", Tier = "public" })
}

resource "aws_subnet" "private" {
  count             = var.private_subnets ? length(var.availability_zones) : 0
  vpc_id            = aws_vpc.this.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, 100 + count.index)
  tags              = merge(var.tags, { Name = "${var.name}-private-${count.index}", Tier = "private" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private subnets keep the VPC's local route only: nothing in them can reach the internet.
resource "aws_route_table" "private" {
  count  = var.private_subnets ? 1 : 0
  vpc_id = aws_vpc.this.id
  tags   = merge(var.tags, { Name = "${var.name}-private" })
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr_block" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
