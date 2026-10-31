# Logs from the containers (awslogs driver), alarms on the signals that need a person, and an
# account-wide AWS Budgets alert. Alarm notifications go to an SNS topic, emailed to alarm_email
# when given. (The topic is not KMS-encrypted: CloudWatch cannot publish to a topic encrypted
# with the AWS-managed SNS key, and alarm messages hold no secrets.)

resource "aws_cloudwatch_log_group" "app" {
  for_each          = local.roles
  name              = "/${var.project}/full/${each.key}"
  retention_in_days = var.log_retention_days
  tags              = merge(local.tags, { Name = "${local.name}-${each.key}" })
}

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
  tags = merge(local.tags, { Name = "${local.name}-alarms" })
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarms = {
    alb_target_5xx = {
      description = "Gateways answered with more than 10 5xx responses in 5 minutes."
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_Target_5XX_Count"
      statistic   = "Sum"
      period      = 300
      periods     = 1
      operator    = "GreaterThanThreshold"
      threshold   = 10
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
    alb_elb_5xx = {
      description = "The load balancer itself returned more than 10 5xx responses in 5 minutes (no healthy gateway, or timeouts)."
      namespace   = "AWS/ApplicationELB"
      metric      = "HTTPCode_ELB_5XX_Count"
      statistic   = "Sum"
      period      = 300
      periods     = 1
      operator    = "GreaterThanThreshold"
      threshold   = 10
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix }
    }
    unhealthy_gateways = {
      description = "At least one gateway failed its /ready health check for 3 minutes."
      namespace   = "AWS/ApplicationELB"
      metric      = "UnHealthyHostCount"
      statistic   = "Maximum"
      period      = 60
      periods     = 3
      operator    = "GreaterThanOrEqualToThreshold"
      threshold   = 1
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
        TargetGroup  = aws_lb_target_group.gateway.arn_suffix
      }
    }
    dead_letters = {
      description = "Usage events are in the dead-letter queue: the worker could not store them."
      namespace   = "AWS/SQS"
      metric      = "ApproximateNumberOfMessagesVisible"
      statistic   = "Maximum"
      period      = 300
      periods     = 1
      operator    = "GreaterThanThreshold"
      threshold   = 0
      dimensions  = { QueueName = aws_sqs_queue.usage_dlq.name }
    }
    usage_backlog = {
      description = "The oldest usage event has waited over 10 minutes: the worker is down or behind."
      namespace   = "AWS/SQS"
      metric      = "ApproximateAgeOfOldestMessage"
      statistic   = "Maximum"
      period      = 300
      periods     = 1
      operator    = "GreaterThanThreshold"
      threshold   = 600
      dimensions  = { QueueName = aws_sqs_queue.usage.name }
    }
    db_cpu = {
      description = "Postgres CPU above 80 % for 15 minutes."
      namespace   = "AWS/RDS"
      metric      = "CPUUtilization"
      statistic   = "Average"
      period      = 300
      periods     = 3
      operator    = "GreaterThanThreshold"
      threshold   = 80
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
    }
    db_storage = {
      description = "Postgres has less than 2 GiB of storage left."
      namespace   = "AWS/RDS"
      metric      = "FreeStorageSpace"
      statistic   = "Minimum"
      period      = 300
      periods     = 1
      operator    = "LessThanThreshold"
      threshold   = 2147483648
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
    }
    redis_memory = {
      description = "Redis memory above 80 %: limits, budgets and the cache share it."
      namespace   = "AWS/ElastiCache"
      metric      = "DatabaseMemoryUsagePercentage"
      statistic   = "Average"
      period      = 300
      periods     = 2
      operator    = "GreaterThanThreshold"
      threshold   = 80
      # The single node of a replication group without cluster mode is named <id>-001.
      dimensions = { CacheClusterId = "${aws_elasticache_replication_group.main.replication_group_id}-001" }
    }
  }
  instance_ids = merge(
    { for i, instance in aws_instance.gateway : "gateway-${i}" => instance.id },
    { worker = aws_instance.worker.id },
  )
}

resource "aws_cloudwatch_metric_alarm" "service" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${replace(each.key, "_", "-")}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  period              = each.value.period
  evaluation_periods  = each.value.periods
  comparison_operator = each.value.operator
  threshold           = each.value.threshold
  dimensions          = each.value.dimensions
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = merge(local.tags, { Name = "${local.name}-${each.key}" })
}

resource "aws_cloudwatch_metric_alarm" "instance_status" {
  for_each            = local.instance_ids
  alarm_name          = "${local.name}-${each.key}-status-check"
  alarm_description   = "The ${each.key} instance failed its EC2 status checks for 3 minutes."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  dimensions          = { InstanceId = each.value }
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  tags                = merge(local.tags, { Name = "${local.name}-${each.key}-status-check" })
}

# Account-wide, so it also catches anything left running outside this stack: an email at 80 %
# of the monthly limit in actual spend, and when the forecast passes 100 %.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  tags         = merge(local.tags, { Name = "${local.name}-monthly" })

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
