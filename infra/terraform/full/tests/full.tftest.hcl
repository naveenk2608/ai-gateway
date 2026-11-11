# The full setup, planned and applied against a mocked AWS provider: no credentials, and no
# request ever leaves the machine. Run `terraform test` in infra/terraform/full.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { insecure_value = "ami-0123456789abcdef0" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address  = "ai-gateway-full.abc123.us-east-1.rds.amazonaws.com"
      port     = 5432
      endpoint = "ai-gateway-full.abc123.us-east-1.rds.amazonaws.com:5432"
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds-db-credentials-abc"
        secret_status = "active"
        kms_key_id    = ""
      }]
    }
  }
  mock_resource "aws_elasticache_replication_group" {
    defaults = { primary_endpoint_address = "master.ai-gateway-full-redis.abc123.use1.cache.amazonaws.com" }
  }
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/ai-gat/0123456789abcdef"
      dns_name   = "ai-gat-123456789.us-east-1.elb.amazonaws.com"
      arn_suffix = "app/ai-gat/0123456789abcdef"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/ai-gat/0123456789abcdef"
      arn_suffix = "targetgroup/ai-gat/0123456789abcdef"
    }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:ai-gateway-full-alarms" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ai-gateway/full/app" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/ai-gateway-full-instance" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::123456789012:instance-profile/ai-gateway-full-instance" }
  }
}

override_resource {
  target = aws_sqs_queue.usage
  values = {
    arn  = "arn:aws:sqs:us-east-1:123456789012:ai-gateway-full-usage"
    url  = "https://sqs.us-east-1.amazonaws.com/123456789012/ai-gateway-full-usage"
    name = "ai-gateway-full-usage"
  }
}

override_resource {
  target = aws_sqs_queue.usage_dlq
  values = {
    arn  = "arn:aws:sqs:us-east-1:123456789012:ai-gateway-full-usage-dlq"
    url  = "https://sqs.us-east-1.amazonaws.com/123456789012/ai-gateway-full-usage-dlq"
    name = "ai-gateway-full-usage-dlq"
  }
}

override_resource {
  target = aws_secretsmanager_secret.app
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-app-xyz" }
}

override_resource {
  target = aws_secretsmanager_secret.alerts
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-alerts-xyz" }
}

variables {
  admin_email  = "owner@example.com"
  budget_email = "billing@example.com"
}

run "two_gateways_behind_the_load_balancer_and_one_worker" {
  command = apply

  assert {
    condition     = length(aws_instance.gateway) == 2 && aws_instance.gateway[0].subnet_id != aws_instance.gateway[1].subnet_id
    error_message = "Two gateway instances, in two availability zones."
  }
  assert {
    condition     = toset(aws_lb_target_group_attachment.gateway[*].target_id) == toset(aws_instance.gateway[*].id)
    error_message = "Every gateway is registered with the load balancer."
  }
  assert {
    condition     = aws_instance.worker.instance_type == "t3.small" && aws_instance.gateway[0].instance_type == "t3.small"
    error_message = "Gateways and the worker run on t3.small by default."
  }
  assert {
    condition     = output.url == "http://ai-gat-123456789.us-east-1.elb.amazonaws.com" && output.dashboard_url == "http://ai-gat-123456789.us-east-1.elb.amazonaws.com/dashboard/"
    error_message = "url and dashboard_url point at the load balancer."
  }
  assert {
    condition     = output.usage_queue_url == "https://sqs.us-east-1.amazonaws.com/123456789012/ai-gateway-full-usage"
    error_message = "The usage queue URL is an output."
  }
}

run "load_balancer_keeps_streams_open_and_checks_readiness" {
  command = plan

  assert {
    condition     = aws_lb.main.idle_timeout == 300
    error_message = "The idle timeout is raised from 60 s for long SSE streams."
  }
  assert {
    condition     = aws_lb.main.internal == false && aws_lb.main.drop_invalid_header_fields
    error_message = "A public load balancer that drops invalid headers."
  }
  assert {
    condition = (
      aws_lb_target_group.gateway.port == 8080 &&
      aws_lb_target_group.gateway.health_check[0].path == "/ready" &&
      aws_lb_target_group.gateway.deregistration_delay == "30"
    )
    error_message = "Gateways on 8080, healthy only when /ready passes, drained for 30 s."
  }
  assert {
    condition     = aws_lb_listener.http.default_action[0].type == "forward" && length(aws_lb_listener.https) == 0
    error_message = "Without a certificate, port 80 forwards to the gateways and there is no HTTPS listener."
  }
}

run "https_with_a_certificate" {
  command = plan

  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/0f0e0d0c-0b0a-0908-0706-050403020100"
  }

  assert {
    condition     = aws_lb_listener.http.default_action[0].type == "redirect" && aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS"
    error_message = "With a certificate, port 80 redirects to HTTPS."
  }
  assert {
    condition     = length(aws_lb_listener.https) == 1 && aws_lb_listener.https[0].certificate_arn == var.certificate_arn
    error_message = "An HTTPS listener uses the certificate."
  }
  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.alb_https) == 1
    error_message = "Port 443 opens only with a certificate."
  }
  assert {
    condition     = strcontains(aws_instance.gateway[0].user_data, "SESSION_COOKIE_SECURE=true")
    error_message = "Behind HTTPS, the session cookie is HTTPS-only."
  }
}

run "only_the_load_balancer_reaches_the_gateways" {
  command = plan

  assert {
    condition     = aws_vpc_security_group_ingress_rule.gateway_from_alb.referenced_security_group_id == aws_security_group.alb.id && aws_vpc_security_group_ingress_rule.gateway_from_alb.from_port == 8080
    error_message = "Gateways accept port 8080 from the load balancer's security group only."
  }
  assert {
    condition     = toset([for r in aws_vpc_security_group_ingress_rule.db : r.from_port]) == toset([5432]) && toset(keys(aws_vpc_security_group_ingress_rule.db)) == toset(["gateway", "worker"])
    error_message = "Postgres accepts the gateways and the worker on 5432, nothing else."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.cache.referenced_security_group_id == aws_security_group.gateway.id
    error_message = "Redis accepts the gateways only."
  }
  assert {
    condition     = alltrue([for i in concat(aws_instance.gateway, [aws_instance.worker]) : i.metadata_options[0].http_tokens == "required" && i.root_block_device[0].encrypted])
    error_message = "Instances use IMDSv2 only and encrypted volumes."
  }
}

run "private_encrypted_data_stores" {
  command = apply

  assert {
    condition     = toset(aws_db_subnet_group.main.subnet_ids) == toset(module.network.private_subnet_ids) && toset(aws_elasticache_subnet_group.main.subnet_ids) == toset(module.network.private_subnet_ids)
    error_message = "RDS and ElastiCache live in the private subnets."
  }
  assert {
    condition = (
      aws_db_instance.main.publicly_accessible == false &&
      aws_db_instance.main.storage_encrypted &&
      aws_db_instance.main.manage_master_user_password &&
      aws_db_instance.main.engine == "postgres"
    )
    error_message = "Postgres is private and encrypted, and RDS manages its password."
  }
  assert {
    condition     = aws_db_instance.main.skip_final_snapshot && !aws_db_instance.main.deletion_protection
    error_message = "By default nothing stops `terraform destroy` or keeps a billed snapshot."
  }
  assert {
    condition = (
      aws_elasticache_replication_group.main.transit_encryption_enabled &&
      aws_elasticache_replication_group.main.at_rest_encryption_enabled &&
      length(aws_elasticache_replication_group.main.auth_token) == 48
    )
    error_message = "Redis requires TLS and a token, and is encrypted at rest."
  }
}

run "usage_queue_with_a_dead_letter_queue" {
  command = apply

  assert {
    condition     = jsondecode(aws_sqs_queue.usage.redrive_policy).deadLetterTargetArn == aws_sqs_queue.usage_dlq.arn
    error_message = "The usage queue redrives into the dead-letter queue."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.usage.redrive_policy).maxReceiveCount == 10
    error_message = "The redrive is a backstop above the worker's own limit (5 deliveries + 5)."
  }
  assert {
    condition     = aws_sqs_queue.usage.sqs_managed_sse_enabled && aws_sqs_queue.usage_dlq.sqs_managed_sse_enabled
    error_message = "Both queues are encrypted."
  }
  assert {
    condition     = aws_sqs_queue.usage.visibility_timeout_seconds == 60 && strcontains(aws_instance.worker.user_data, "WORKER_CLAIM_IDLE_MS=60000")
    error_message = "The queue's visibility timeout matches the worker's WORKER_CLAIM_IDLE_MS."
  }
  assert {
    condition     = aws_sqs_queue.usage_dlq.message_retention_seconds == 1209600
    error_message = "Dead letters are kept 14 days."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue_redrive_allow_policy.usage_dlq.redrive_allow_policy).sourceQueueArns == [aws_sqs_queue.usage.arn]
    error_message = "Only the usage queue may redrive into the dead-letter queue."
  }
}

run "each_role_gets_only_what_it_uses" {
  command = apply

  assert {
    condition = {
      for s in jsondecode(aws_iam_role_policy.gateway.policy).Statement : s.Sid => s
      }["SendUsageEvents"] == {
      Sid      = "SendUsageEvents"
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = ["arn:aws:sqs:us-east-1:123456789012:ai-gateway-full-usage"]
    }
    error_message = "Gateways may send to the usage queue only."
  }
  assert {
    condition = !contains(flatten([
      for s in jsondecode(aws_iam_role_policy.gateway.policy).Statement : s.Action
    ]), "sqs:ReceiveMessage")
    error_message = "Gateways cannot consume usage events."
  }
  assert {
    condition = toset({
      for s in jsondecode(aws_iam_role_policy.gateway.policy).Statement : s.Sid => s
      }["ReadSecrets"].Resource) == toset([
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-app-xyz",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-alerts-xyz",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds-db-credentials-abc",
    ])
    error_message = "Gateways read the app secret, the alert key and the database secret."
  }
  assert {
    condition = toset({
      for s in jsondecode(aws_iam_role_policy.worker.policy).Statement : s.Sid => s.Resource
      }["ReadSecrets"]) == toset([
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-alerts-xyz",
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds-db-credentials-abc",
    ])
    error_message = "The worker reads the alert key and the database secret only, not the app secret."
  }
  assert {
    condition = {
      for s in jsondecode(aws_iam_role_policy.worker.policy).Statement : s.Sid => s.Resource
    }["ConsumeUsageEvents"] == ["arn:aws:sqs:us-east-1:123456789012:ai-gateway-full-usage"]
    error_message = "The worker consumes the usage queue only."
  }
  assert {
    condition = {
      for s in jsondecode(aws_iam_role_policy.worker.policy).Statement : s.Sid => s.Resource
    }["DeadLetterUsageEvents"] == ["arn:aws:sqs:us-east-1:123456789012:ai-gateway-full-usage-dlq"]
    error_message = "The worker sends dead letters to the dead-letter queue only."
  }
}

run "secrets_never_in_user_data" {
  command = apply

  assert {
    condition = alltrue([
      for k in ["api_key_pepper", "bootstrap_admin_password", "redis_auth_token", "groq_api_key", "gemini_api_key"] :
      contains(keys(jsondecode(aws_secretsmanager_secret_version.app.secret_string)), k)
    ])
    error_message = "The app secret holds the pepper, admin password, Redis token and provider keys."
  }
  assert {
    condition = alltrue([
      for i in concat(aws_instance.gateway, [aws_instance.worker]) :
      !strcontains(i.user_data, random_password.redis_auth.result) &&
      !strcontains(i.user_data, random_password.bootstrap_admin.result) &&
      !strcontains(i.user_data, random_id.api_key_pepper.hex) &&
      !strcontains(i.user_data, random_bytes.alerts_encryption_key.base64)
    ])
    error_message = "Instances fetch secrets at boot; user data (readable from the instance) holds none."
  }
  assert {
    condition     = aws_secretsmanager_secret.app.recovery_window_in_days == 7 && aws_secretsmanager_secret.alerts.recovery_window_in_days == 7
    error_message = "A deleted secret can be recovered for 7 days."
  }
  assert {
    condition     = aws_secretsmanager_secret_version.alerts.secret_string == random_bytes.alerts_encryption_key.base64 && length(random_bytes.alerts_encryption_key.base64) == 44
    error_message = "The alert key is 32 bytes, base64, as ALERTS_ENCRYPTION_KEY requires."
  }
  assert {
    condition = alltrue([
      for i in concat(aws_instance.gateway, [aws_instance.worker]) :
      strcontains(i.user_data, "ALERTS_ENCRYPTION_KEY=$(secret \"arn:aws:secretsmanager:us-east-1:123456789012:secret:ai-gateway-full-alerts-xyz\")")
    ])
    error_message = "Gateways and the worker read the same alert key at boot, so the worker can open the destination URLs the gateways encrypt (ADR 033)."
  }
}

run "gateway_and_worker_boot_scripts" {
  command = apply

  assert {
    condition = alltrue([
      for s in [
        "docker build --target gateway",
        "EVENT_BUS=sqs",
        "SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/ai-gateway-full-usage",
        "SQS_DLQ_URL=https://sqs.us-east-1.amazonaws.com/123456789012/ai-gateway-full-usage-dlq",
        "AWS_REGION=us-east-1",
        "sslmode=verify-full&sslrootcert=/certs/rds-ca.pem",
        "REDIS_URL=rediss://",
        "@master.ai-gateway-full-redis.abc123.use1.cache.amazonaws.com:6379",
        "TRUST_PROXY=1",
        "SESSION_COOKIE_SECURE=false",
        "--publish 8080:8080",
        "--log-opt awslogs-group=/ai-gateway/full/gateway",
      ] : strcontains(aws_instance.gateway[0].user_data, s)
    ])
    error_message = "Gateways run the gateway image with SQS, verified TLS to RDS, TLS to Redis, the proxy hop and CloudWatch logs."
  }
  assert {
    condition = (
      strcontains(aws_instance.worker.user_data, "docker build --target worker") &&
      strcontains(aws_instance.worker.user_data, "WORKER_BLOCK_MS=20000") &&
      strcontains(aws_instance.worker.user_data, "--log-opt awslogs-group=/ai-gateway/full/worker") &&
      !strcontains(aws_instance.worker.user_data, "REDIS_URL") &&
      !strcontains(aws_instance.worker.user_data, "--publish 8080:8080")
    )
    error_message = "The worker long-polls SQS, logs to its own group, needs no Redis and listens on no port."
  }
}

run "logs_alarms_and_budget" {
  command = apply

  variables {
    alarm_email        = "oncall@example.com"
    monthly_budget_usd = 40
  }

  assert {
    condition     = alltrue([for g in aws_cloudwatch_log_group.app : g.retention_in_days == 14])
    error_message = "Logs are kept 14 days by default."
  }
  assert {
    condition = toset(keys(aws_cloudwatch_metric_alarm.service)) == toset([
      "alb_target_5xx", "alb_elb_5xx", "unhealthy_gateways", "dead_letters", "usage_backlog",
      "db_cpu", "db_storage", "redis_memory",
    ])
    error_message = "Alarms cover 5xx responses, unhealthy gateways, dead letters, worker backlog, Postgres and Redis."
  }
  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.instance_status)) == toset(["gateway-0", "gateway-1", "worker"])
    error_message = "Every instance has a status-check alarm."
  }
  assert {
    condition = alltrue([
      for a in concat(values(aws_cloudwatch_metric_alarm.service), values(aws_cloudwatch_metric_alarm.instance_status)) :
      a.alarm_actions == toset([aws_sns_topic.alarms.arn])
    ])
    error_message = "Every alarm notifies the SNS topic."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.service["dead_letters"].dimensions.QueueName == "ai-gateway-full-usage-dlq"
    error_message = "The dead-letter alarm watches the dead-letter queue."
  }
  assert {
    condition     = length(aws_sns_topic_subscription.alarm_email) == 1 && aws_sns_topic_subscription.alarm_email[0].endpoint == "oncall@example.com"
    error_message = "Alarms are emailed to alarm_email."
  }
  assert {
    condition     = aws_budgets_budget.monthly.limit_amount == "40.00" && aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "The monthly budget uses monthly_budget_usd."
  }
  assert {
    condition = toset([for n in aws_budgets_budget.monthly.notification : "${n.notification_type}:${n.threshold}"]) == toset(["ACTUAL:80", "FORECASTED:100"]) && alltrue([
      for n in aws_budgets_budget.monthly.notification : n.subscriber_email_addresses == toset(["billing@example.com"])
    ])
    error_message = "budget_email hears at 80 % of actual spend and 100 % of forecast spend."
  }
}

run "every_resource_is_tagged" {
  command = plan

  variables {
    extra_tags  = { Owner = "platform" }
    alarm_email = "oncall@example.com"
  }

  assert {
    condition = alltrue([
      for tags in concat(
        [
          aws_lb.main.tags, aws_lb_target_group.gateway.tags, aws_lb_listener.http.tags,
          aws_security_group.alb.tags, aws_security_group.gateway.tags, aws_security_group.worker.tags,
          aws_security_group.db.tags, aws_security_group.cache.tags,
          aws_vpc_security_group_ingress_rule.gateway_from_alb.tags,
          aws_vpc_security_group_ingress_rule.cache.tags,
          aws_vpc_security_group_egress_rule.alb_to_gateways.tags,
          aws_db_subnet_group.main.tags, aws_db_instance.main.tags,
          aws_elasticache_subnet_group.main.tags, aws_elasticache_replication_group.main.tags,
          aws_sqs_queue.usage.tags, aws_sqs_queue.usage_dlq.tags,
          aws_secretsmanager_secret.app.tags, aws_sns_topic.alarms.tags, aws_budgets_budget.monthly.tags,
          aws_instance.worker.tags, aws_instance.worker.root_block_device[0].tags,
        ],
        [for r in aws_instance.gateway : r.tags],
        [for r in aws_instance.gateway : r.root_block_device[0].tags],
        [for r in aws_iam_role.instance : r.tags],
        [for r in aws_iam_instance_profile.instance : r.tags],
        [for r in aws_cloudwatch_log_group.app : r.tags],
        [for r in aws_cloudwatch_metric_alarm.service : r.tags],
        [for r in aws_cloudwatch_metric_alarm.instance_status : r.tags],
        [for r in aws_vpc_security_group_ingress_rule.alb_http : r.tags],
        [for r in aws_vpc_security_group_ingress_rule.db : r.tags],
        [for r in aws_vpc_security_group_egress_rule.instances : r.tags],
      ) :
      tags["Project"] == "ai-gateway" && tags["Environment"] == "full" && tags["ManagedBy"] == "terraform" && tags["Owner"] == "platform"
    ])
    error_message = "Every taggable resource carries Project, Environment, ManagedBy and the extra tags."
  }
}

run "rejects_a_bad_region" {
  command = plan
  variables {
    region = "virginia"
  }
  expect_failures = [var.region]
}

run "rejects_graviton_gateways" {
  command = plan
  variables {
    gateway_instance_type = "m7g.large"
  }
  expect_failures = [var.gateway_instance_type]
}

run "rejects_no_gateways" {
  command = plan
  variables {
    gateway_count = 0
  }
  expect_failures = [var.gateway_count]
}

run "rejects_a_short_idle_timeout" {
  command = plan
  variables {
    alb_idle_timeout_seconds = 60
  }
  expect_failures = [var.alb_idle_timeout_seconds]
}

run "rejects_a_zero_budget" {
  command = plan
  variables {
    monthly_budget_usd = 0
  }
  expect_failures = [var.monthly_budget_usd]
}

run "rejects_an_unsupported_log_retention" {
  command = plan
  variables {
    log_retention_days = 10
  }
  expect_failures = [var.log_retention_days]
}

run "rejects_a_certificate_that_is_not_acm" {
  command = plan
  variables {
    certificate_arn = "arn:aws:iam::123456789012:server-certificate/x"
  }
  expect_failures = [var.certificate_arn]
}
