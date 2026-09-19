output "endpoint" {
  description = "Host and port the three services open a Redis connection to."
  value = {
    host = aws_elasticache_serverless_cache.tasks.endpoint[0].address
    port = aws_elasticache_serverless_cache.tasks.endpoint[0].port
  }
}

output "vpc_id" {
  description = "Id of the network the cache sits in."
  value       = aws_vpc.tasks.id
}

output "subnet_ids" {
  description = "Subnets the cache is reachable in, for a service deployed beside it."
  value       = aws_subnet.tasks[*].id
}

output "security_group_id" {
  description = "Security group guarding the cache."
  value       = aws_security_group.tasks.id
}
