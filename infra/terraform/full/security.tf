# Who may talk to whom. Clients reach only the load balancer; the load balancer reaches only the
# gateways; Postgres takes the gateways and the worker; Redis takes the gateways only (with SQS
# carrying the events, the worker does not use Redis).

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "ai-gateway load balancer"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-alb" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each          = toset(var.alb_allowed_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = local.https ? "HTTP, redirected to HTTPS" : "HTTP"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
  tags              = merge(local.tags, { Name = "${local.name}-alb-http" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each          = local.https ? toset(var.alb_allowed_cidrs) : toset([])
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
  tags              = merge(local.tags, { Name = "${local.name}-alb-https" })
}

resource "aws_vpc_security_group_egress_rule" "alb_to_gateways" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the gateways"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.gateway.id
  tags                         = merge(local.tags, { Name = "${local.name}-alb-to-gateways" })
}

resource "aws_security_group" "gateway" {
  name_prefix = "${local.name}-gateway-"
  description = "ai-gateway gateway instances"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-gateway" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_alb" {
  security_group_id            = aws_security_group.gateway.id
  description                  = "From the load balancer only"
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  referenced_security_group_id = aws_security_group.alb.id
  tags                         = merge(local.tags, { Name = "${local.name}-gateway-from-alb" })
}

resource "aws_security_group" "worker" {
  name_prefix = "${local.name}-worker-"
  description = "ai-gateway worker instance (no inbound traffic)"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-worker" })

  lifecycle {
    create_before_destroy = true
  }
}

# Gateways and the worker go out to the internet directly (no NAT): packages, the repository,
# container images, model providers, and the SQS, Secrets Manager and CloudWatch endpoints.
resource "aws_vpc_security_group_egress_rule" "instances" {
  for_each = {
    gateway = aws_security_group.gateway.id
    worker  = aws_security_group.worker.id
  }
  security_group_id = each.value
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  tags              = merge(local.tags, { Name = "${local.name}-${each.key}-egress" })
}

resource "aws_security_group" "db" {
  name_prefix = "${local.name}-db-"
  description = "ai-gateway Postgres"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-db" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "db" {
  for_each = {
    gateway = aws_security_group.gateway.id
    worker  = aws_security_group.worker.id
  }
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from the ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
  tags                         = merge(local.tags, { Name = "${local.name}-db-from-${each.key}" })
}

resource "aws_security_group" "cache" {
  name_prefix = "${local.name}-cache-"
  description = "ai-gateway Redis"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = "${local.name}-cache" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "cache" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Redis from the gateways"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.gateway.id
  tags                         = merge(local.tags, { Name = "${local.name}-cache-from-gateway" })
}
