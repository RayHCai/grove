terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # One bucket for both deployments, one key each. `use_lockfile` puts the lock in the state bucket
  # beside the state, so there is no lock table to provision before the first apply can run.
  backend "s3" {
    bucket       = "grove-terraform-state"
    key          = "production/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
