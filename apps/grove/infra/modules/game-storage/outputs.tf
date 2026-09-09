output "bucket_name" {
  description = "Name of the games bucket."
  value       = aws_s3_bucket.games.id
}

output "bucket_arn" {
  description = "ARN of the games bucket."
  value       = aws_s3_bucket.games.arn
}

output "distribution_id" {
  description = "Id of the distribution in front of the bucket."
  value       = aws_cloudfront_distribution.games.id
}

output "cdn_domain_name" {
  description = "Hostname a client fetches bundles and assets from."
  value       = aws_cloudfront_distribution.games.domain_name
}
