terraform {
  # mock_provider tests and the provider version below need a recent Terraform.
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.69.1"
    }
  }
}

# Not applied yet (see docs/aws-deployment.md). The region comes from a variable, credentials
# from the person who someday runs `terraform apply`; CI runs only fmt, validate and tests with
# a mocked provider, so it never needs credentials.
provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}
