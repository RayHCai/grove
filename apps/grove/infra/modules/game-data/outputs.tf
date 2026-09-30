output "state_table_name" {
  description = "Table keyed for `Read`, `Write` and `Leaderboard`."
  value       = aws_dynamodb_table.state.name
}

output "bundles_table_name" {
  description = "Table keyed for `Bundles`."
  value       = aws_dynamodb_table.bundles.name
}
