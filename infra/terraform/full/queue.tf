# Usage events (ADR 023): the gateways send to the usage queue, the worker receives, stores in
# Postgres and deletes. The worker moves an event it cannot store to the dead-letter queue itself
# after worker_max_deliveries; the redrive policy, set higher, is only a backstop for messages
# the worker cannot even handle.

locals {
  # The worker's WORKER_CLAIM_IDLE_MS, in seconds: how soon an unacknowledged event comes back.
  visibility_timeout_seconds = 60
  max_receive_count          = var.worker_max_deliveries + 5
}

resource "aws_sqs_queue" "usage_dlq" {
  name                      = "${local.name}-usage-dlq"
  message_retention_seconds = 1209600 # 14 days, the most SQS keeps
  sqs_managed_sse_enabled   = true
  tags                      = merge(local.tags, { Name = "${local.name}-usage-dlq" })
}

resource "aws_sqs_queue" "usage" {
  name                       = "${local.name}-usage"
  visibility_timeout_seconds = local.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days for the worker to catch up after an outage
  receive_wait_time_seconds  = 20     # long polling: fewer empty receives
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.usage_dlq.arn
    maxReceiveCount     = local.max_receive_count
  })
  tags = merge(local.tags, { Name = "${local.name}-usage" })
}

# Only the usage queue may redrive into the dead-letter queue.
resource "aws_sqs_queue_redrive_allow_policy" "usage_dlq" {
  queue_url = aws_sqs_queue.usage_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.usage.arn]
  })
}
