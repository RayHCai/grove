data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fleet" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = merge(var.tags, { Name = local.name })
}

# Session Manager is the only way onto a box: there is no key pair and no inbound SSH rule, so an
# operator's access is an IAM decision that leaves a trail rather than a key someone still holds.
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.fleet.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "fleet" {
  # Bundles only. A box pulls the artifacts a session loads and never the source archives that
  # produced them, which stay readable to the builder alone.
  statement {
    sid     = "ReadBundles"
    actions = ["s3:GetObject"]
    resources = [
      "${var.artifact_bucket_arn}/bundles/*",
      "${var.artifact_bucket_arn}/assets/*",
    ]
  }

  statement {
    sid       = "ListBundles"
    actions   = ["s3:ListBucket"]
    resources = [var.artifact_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["bundles/*", "assets/*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.dynamodb_arn_patterns) > 0 ? [1] : []

    content {
      sid = "GameData"
      actions = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchGetItem",
        "dynamodb:BatchWriteItem",
      ]
      resources = var.dynamodb_arn_patterns
    }
  }

  dynamic "statement" {
    for_each = var.build_queue_arn == "" ? [] : [1]

    content {
      sid = "ClaimBuilds"
      actions = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
      ]
      resources = [var.build_queue_arn]
    }
  }

  # The two secrets a box needs, read at boot and never written from here.
  statement {
    sid     = "ReadFleetSecrets"
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.secret_path}/*",
    ]
  }

  statement {
    sid       = "DecryptFleetSecrets"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${data.aws_partition.current.partition}:kms:${var.region}:${data.aws_caller_identity.current.account_id}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "fleet" {
  name   = local.name
  role   = aws_iam_role.fleet.id
  policy = data.aws_iam_policy_document.fleet.json
}

resource "aws_iam_instance_profile" "fleet" {
  name = local.name
  role = aws_iam_role.fleet.name

  tags = merge(var.tags, { Name = local.name })
}

locals {
  secret_path = "/grove/${var.environment}/fleet"
}

# Parameter Store is regional, so each region holds its own copy of the two shared secrets. Terraform
# creates the parameter and never the value: a secret in a variable file is a secret in state and in
# every plan output, so the placeholder is rotated in out of band and ignored here forever after.
resource "aws_ssm_parameter" "fleet_secret" {
  name        = "${local.secret_path}/FLEET_SECRET"
  description = "Shared bearer between @grove/server-manager and every agent, 32 bytes up"
  type        = "SecureString"
  value       = "replace-me"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, { Name = "${local.name}-fleet-secret" })
}

resource "aws_ssm_parameter" "game_token_secret" {
  name        = "${local.secret_path}/GAME_TOKEN_SECRET"
  description = "Signs the join tickets a game process verifies; minted by @grove/api"
  type        = "SecureString"
  value       = "replace-me"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, { Name = "${local.name}-game-token-secret" })
}
