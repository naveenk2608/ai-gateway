# The gateway's secrets, in one Secrets Manager secret the gateway instances read at boot. The
# database password is a separate secret that RDS manages (data.tf). These values are generated
# by Terraform, so they are also in its state: keep the state in an encrypted, access-controlled
# backend (docs/aws-deployment.md).

resource "random_id" "api_key_pepper" {
  byte_length = 32
}

resource "random_password" "bootstrap_admin" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name_prefix             = "${local.name}-app-"
  description             = "ai-gateway: API key pepper, first admin password, Redis token, provider keys"
  recovery_window_in_days = 7
  tags                    = merge(local.tags, { Name = "${local.name}-app" })
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    api_key_pepper           = random_id.api_key_pepper.hex
    bootstrap_admin_password = random_password.bootstrap_admin.result
    redis_auth_token         = random_password.redis_auth.result
    groq_api_key             = var.groq_api_key
    gemini_api_key           = var.gemini_api_key
  })
}
