# The one bucket every published game is served out of: `sources/` holds the archives a build
# compiles, `bundles/` the artifacts a session loads, `assets/` what a game draws with.

resource "aws_s3_bucket" "games" {
  bucket        = var.bucket_name
  force_destroy = var.force_destroy

  tags = merge(var.tags, { Name = var.bucket_name })
}

# Bucket-owner-enforced disables ACLs outright, so an object's readability is the bucket policy's
# answer alone and an upload cannot widen it.
resource "aws_s3_bucket_ownership_controls" "games" {
  bucket = aws_s3_bucket.games.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "games" {
  bucket = aws_s3_bucket.games.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# An object is named by the hash of its own bytes, so a version is only ever created by a re-upload
# of identical content — versioning here is a recovery window against a delete, not a history.
resource "aws_s3_bucket_versioning" "games" {
  bucket = aws_s3_bucket.games.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "games" {
  bucket = aws_s3_bucket.games.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "games" {
  bucket = aws_s3_bucket.games.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    # A multi-megabyte bundle arrives as a multipart upload, and a build that died mid-push leaves
    # parts that are billed and unreachable.
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.games]
}

# What turns an upload into a build: with this on, every object event goes to the default event bus,
# which is where `upload-events` picks the ones it cares about.
resource "aws_s3_bucket_notification" "games" {
  bucket      = aws_s3_bucket.games.id
  eventbridge = true
}

data "aws_iam_policy_document" "games" {
  # The distribution reads through an origin access control, and only under the prefixes meant for
  # the edge: `sources/` is a creator's private code and never leaves the fleet.
  statement {
    sid     = "AllowCloudFrontRead"
    actions = ["s3:GetObject"]
    resources = [
      for prefix in var.cdn_prefixes : "${aws_s3_bucket.games.arn}/${prefix}*"
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.games.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.games.arn, "${aws_s3_bucket.games.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "games" {
  bucket = aws_s3_bucket.games.id
  policy = data.aws_iam_policy_document.games.json

  depends_on = [aws_s3_bucket_public_access_block.games]
}
