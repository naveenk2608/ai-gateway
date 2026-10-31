# The demo setup, planned and applied against a mocked AWS provider: no credentials, and no
# request ever leaves the machine. Run `terraform test` in infra/terraform/demo.

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
  mock_resource "aws_instance" {
    defaults = {
      id         = "i-0123456789abcdef0"
      public_dns = "ec2-203-0-113-10.compute-1.amazonaws.com"
    }
  }
}

variables {
  admin_email   = "owner@example.com"
  allowed_cidrs = ["203.0.113.0/24"]
}

run "one_small_instance_runs_everything" {
  command = apply

  assert {
    condition     = aws_instance.demo.instance_type == "t3.small"
    error_message = "The demo runs on one t3.small by default."
  }
  assert {
    condition     = aws_instance.demo.ami == "ami-0123456789abcdef0"
    error_message = "The instance uses the Amazon Linux 2023 AMI from the public SSM parameter."
  }
  assert {
    condition     = aws_instance.demo.associate_public_ip_address && aws_instance.demo.subnet_id == module.network.public_subnet_ids[0]
    error_message = "With no NAT gateway or load balancer, the instance needs a public subnet and address."
  }
  assert {
    condition     = length(module.network.public_subnet_ids) == 1 && length(module.network.private_subnet_ids) == 0
    error_message = "The demo VPC has one public subnet and no private ones."
  }
  assert {
    condition     = output.url == "http://ec2-203-0-113-10.compute-1.amazonaws.com"
    error_message = "url is the instance's public DNS name over HTTP."
  }
  assert {
    condition     = output.dashboard_url == "http://ec2-203-0-113-10.compute-1.amazonaws.com/dashboard/"
    error_message = "dashboard_url points at /dashboard/."
  }
  assert {
    condition     = output.session_command == "aws ssm start-session --region us-east-1 --target i-0123456789abcdef0"
    error_message = "session_command opens a Session Manager shell on the instance."
  }
}

run "only_port_80_from_the_allowed_ranges" {
  command = plan

  variables {
    allowed_cidrs = ["203.0.113.0/24", "198.51.100.7/32"]
  }

  assert {
    condition     = toset(keys(aws_vpc_security_group_ingress_rule.http)) == toset(["203.0.113.0/24", "198.51.100.7/32"])
    error_message = "One ingress rule per allowed range, and nothing else."
  }
  assert {
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.http :
      r.from_port == 80 && r.to_port == 80 && r.ip_protocol == "tcp"
    ])
    error_message = "Only TCP port 80 is open: no SSH, no database ports."
  }
}

run "hardened_instance" {
  command = plan

  assert {
    condition = (
      aws_instance.demo.metadata_options[0].http_tokens == "required" &&
      aws_instance.demo.metadata_options[0].http_put_response_hop_limit == 1
    )
    error_message = "IMDSv2 only, one hop, so containers cannot read the instance role's credentials."
  }
  assert {
    condition     = aws_instance.demo.root_block_device[0].encrypted && aws_instance.demo.root_block_device[0].volume_type == "gp3"
    error_message = "The root volume is encrypted gp3."
  }
  assert {
    condition     = aws_iam_role_policy_attachment.ssm.policy_arn == "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    error_message = "The instance role allows Session Manager and nothing else."
  }
}

run "first_boot_script" {
  command = plan

  variables {
    git_ref = "v1.2.3"
  }

  assert {
    condition     = strcontains(aws_instance.demo.user_data, "--branch \"v1.2.3\" \"https://github.com/naveenk2608/ai-gateway.git\"")
    error_message = "The instance builds the repository at git_ref."
  }
  assert {
    condition = (
      strcontains(aws_instance.demo.user_data, "docker-compose-linux-x86_64") &&
      strcontains(aws_instance.demo.user_data, "sha256sum -c -")
    )
    error_message = "Docker Compose is downloaded at a pinned version and checked against its SHA-256."
  }
  assert {
    condition     = strcontains(aws_instance.demo.user_data, "-f infra/compose/aws-demo.yml") && strcontains(aws_instance.demo.user_data, "--profile full up -d --build")
    error_message = "The stack starts with the demo's Compose override."
  }
  assert {
    condition     = strcontains(aws_instance.demo.user_data, "BOOTSTRAP_ADMIN_EMAIL=owner@example.com") && strcontains(aws_instance.demo.user_data, "API_KEY_PEPPER=$(openssl rand -hex 32)")
    error_message = "Secrets are generated on the instance, not passed in by Terraform."
  }
}

run "every_resource_is_tagged" {
  command = plan

  variables {
    extra_tags = { Owner = "platform" }
  }

  assert {
    condition = alltrue([
      for tags in [
        aws_instance.demo.tags,
        aws_instance.demo.root_block_device[0].tags,
        aws_security_group.demo.tags,
        aws_vpc_security_group_egress_rule.all.tags,
        aws_iam_role.demo.tags,
        aws_iam_instance_profile.demo.tags,
      ] :
      tags["Project"] == "ai-gateway" && tags["Environment"] == "demo" && tags["ManagedBy"] == "terraform" && tags["Owner"] == "platform"
    ])
    error_message = "Every resource carries Project, Environment, ManagedBy and the extra tags."
  }
  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.http : r.tags["Project"] == "ai-gateway"])
    error_message = "Ingress rules are tagged."
  }
}

run "rejects_graviton_instance_types" {
  command = plan

  variables {
    instance_type = "t4g.small"
  }

  expect_failures = [var.instance_type]
}

run "rejects_an_invalid_range" {
  command = plan

  variables {
    allowed_cidrs = ["everyone"]
  }

  expect_failures = [var.allowed_cidrs]
}

run "rejects_no_ranges" {
  command = plan

  variables {
    allowed_cidrs = []
  }

  expect_failures = [var.allowed_cidrs]
}

run "rejects_a_bad_region" {
  command = plan

  variables {
    region = "virginia"
  }

  expect_failures = [var.region]
}
