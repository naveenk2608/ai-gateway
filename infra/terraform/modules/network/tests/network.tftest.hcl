# The network module against a mocked AWS provider: no credentials, no requests to AWS.

mock_provider "aws" {}

variables {
  name               = "test"
  cidr_block         = "10.40.0.0/16"
  availability_zones = ["us-east-1a", "us-east-1b"]
  private_subnets    = true
  tags               = { Project = "ai-gateway", Environment = "test", ManagedBy = "terraform" }
}

run "public_subnets_route_out_private_subnets_do_not" {
  command = apply

  assert {
    condition     = length(aws_subnet.public) == 2 && length(aws_subnet.private) == 2
    error_message = "One public and one private subnet per zone."
  }
  assert {
    condition     = aws_subnet.public[1].cidr_block == "10.40.1.0/24" && aws_subnet.private[1].cidr_block == "10.40.101.0/24"
    error_message = "Subnets are /24s: public from .0, private from .100."
  }
  assert {
    condition     = aws_route.public_internet.route_table_id == aws_route_table.public.id && aws_route.public_internet.gateway_id == aws_internet_gateway.this.id
    error_message = "The only route out is the public route table's, through the internet gateway."
  }
  assert {
    condition     = alltrue([for a in aws_route_table_association.private : a.route_table_id == aws_route_table.private[0].id])
    error_message = "Private subnets use the private route table, which has no route out."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.public : s.map_public_ip_on_launch == false])
    error_message = "Instances get a public address only when they ask for one."
  }
  assert {
    condition = alltrue([
      for tags in concat(
        [aws_vpc.this.tags, aws_internet_gateway.this.tags, aws_route_table.public.tags, aws_default_security_group.this.tags],
        [for s in aws_subnet.public : s.tags],
        [for s in aws_subnet.private : s.tags],
        [for t in aws_route_table.private : t.tags],
      ) : tags["Project"] == "ai-gateway" && tags["ManagedBy"] == "terraform"
    ])
    error_message = "Every network resource is tagged."
  }
}

run "no_private_subnets_unless_asked" {
  command = plan

  variables {
    private_subnets = false
  }

  assert {
    condition     = length(aws_subnet.private) == 0 && length(aws_route_table.private) == 0
    error_message = "private_subnets = false creates no private subnets."
  }
}

run "needs_a_zone" {
  command = plan

  variables {
    availability_zones = []
  }

  expect_failures = [var.availability_zones]
}
