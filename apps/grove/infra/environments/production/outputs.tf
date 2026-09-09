output "games_bucket" {
  description = "Name of the games bucket."
  value       = module.grove.games_bucket
}

output "cdn_domain_name" {
  description = "Hostname a client fetches bundles and assets from."
  value       = module.grove.cdn_domain_name
}

output "cdn_distribution_id" {
  description = "Id of the games distribution."
  value       = module.grove.cdn_distribution_id
}

output "build_queue_url" {
  description = "URL `@grove/game-builder` polls for queued builds."
  value       = module.grove.build_queue_url
}

output "tables" {
  description = "The three tables behind `@grove/game-manager`."
  value       = module.grove.tables
}

output "fleet" {
  description = "Each region's boxes."
  value       = module.grove.fleet
}
