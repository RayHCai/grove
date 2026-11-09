# The one bucket every game lives in, game first: `<game-id>/source/`, `<game-id>/assets/`,
# `<game-id>/manifests/` and `<game-id>/build/`, beside `uploads/<game-id>/`, where an asset waits to
# be inspected. The policy is what tells those classes apart: it matches the class right after a
# game id, so `source/`, `manifests/` and `uploads/` are reachable from no principal it grants.

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

# A save overwrites a creator's file in place, so this is the history: the version id a manifest
# freezes is what makes every prior byte-set of every path still addressable, and a delete leaves a
# marker rather than taking the bytes an older manifest still names.
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

locals {
  # A game id is a uuid, so this matches exactly one game segment and nothing that merely contains one.
  game_segment = "????????-????-????-????-????????????"
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

  # An upload is read once, by its inspection, and a copy past quarantine is what a game keeps; one
  # nobody saved, or that failed, is bytes no row names.
  rule {
    id     = "expire-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = var.upload_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.upload_retention_days
    }
  }

  # Every save is a version of each key it wrote, so without this the history grows with every keystroke
  # the editor saves; a manifest older than the window may name versions that are gone.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.games]
}

# A creator's asset goes from the browser to the bucket over a presigned PUT, and the editor reads a
# source file back the same way, so the origins a signed-in person works from are the ones allowed.
resource "aws_s3_bucket_cors_configuration" "games" {
  bucket = aws_s3_bucket.games.id

  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = var.browser_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "x-amz-version-id"]
    max_age_seconds = 300
  }
}

data "aws_iam_policy_document" "games" {
  # The distribution reads through an origin access control, and only the classes meant for the
  # edge. Each pattern names the class right after a game id, never anywhere in the key, so a source
  # file a creator put under a folder named `build/` is not edge-readable for being there.
  statement {
    sid     = "AllowCloudFrontRead"
    actions = ["s3:GetObject"]
    resources = [
      for pattern in var.cdn_prefixes : "${aws_s3_bucket.games.arn}/${local.game_segment}/${pattern}*"
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
