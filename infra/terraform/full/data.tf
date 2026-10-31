# Postgres on RDS and Redis on ElastiCache, both in private subnets with no route out, encrypted
# at rest and in transit.

resource "aws_db_subnet_group" "main" {
  name_prefix = "${local.name}-"
  description = "ai-gateway Postgres (private subnets)"
  subnet_ids  = module.network.private_subnet_ids
  tags        = merge(local.tags, { Name = "${local.name}-db" })
}

resource "aws_db_instance" "main" {
  identifier_prefix = "${local.name}-"
  engine            = "postgres"
  engine_version    = var.db_engine_version
  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage_gb
  storage_type      = "gp3"
  storage_encrypted = true
  db_name           = "gateway"
  username          = "gateway"
  # RDS creates the password and keeps it in Secrets Manager: it never appears in Terraform's
  # plan or state. Instances read it at boot through their role. RDS Postgres requires TLS by
  # default (rds.force_ssl), and the instances verify the server certificate.
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = var.db_multi_az
  backup_retention_period     = var.db_backup_retention_days
  auto_minor_version_upgrade  = true
  apply_immediately           = true
  deletion_protection         = var.db_deletion_protection
  skip_final_snapshot         = !var.db_final_snapshot
  final_snapshot_identifier   = var.db_final_snapshot ? "${local.name}-final" : null
  copy_tags_to_snapshot       = true
  tags                        = merge(local.tags, { Name = local.name })
}

resource "aws_elasticache_subnet_group" "main" {
  name        = "${local.name}-cache"
  description = "ai-gateway Redis (private subnets)"
  subnet_ids  = module.network.private_subnet_ids
  tags        = merge(local.tags, { Name = "${local.name}-cache" })
}

# Clients connect with rediss:// and this token. Generated here, so it is in the Terraform state:
# keep the state in an encrypted, access-controlled backend (docs/aws-deployment.md).
resource "random_password" "redis_auth" {
  length  = 48
  special = false
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${local.name}-redis"
  description                = "ai-gateway limits, budgets, cache and health"
  engine                     = "redis"
  engine_version             = var.cache_engine_version
  node_type                  = var.cache_node_type
  num_cache_clusters         = 1
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  automatic_failover_enabled = false
  apply_immediately          = true
  snapshot_retention_limit   = 0
  tags                       = merge(local.tags, { Name = "${local.name}-redis" })
}
