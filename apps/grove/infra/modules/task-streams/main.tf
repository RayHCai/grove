# The Redis every queued task is announced on: `@grove/api` pushes a task id, `@grove/game-builder`
# and `@grove/upload-service` each claim from a stream of their own.
#
# A network of its own rather than a fleet region's. The three services that touch these streams are
# not built by this configuration, and the one thing that is — the game-instance fleet — must never
# reach them: a box running creator code that could read the build stream could settle somebody
# else's build. What this module hands back is the endpoint and the ids a service deployment joins.

locals {
  name = "grove-${var.environment}-tasks"
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "tasks" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = local.name })
}

# Private, and no gateway of any kind: nothing in here initiates a connection out, and nothing
# outside the declared blocks below reaches in.
resource "aws_subnet" "tasks" {
  count = var.subnet_count

  vpc_id            = aws_vpc.tasks.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(aws_vpc.tasks.cidr_block, 4, count.index)

  tags = merge(var.tags, { Name = "${local.name}-${data.aws_availability_zones.available.names[count.index]}" })
}

resource "aws_security_group" "tasks" {
  name        = local.name
  description = "The cache holding Grove's task streams in ${var.environment}"
  vpc_id      = aws_vpc.tasks.id

  tags = merge(var.tags, { Name = local.name })
}

# Named blocks rather than the VPC's own: what reaches the streams is the three services, and they
# are deployed into networks this configuration does not build.
resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each = toset(var.client_cidrs)

  security_group_id = aws_security_group.tasks.id
  description       = "Redis from ${each.value}"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 6379
  to_port           = 6379
}

# Serverless, because the load is a message per save and per publish: a sized node would be chosen
# for a peak nobody can name yet, and this one has no capacity decision in it at all.
resource "aws_elasticache_serverless_cache" "tasks" {
  name   = local.name
  engine = "redis"

  subnet_ids         = aws_subnet.tasks[*].id
  security_group_ids = [aws_security_group.tasks.id]

  # Encryption in transit and at rest is not a setting here: a serverless cache has both on always,
  # which is half of why this is one rather than a sized node.
  cache_usage_limits {
    data_storage {
      maximum = var.max_storage_gb
      unit    = "GB"
    }

    ecpu_per_second {
      maximum = var.max_ecpu_per_second
    }
  }


  tags = merge(var.tags, { Name = local.name })
}

# A cache that is not answering is every save that lands an asset and every publish going unqueued,
# which nothing else in this deployment reports.
resource "aws_cloudwatch_metric_alarm" "tasks_unreachable" {
  alarm_name          = "${local.name}-unreachable"
  alarm_description   = "The ${var.environment} task streams stopped answering"
  namespace           = "AWS/ElastiCache"
  metric_name         = "SuccessfulReadRequestLatency"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = var.latency_alarm_threshold_us
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    CacheClusterId = aws_elasticache_serverless_cache.tasks.name
  }

  alarm_actions = var.alarm_actions
  ok_actions    = var.alarm_actions

  tags = merge(var.tags, { Name = "${local.name}-unreachable" })
}
