output "queue_url" {
  description = "URL a builder polls for queued builds."
  value       = aws_sqs_queue.builds.id
}

output "queue_arn" {
  description = "ARN of the build queue."
  value       = aws_sqs_queue.builds.arn
}

output "dlq_url" {
  description = "URL of the dead-letter queue holding builds that never succeeded."
  value       = aws_sqs_queue.builds_dlq.id
}

output "rule_arn" {
  description = "ARN of the rule matching source uploads."
  value       = aws_cloudwatch_event_rule.source_uploaded.arn
}
