# The one bucket every game lives in, game first: `<game-id>/source/`, `<game-id>/assets/`,
# `<game-id>/manifests/` and `<game-id>/build/`. The policy is what tells those classes apart, and
# it matches them mid-key rather than at the front, because the game owns the prefix. `source/` and
# `manifests/` match no pattern and so are reachable from no principal this module grants.

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

data "aws_iam_policy_document" "games" {
  # The distribution reads through an origin access control, and only the classes meant for the
  # edge. The wildcard is mid-key because the game comes first, so one pattern covers every game's
  # build output without naming one: `source/` and `manifests/` match none of them, which is what
  # keeps a creator's code inside the fleet.
  statement {
    sid     = "AllowCloudFrontRead"
    actions = ["s3:GetObject"]
    resources = [
      for pattern in var.cdn_prefixes : "${aws_s3_bucket.games.arn}/*/${pattern}*"
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
