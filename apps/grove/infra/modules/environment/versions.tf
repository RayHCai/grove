terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"

      # One deployment spans four regions: the primary holds the bucket, the tables and the
      # distribution, and each of the three fleet slots holds a region's worth of boxes. Terraform
      # binds a provider to a region at configuration time, so the count of regions is the count of
      # providers, and the root passes them in.
      configuration_aliases = [aws.fleet_a, aws.fleet_b, aws.fleet_c]
    }
  }
}
