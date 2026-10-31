output "url" {
  description = "The gateway: /v1 for clients, /docs for the API reference."
  value       = "http://${aws_instance.demo.public_dns}"
}

output "dashboard_url" {
  description = "The dashboard and Playground (log in as admin_email)."
  value       = "http://${aws_instance.demo.public_dns}/dashboard/"
}

output "instance_id" {
  value = aws_instance.demo.id
}

output "session_command" {
  description = "A shell on the instance through Session Manager (no SSH key or open port)."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.demo.id}"
}

output "admin_password_command" {
  description = "Run in that shell to read the generated dashboard password."
  value       = "sudo grep BOOTSTRAP_ADMIN_PASSWORD /opt/ai-gateway/.env"
}
