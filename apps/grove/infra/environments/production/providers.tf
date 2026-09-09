# The primary region holds the bucket, the tables and the distribution. The three aliases are the
# fleet, one per region, and the slot letters in `terraform.tfvars` line up with them.

provider "aws" {
  region = var.primary_region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "fleet_a"
  region = var.fleet["a"].region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "fleet_b"
  region = var.fleet["b"].region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "fleet_c"
  region = var.fleet["c"].region

  default_tags {
    tags = local.tags
  }
}
