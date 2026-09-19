# One whole deployment. Staging and production differ in what they pass here and in nothing else, so
# a change to the shape of a deployment cannot land in one and be forgotten in the other.

locals {
  tags = merge(var.tags, {
    Project     = "grove"
    Environment = var.environment
    ManagedBy   = "terraform"
  })

  # A box's agent is reachable from the fleet's own declared blocks, of which only this region's is
  # routable until the regions are peered. Taken from the slots rather than from the built VPCs,
  # which would be a cycle.
  agent_cidrs = [for slot in var.fleet : slot.vpc_cidr]
}

module "storage" {
  source = "../game-storage"

  environment         = var.environment
  bucket_name         = var.bucket_name
  price_class         = var.cdn_price_class
  access_logs_enabled = var.cdn_access_logs_enabled
  force_destroy       = !var.deletion_protection
  tags                = local.tags
}

module "tasks" {
  source = "../task-streams"

  environment   = var.environment
  client_cidrs  = var.task_client_cidrs
  alarm_actions = var.task_alarm_actions
  tags          = local.tags
}

module "data" {
  source = "../game-data"

  environment            = var.environment
  replica_regions        = var.dynamodb_replica_regions
  point_in_time_recovery = var.point_in_time_recovery
  deletion_protection    = var.deletion_protection
  tags                   = local.tags
}

module "fleet_a" {
  source    = "../fleet-region"
  providers = { aws = aws.fleet_a }

  environment           = var.environment
  region                = var.fleet["a"].region
  vpc_cidr              = var.fleet["a"].vpc_cidr
  instance_type         = var.fleet["a"].instance_type
  instance_count        = var.fleet["a"].instance_count
  max_instances_per_box = var.fleet["a"].max_instances_per_box
  root_volume_gb        = var.fleet["a"].root_volume_gb

  server_manager_url    = var.server_manager_url
  fleet_cidrs           = local.agent_cidrs
  artifact_bucket_arn   = module.storage.bucket_arn
  dynamodb_arn_patterns = module.data.table_arn_patterns
  tags                  = local.tags
}

module "fleet_b" {
  source    = "../fleet-region"
  providers = { aws = aws.fleet_b }

  environment           = var.environment
  region                = var.fleet["b"].region
  vpc_cidr              = var.fleet["b"].vpc_cidr
  instance_type         = var.fleet["b"].instance_type
  instance_count        = var.fleet["b"].instance_count
  max_instances_per_box = var.fleet["b"].max_instances_per_box
  root_volume_gb        = var.fleet["b"].root_volume_gb

  server_manager_url    = var.server_manager_url
  fleet_cidrs           = local.agent_cidrs
  artifact_bucket_arn   = module.storage.bucket_arn
  dynamodb_arn_patterns = module.data.table_arn_patterns
  tags                  = local.tags
}

module "fleet_c" {
  source    = "../fleet-region"
  providers = { aws = aws.fleet_c }

  environment           = var.environment
  region                = var.fleet["c"].region
  vpc_cidr              = var.fleet["c"].vpc_cidr
  instance_type         = var.fleet["c"].instance_type
  instance_count        = var.fleet["c"].instance_count
  max_instances_per_box = var.fleet["c"].max_instances_per_box
  root_volume_gb        = var.fleet["c"].root_volume_gb

  server_manager_url    = var.server_manager_url
  fleet_cidrs           = local.agent_cidrs
  artifact_bucket_arn   = module.storage.bucket_arn
  dynamodb_arn_patterns = module.data.table_arn_patterns
  tags                  = local.tags
}
