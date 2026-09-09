# The three tables behind `@grove/game-manager`'s store: one method group per table, and `gameId` as
# the partition key of every one of them. A row belonging to another game is not in the partition a
# handler's token lets it name, so cross-game access is unreachable at the datastore too and not
# only at the scope above it.

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

locals {
  # A replicated table is a global table, and a global table is fed by a stream — so streams follow
  # the replicas rather than being a setting of their own.
  replicated      = length(var.replica_regions) > 0
  billing_mode    = "PAY_PER_REQUEST"
  stream_view     = local.replicated ? "NEW_AND_OLD_IMAGES" : null
  common_tags     = var.tags
  table_name_base = "grove-${var.environment}"
}

# `Read` and `Write`. `revision` is the compare-and-set column: a write carrying `ifRevision` is a
# conditional PutItem on it, which is why a stale write is a 409 rather than a lost update.
resource "aws_dynamodb_table" "state" {
  name             = "${local.table_name_base}-state"
  billing_mode     = local.billing_mode
  hash_key         = "gameId"
  range_key        = "key"
  stream_enabled   = local.replicated
  stream_view_type = local.stream_view

  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "gameId"
    type = "S"
  }

  attribute {
    name = "key"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  dynamic "replica" {
    for_each = var.replica_regions

    content {
      region_name            = replica.value
      point_in_time_recovery = var.point_in_time_recovery
    }
  }

  tags = merge(local.common_tags, { Name = "${local.table_name_base}-state" })
}

# `Leaderboard`. The partition is one board of one game, and the local index orders that partition by
# score — a page is one descending query, and its `LastEvaluatedKey` is the cursor the store mints.
# A local index rather than a global one because a board's ranking is only ever read within its own
# partition, and a global index would be a second eventually-consistent copy of it.
resource "aws_dynamodb_table" "leaderboards" {
  name             = "${local.table_name_base}-leaderboards"
  billing_mode     = local.billing_mode
  hash_key         = "boardId"
  range_key        = "playerId"
  stream_enabled   = local.replicated
  stream_view_type = local.stream_view

  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "boardId"
    type = "S"
  }

  attribute {
    name = "playerId"
    type = "S"
  }

  attribute {
    name = "score"
    type = "N"
  }

  local_secondary_index {
    name            = "by-score"
    range_key       = "score"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  dynamic "replica" {
    for_each = var.replica_regions

    content {
      region_name            = replica.value
      point_in_time_recovery = var.point_in_time_recovery
    }
  }

  tags = merge(local.common_tags, { Name = "${local.table_name_base}-leaderboards" })
}

# `Bundles`. One row per game, holding the set its sessions load — read on every session start and
# written once per deployment, which is why it is not a partition of the state table.
resource "aws_dynamodb_table" "bundles" {
  name             = "${local.table_name_base}-bundles"
  billing_mode     = local.billing_mode
  hash_key         = "gameId"
  stream_enabled   = local.replicated
  stream_view_type = local.stream_view

  deletion_protection_enabled = var.deletion_protection

  attribute {
    name = "gameId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = var.point_in_time_recovery
  }

  server_side_encryption {
    enabled = true
  }

  dynamic "replica" {
    for_each = var.replica_regions

    content {
      region_name            = replica.value
      point_in_time_recovery = var.point_in_time_recovery
    }
  }

  tags = merge(local.common_tags, { Name = "${local.table_name_base}-bundles" })
}
