# The gateway and worker instances. Each builds its image from the repository at git_ref on first
# boot and runs it with Docker (templates/app-host.sh.tftpl). They sit in public subnets so they
# reach the internet without a NAT gateway; their security groups admit only the load balancer.

locals {
  host_settings = {
    docker_setup      = module.docker_host.script
    repository_url    = var.repository_url
    git_ref           = var.git_ref
    region            = var.region
    db_secret_arn     = local.db_secret_arn
    db_address        = aws_db_instance.main.address
    db_port           = aws_db_instance.main.port
    queue_url         = aws_sqs_queue.usage.url
    dlq_url           = aws_sqs_queue.usage_dlq.url
    max_deliveries    = var.worker_max_deliveries
    visibility_ms     = local.visibility_timeout_seconds * 1000
    app_secret_arn    = aws_secretsmanager_secret.app.arn
    alerts_secret_arn = aws_secretsmanager_secret.alerts.arn
    redis_address     = aws_elasticache_replication_group.main.primary_endpoint_address
    admin_email       = var.admin_email
    secure_cookie     = local.https ? "true" : "false"
  }
  user_data = {
    for role in local.roles :
    role => templatefile("${path.module}/templates/app-host.sh.tftpl", merge(local.host_settings, {
      role      = role
      log_group = aws_cloudwatch_log_group.app[role].name
    }))
  }
}

resource "aws_instance" "gateway" {
  count                       = var.gateway_count
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.gateway_instance_type
  subnet_id                   = module.network.public_subnet_ids[count.index % length(module.network.public_subnet_ids)]
  vpc_security_group_ids      = [aws_security_group.gateway.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.instance["gateway"].name
  user_data                   = local.user_data["gateway"]
  user_data_replace_on_change = true

  # IMDSv2 only. Two hops, so the container (one network hop away) can use the instance role
  # for SQS; the role allows only what the gateway needs.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${local.name}-gateway-${count.index}" })
  }

  tags = merge(local.tags, { Name = "${local.name}-gateway-${count.index}", Role = "gateway" })

  # The secrets exist before the instance reads them at boot.
  depends_on = [aws_secretsmanager_secret_version.app, aws_secretsmanager_secret_version.alerts, aws_iam_role_policy.gateway]

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_instance" "worker" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.worker_instance_type
  subnet_id                   = module.network.public_subnet_ids[0]
  vpc_security_group_ids      = [aws_security_group.worker.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.instance["worker"].name
  user_data                   = local.user_data["worker"]
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${local.name}-worker" })
  }

  tags = merge(local.tags, { Name = "${local.name}-worker", Role = "worker" })

  depends_on = [aws_secretsmanager_secret_version.alerts, aws_iam_role_policy.worker]

  lifecycle {
    ignore_changes = [ami]
  }
}
