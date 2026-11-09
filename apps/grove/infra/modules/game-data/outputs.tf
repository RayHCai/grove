output "state_table_name" {
  description = "Table keyed for `Read`, `Write` and `Delete`."
  value       = aws_dynamodb_table.state.name
}

output "bundles_table_name" {
  description = "Table holding the bundle set each game's sessions load."
  value       = aws_dynamodb_table.bundles.name
}
