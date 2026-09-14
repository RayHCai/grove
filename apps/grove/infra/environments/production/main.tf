locals {
  environment = "production"

  tags = {
    Project     = "grove"
    Environment = local.environment
    ManagedBy   = "terraform"
  }

  # Every fleet region that is not already the primary. Derived rather than listed, so moving a slot
  # to another region moves its replica with it.
  replica_regions = distinct([
    for slot in var.fleet : slot.region if slot.region != var.primary_region
  ])
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

  # A replica in every fleet region. A `@serverState` write sits inside a tick, and a tick that
  # crossed the continent to reach the store would spend its whole budget waiting.
  dynamodb_replica_regions = local.replica_regions
  point_in_time_recovery   = true

  # On. A destroy that reached these would take every game's saves and every board with it, and
  # nothing about this deployment is disposable.
  deletion_protection = true

  cdn_price_class         = "PriceClass_All"
  cdn_access_logs_enabled = true

  tags = local.tags
}
