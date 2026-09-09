data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Forwards the CORS request headers to the origin and keeps them in the cache key, so one object is
# not cached with another origin's answer.
data "aws_cloudfront_origin_request_policy" "cors_s3" {
  name = "Managed-CORS-S3Origin"
}

data "aws_cloudfront_response_headers_policy" "cors_and_security" {
  name = "Managed-CORS-and-SecurityHeadersPolicy"
}

resource "aws_cloudfront_origin_access_control" "games" {
  name                              = "grove-${var.environment}-games"
  description                       = "Signs the distribution's reads of the ${var.environment} games bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "games" {
  enabled         = true
  comment         = "grove-${var.environment} games"
  price_class     = var.price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id                = "games"
    domain_name              = aws_s3_bucket.games.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.games.id
  }

  # Read-only by design: a bundle is published through `@grove/upload-service`, never through the
  # edge, so the distribution has no method that could write one.
  default_cache_behavior {
    target_origin_id       = "games"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.cors_s3.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.cors_and_security.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  dynamic "logging_config" {
    for_each = var.access_logs_enabled ? [1] : []

    content {
      bucket          = aws_s3_bucket.access_logs[0].bucket_domain_name
      prefix          = "cloudfront/"
      include_cookies = false
    }
  }

  tags = merge(var.tags, { Name = "grove-${var.environment}-games" })
}

resource "aws_s3_bucket" "access_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket        = "${var.bucket_name}-logs"
  force_destroy = var.force_destroy

  tags = merge(var.tags, { Name = "${var.bucket_name}-logs" })
}

# The log bucket is the one place ACLs stay on: CloudFront's standard log delivery writes as its own
# canonical user and grants the bucket owner nothing unless the ACL says so.
resource "aws_s3_bucket_ownership_controls" "access_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "access_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  access_control_policy {
    grant {
      permission = "FULL_CONTROL"

      grantee {
        type = "CanonicalUser"
        id   = local.cloudfront_log_delivery_canonical_id
      }
    }

    grant {
      permission = "FULL_CONTROL"

      grantee {
        type = "CanonicalUser"
        id   = data.aws_canonical_user_id.current.id
      }
    }

    owner {
      id = data.aws_canonical_user_id.current.id
    }
  }

  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  count = var.access_logs_enabled ? 1 : 0

  bucket = aws_s3_bucket.access_logs[0].id

  rule {
    id     = "expire"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }
  }
}

data "aws_canonical_user_id" "current" {}

locals {
  # AWS publishes one canonical id for the `awslogsdelivery` account that writes CloudFront's
  # standard logs; it is the same in every commercial region.
  cloudfront_log_delivery_canonical_id = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0"
}
