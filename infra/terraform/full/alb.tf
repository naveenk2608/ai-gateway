# The public entry point. Gateways are registered by instance; health is GET /ready (Postgres and
# Redis reachable), so an instance that cannot serve stops receiving traffic.

resource "aws_lb" "main" {
  name_prefix                = substr(var.project, 0, 6)
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.network.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = var.alb_idle_timeout_seconds
  drop_invalid_header_fields = true
  enable_deletion_protection = false
  tags                       = merge(local.tags, { Name = local.name })
}

resource "aws_lb_target_group" "gateway" {
  name_prefix = substr(var.project, 0, 6)
  port        = 8080
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = module.network.vpc_id
  # Longer than the gateway's SHUTDOWN_TIMEOUT_MS (10 s), so a draining instance finishes its
  # requests before the load balancer forgets it.
  deregistration_delay = 30
  tags                 = merge(local.tags, { Name = "${local.name}-gateway" })

  health_check {
    path                = "/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_target_group_attachment" "gateway" {
  count            = var.gateway_count
  target_group_arn = aws_lb_target_group.gateway.arn
  target_id        = aws_instance.gateway[count.index].id
  port             = 8080
}

# Plain HTTP forwards to the gateways, or redirects to HTTPS when a certificate is given.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  tags              = merge(local.tags, { Name = "${local.name}-http" })

  default_action {
    type             = local.https ? "redirect" : "forward"
    target_group_arn = local.https ? null : aws_lb_target_group.gateway.arn

    dynamic "redirect" {
      for_each = local.https ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  tags              = merge(local.tags, { Name = "${local.name}-https" })

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}
