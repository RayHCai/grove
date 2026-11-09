# The two tables `@grove/game-manager`'s store is keyed for. `gameId` partitions both, so a row
# belonging to another game is not in the partition a handler's token lets it name, the guarantee
# that service's scope makes, held at the datastore as well as above it.

locals {
  # A replicated table is a global table, and a global table is fed by a stream, so streams follow
  # the replicas rather than being a setting of their own.
  replicated      = length(var.replica_regions) > 0
  billing_mode    = "PAY_PER_REQUEST"
  stream_view     = local.replicated ? "NEW_AND_OLD_IMAGES" : null
  common_tags     = var.tags
  table_name_base = "grove-${var.environment}"
}

# `Read`, `Write` and `Delete`. `revision` is the compare-and-set column: a write carrying
# `ifRevision` is a conditional PutItem on it, so a stale write is a 409 within one region, while a
# global table settles two regions' concurrent writes to one key by last writer wins.
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

# One row per game, holding the set its sessions load, read on every session start and
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
