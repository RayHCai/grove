output "state_table_name" {
  description = "Table behind `Read` and `Write`."
  value       = aws_dynamodb_table.state.name
}

output "leaderboards_table_name" {
  description = "Table behind `Leaderboard`."
  value       = aws_dynamodb_table.leaderboards.name
}

output "bundles_table_name" {
  description = "Table behind `Bundles`."
  value       = aws_dynamodb_table.bundles.name
}

output "table_arns" {
  description = "ARNs of all three tables in the primary region."
  value = [
    aws_dynamodb_table.state.arn,
    aws_dynamodb_table.leaderboards.arn,
    aws_dynamodb_table.bundles.arn,
  ]
}

# A replica has an ARN of its own, one per region, and a fleet box calls the one beside it. Granting
# by name across every region is what keeps one role usable from all three.
output "table_arn_patterns" {
  description = "ARN patterns covering every table and index, in the primary region and in each replica."
  value = flatten([
    for name in [
      aws_dynamodb_table.state.name,
      aws_dynamodb_table.leaderboards.name,
      aws_dynamodb_table.bundles.name,
      ] : [
      "arn:${data.aws_partition.current.partition}:dynamodb:*:${data.aws_caller_identity.current.account_id}:table/${name}",
      "arn:${data.aws_partition.current.partition}:dynamodb:*:${data.aws_caller_identity.current.account_id}:table/${name}/index/*",
    ]
  ])
}
