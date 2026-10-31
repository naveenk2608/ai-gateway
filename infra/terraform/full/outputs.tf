output "url" {
  description = "The gateway behind the load balancer: /v1 for clients, /docs for the API reference."
  value       = "${local.https ? "https" : "http"}://${aws_lb.main.dns_name}"
}

output "dashboard_url" {
  description = "The dashboard and Playground (log in as admin_email)."
  value       = "${local.https ? "https" : "http"}://${aws_lb.main.dns_name}/dashboard/"
}

output "admin_password_secret_arn" {
  description = "Secrets Manager secret holding bootstrap_admin_password (and the other app secrets)."
  value       = aws_secretsmanager_secret.app.arn
}

output "usage_queue_url" {
  value = aws_sqs_queue.usage.url
}

output "usage_dlq_url" {
  value = aws_sqs_queue.usage_dlq.url
}

output "db_endpoint" {
  description = "Postgres, reachable from the gateways and the worker only."
  value       = aws_db_instance.main.endpoint
}

output "gateway_instance_ids" {
  value = aws_instance.gateway[*].id
}

output "worker_instance_id" {
  value = aws_instance.worker.id
}

output "log_groups" {
  value = { for role, group in aws_cloudwatch_log_group.app : role => group.name }
}
