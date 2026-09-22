terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Remote state with locking.
  #
  # Local state means two engineers applying at once corrupt each other's
  # work, and a laptop dying takes the record of production with it. S3 for
  # the state, DynamoDB for the lock.
  backend "s3" {
    bucket         = "ledgercore-tfstate"
    key            = "ledgercore/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "ledgercore-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = var.project
      Env       = var.env
      ManagedBy = "terraform"
    }
  }
}

# CloudFront certificates MUST live in us-east-1, regardless of where
# everything else is. A global service with one regional control plane.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  name = "${var.project}-${var.env}"
}
