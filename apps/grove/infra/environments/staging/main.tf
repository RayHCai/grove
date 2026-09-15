locals {
  environment = "staging"

  tags = {
    Project     = "grove"
    Environment = local.environment
    ManagedBy   = "terraform"
  }
}

module "grove" {
  source = "../../modules/environment"

  providers = {
    aws         = aws
    aws.fleet_a = aws.fleet_a
    aws.fleet_b = aws.fleet_b
    aws.fleet_c = aws.fleet_c
  }

  environment        = local.environment
  bucket_name        = var.bucket_name
  fleet              = var.fleet
  server_manager_url = var.server_manager_url

  # No replicas: a staging tick may cross a region to reach the store, and the cost of a second copy
  # of both tables buys nothing a staging run needs to observe.
  dynamodb_replica_regions = []
  point_in_time_recovery   = false

  # Off, so a staging teardown is one command. It is the difference that makes this environment
  # disposable, and the reason production sets it the other way.
  deletion_protection = false

  cdn_price_class         = "PriceClass_100"
  cdn_access_logs_enabled = false

  tags = local.tags
}
