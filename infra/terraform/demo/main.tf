# The cheap demo: one EC2 instance running the whole stack (gateway, worker, Postgres, Redis)
# with Docker Compose, in a VPC with one public subnet. No NAT gateway, no load balancer, no
# managed database: the instance and its disk are nearly the whole bill.

locals {
  name = "${var.project}-demo"
  tags = merge(var.extra_tags, {
    Project     = var.project
    Environment = "demo"
    ManagedBy   = "terraform"
    Repository  = "github.com/naveenk2608/ai-gateway"
  })
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_partition" "current" {}

# The latest Amazon Linux 2023 AMI, from AWS's public parameter.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

module "network" {
  source             = "../modules/network"
  name               = local.name
  cidr_block         = "10.30.0.0/16"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 1)
  tags               = local.tags
}

module "docker_host" {
  source = "../modules/docker-host"
}

# Port 80 from the allowed ranges only. No SSH: shell access goes through Session Manager.
resource "aws_security_group" "demo" {
  name_prefix = "${local.name}-"
  description = "ai-gateway demo instance"
  vpc_id      = module.network.vpc_id
  tags        = merge(local.tags, { Name = local.name })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each          = toset(var.allowed_cidrs)
  security_group_id = aws_security_group.demo.id
  description       = "Gateway and dashboard over HTTP"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = each.value
  tags              = merge(local.tags, { Name = "${local.name}-http" })
}

# Out to the internet: packages, the repository, container images, model providers.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.demo.id
  description       = "All outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  tags              = merge(local.tags, { Name = "${local.name}-egress" })
}

resource "aws_iam_role" "demo" {
  name_prefix = "${local.name}-"
  description = "ai-gateway demo instance: Session Manager access only"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(local.tags, { Name = local.name })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.demo.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "demo" {
  name_prefix = "${local.name}-"
  role        = aws_iam_role.demo.name
  tags        = merge(local.tags, { Name = local.name })
}

resource "aws_instance" "demo" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = module.network.public_subnet_ids[0]
  vpc_security_group_ids      = [aws_security_group.demo.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.demo.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    docker_setup   = module.docker_host.script
    repository_url = var.repository_url
    git_ref        = var.git_ref
    admin_email    = var.admin_email
  })

  # IMDSv2 only, one hop: the containers cannot reach the instance's credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = local.name })
  }

  tags = merge(local.tags, { Name = local.name })

  lifecycle {
    # A newer AMI is not a reason to rebuild the demo.
    ignore_changes = [ami]
  }
}
