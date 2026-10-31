# One role per instance kind, each allowed only what it uses: Session Manager for shell access
# (no SSH), its own log group, its secrets and its side of the usage queue.

locals {
  roles         = toset(["gateway", "worker"])
  db_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
}

resource "aws_iam_role" "instance" {
  for_each    = local.roles
  name_prefix = "${local.name}-${each.key}-"
  description = "ai-gateway ${each.key} instances"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(local.tags, { Name = "${local.name}-${each.key}" })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  for_each   = local.roles
  role       = aws_iam_role.instance[each.key].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  for_each    = local.roles
  name_prefix = "${local.name}-${each.key}-"
  role        = aws_iam_role.instance[each.key].name
  tags        = merge(local.tags, { Name = "${local.name}-${each.key}" })
}

resource "aws_iam_role_policy" "gateway" {
  name = "gateway"
  role = aws_iam_role.instance["gateway"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "SendUsageEvents"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = [aws_sqs_queue.usage.arn]
      },
      {
        # Queue depths for the Infrastructure page and metrics.
        Sid      = "ReadQueueDepth"
        Effect   = "Allow"
        Action   = ["sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.usage.arn, aws_sqs_queue.usage_dlq.arn]
      },
      {
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [aws_secretsmanager_secret.app.arn, local.db_secret_arn]
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.app["gateway"].arn}:*"]
      },
    ]
  })
}

resource "aws_iam_role_policy" "worker" {
  name = "worker"
  role = aws_iam_role.instance["worker"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ConsumeUsageEvents"
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
        ]
        Resource = [aws_sqs_queue.usage.arn]
      },
      {
        Sid      = "DeadLetterUsageEvents"
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.usage_dlq.arn]
      },
      {
        # The worker needs the database password only.
        Sid      = "ReadSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.db_secret_arn]
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${aws_cloudwatch_log_group.app["worker"].arn}:*"]
      },
    ]
  })
}
