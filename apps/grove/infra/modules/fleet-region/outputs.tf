output "region" {
  description = "Region these boxes run in."
  value       = var.region
}

output "vpc_id" {
  description = "Id of this region's fleet network."
  value       = aws_vpc.fleet.id
}

output "vpc_cidr" {
  description = "Address block of this region's fleet network, for the other regions' agent rules."
  value       = aws_vpc.fleet.cidr_block
}

output "security_group_id" {
  description = "Security group every box in this region carries."
  value       = aws_security_group.fleet.id
}

output "autoscaling_group_name" {
  description = "Name of the group holding this region's boxes."
  value       = aws_autoscaling_group.fleet.name
}

output "role_arn" {
  description = "ARN of the role a box assumes."
  value       = aws_iam_role.fleet.arn
}

output "secret_path" {
  description = "Parameter Store prefix holding this region's copy of the two shared secrets."
  value       = local.secret_path
}
