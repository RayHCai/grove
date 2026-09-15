output "games_bucket" {
  description = "Name of the games bucket."
  value       = module.storage.bucket_name
}

output "cdn_domain_name" {
  description = "Hostname a client fetches bundles and assets from."
  value       = module.storage.cdn_domain_name
}

output "cdn_distribution_id" {
  description = "Id of the games distribution, for an invalidation."
  value       = module.storage.distribution_id
}

output "build_queue_url" {
  description = "URL a builder polls for queued builds."
  value       = module.events.queue_url
}

output "build_dlq_url" {
  description = "URL of the queue holding builds that never succeeded."
  value       = module.events.dlq_url
}

output "tables" {
  description = "The two tables `@grove/game-manager`'s store is keyed for."
  value = {
    state   = module.data.state_table_name
    bundles = module.data.bundles_table_name
  }
}

output "fleet" {
  description = "Each region's boxes: the group holding them and the network they sit in."
  value = {
    for slot, fleet in {
      a = module.fleet_a
      b = module.fleet_b
      c = module.fleet_c
      } : slot => {
      region                 = fleet.region
      vpc_id                 = fleet.vpc_id
      vpc_cidr               = fleet.vpc_cidr
      autoscaling_group_name = fleet.autoscaling_group_name
      security_group_id      = fleet.security_group_id
      secret_path            = fleet.secret_path
    }
  }
}
