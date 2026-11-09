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

locals {
  # One game id, character for character: a `*` here would span slashes and match
  # `<game>/source/build/...`, and an upload is quarantined under `uploads/`, which this never matches.
  game_segment = "????????-????-????-????-????????????"
}

data "aws_iam_policy_document" "fleet" {
  # Build output and assets only, anchored to the game id that begins every key: a box pulls what a
  # session loads and never a creator's source, the manifests that name it, or an unchecked upload.
  statement {
    sid     = "ReadBuilds"
    actions = ["s3:GetObject"]
    resources = [
      "${var.artifact_bucket_arn}/${local.game_segment}/build/*",
      "${var.artifact_bucket_arn}/${local.game_segment}/assets/*",
    ]
  }

  statement {
    sid       = "ListBuilds"
    actions   = ["s3:ListBucket"]
    resources = [var.artifact_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.game_segment}/build/*", "${local.game_segment}/assets/*"]
    }
  }

  # What a box is configured with, read before every agent start and never written from here.
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

  # Each box names itself at boot, so the grant is an A record under the fleet's own domain and
  # nothing else in the zone.
  statement {
    sid       = "NameThisBox"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:${data.aws_partition.current.partition}:route53:::hostedzone/${var.fleet_zone_id}"]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values   = ["*.${var.fleet_domain}"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["A"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsActions"
      values   = ["UPSERT"]
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

# Parameter Store is regional, so each region holds its own copy of what a box reads. Terraform
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

resource "aws_ssm_parameter" "ticket_public_keys" {
  name        = "${local.secret_path}/TICKET_PUBLIC_KEYS"
  description = "The api's join-ticket public keys, comma-separated; no box holds a key that signs one"
  type        = "String"
  value       = "replace-me"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, { Name = "${local.name}-ticket-public-keys" })
}

# Advanced, because a certificate chain in PEM outgrows the standard tier's 4 KB.
resource "aws_ssm_parameter" "tls_cert" {
  name        = "${local.secret_path}/TLS_CERT"
  description = "PEM chain covering *.${var.fleet_domain}, served on both of every box's listeners"
  type        = "String"
  tier        = "Advanced"
  value       = "replace-me"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, { Name = "${local.name}-tls-cert" })
}

resource "aws_ssm_parameter" "tls_key" {
  name        = "${local.secret_path}/TLS_KEY"
  description = "PEM private key of TLS_CERT"
  type        = "SecureString"
  value       = "replace-me"

  lifecycle {
    ignore_changes = [value]
  }

  tags = merge(var.tags, { Name = "${local.name}-tls-key" })
}
