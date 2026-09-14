# One self-contained network per region. Nothing is shared across regions: a box only ever talks to
# `@grove/server-manager` and to players, both over the internet, and a fleet-wide network would put
# a cross-region dependency on the path of every session.

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "grove-${var.environment}-fleet-${var.region}"
  azs  = slice(data.aws_availability_zones.available.names, 0, var.subnet_count)
}

resource "aws_vpc" "fleet" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(var.tags, { Name = local.name })

  # The provider reaches this module by alias, and an alias carries no region a caller can read
  # back. This is what turns a slot wired to the wrong provider into a failed plan rather than a
  # region of boxes nobody meant to build.
  lifecycle {
    precondition {
      condition     = data.aws_region.current.region == var.region
      error_message = "fleet-region was told ${var.region} but its provider is in ${data.aws_region.current.region}."
    }
  }
}

resource "aws_internet_gateway" "fleet" {
  vpc_id = aws_vpc.fleet.id

  tags = merge(var.tags, { Name = local.name })
}

# Public subnets, because a player's client opens a WebSocket straight to the game process. Putting
# the boxes behind NAT would mean terminating every session at a load balancer, which is the one
# thing the architecture keeps off the per-tick path.
resource "aws_subnet" "fleet" {
  count = var.subnet_count

  vpc_id                  = aws_vpc.fleet.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  map_public_ip_on_launch = true

  tags = merge(var.tags, { Name = "${local.name}-${local.azs[count.index]}" })
}

resource "aws_route_table" "fleet" {
  vpc_id = aws_vpc.fleet.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.fleet.id
  }

  tags = merge(var.tags, { Name = local.name })
}

resource "aws_route_table_association" "fleet" {
  count = var.subnet_count

  subnet_id      = aws_subnet.fleet[count.index].id
  route_table_id = aws_route_table.fleet.id
}

resource "aws_security_group" "fleet" {
  name        = local.name
  description = "Grove fleet box: game traffic from players, agent traffic from the fleet"
  vpc_id      = aws_vpc.fleet.id

  tags = merge(var.tags, { Name = local.name })
}

# The one rule the outside world gets. A game process binds a port the kernel picked, so the range
# rather than a port — and the process itself verifies a signed join ticket before a frame crosses,
# which is what makes an open range safe rather than merely necessary.
resource "aws_vpc_security_group_ingress_rule" "game_sessions" {
  security_group_id = aws_security_group.fleet.id
  description       = "Players dialling their game process directly"
  ip_protocol       = "tcp"
  from_port         = var.game_port_range[0]
  to_port           = var.game_port_range[1]
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "agent" {
  for_each = toset(var.fleet_cidrs)

  security_group_id = aws_security_group.fleet.id
  description       = "The fleet's own blocks reaching this box's agent"
  ip_protocol       = "tcp"
  from_port         = var.instance_manager_port
  to_port           = var.instance_manager_port
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.fleet.id
  description       = "Bundle pulls, heartbeats, and the store"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
