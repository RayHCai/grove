variable "environment" {
  description = "Which deployment this region's boxes belong to; it namespaces every name here."
  type        = string
}

variable "region" {
  description = "The region this module is expected to build in. Checked against the provider it was given, because the provider is passed by alias and an alias cannot be verified by reading it."
  type        = string
}

variable "vpc_cidr" {
  description = "Address space for this region's fleet network. Every region's block must be distinct, or a peering between two of them can never be routed."
  type        = string
}

variable "subnet_count" {
  description = "Availability zones this region spreads its boxes over."
  type        = number
  default     = 2
}

variable "instance_type" {
  description = "Shape of one fleet box. It holds `@grove/instance-manager` and up to `max_instances` game processes."
  type        = string
}

variable "instance_count" {
  description = "Boxes this region runs."
  type        = number
  default     = 1
}

variable "max_instance_count" {
  description = "Ceiling the group may grow to. Equal to `instance_count` keeps the fleet a fixed size."
  type        = number
  default     = null
}

variable "root_volume_gb" {
  description = "Root volume size. It holds the pulled bundle sets as well as the binaries."
  type        = number
  default     = 30
}

variable "ami_ssm_parameter" {
  description = "SSM parameter, in this region, holding the id of the fleet image: one built with both binaries under /opt/grove/bin. No default, because a stock image boots a box with no agent on it. Resolved at plan time, so a new image is a visible diff rather than a silent replacement."
  type        = string
}

variable "max_instances_per_box" {
  description = "Game processes one box may hold; `MAX_INSTANCES` for the agent."
  type        = number
  default     = 8
}

variable "heartbeat_interval" {
  description = "How often a box beats to `@grove/server-manager`; `HEARTBEAT_INTERVAL` for the agent."
  type        = string
  default     = "10s"
}

variable "instance_manager_port" {
  description = "Port the agent's control listener binds. Reachable from the fleet's own blocks and from `server_manager_cidrs`, and from nowhere else."
  type        = number
  default     = 4004
}

variable "player_port" {
  description = "Port the agent's player proxy binds, the one port on a box the internet reaches; `PLAYER_PORT` for the agent. Every game process binds loopback behind it."
  type        = number
  default     = 443
}

variable "fleet_domain" {
  description = "Domain every box is named under, as `<host-id>.<fleet_domain>`: the name players and `@grove/server-manager` dial, and the one the TLS certificate in Parameter Store must cover. No default, because a box nothing can name is a box nothing can reach."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.fleet_domain))
    error_message = "fleet_domain is a lowercase DNS name with no trailing dot."
  }
}

variable "fleet_zone_id" {
  description = "Route 53 hosted zone holding `fleet_domain`, where each box writes its own A record at boot."
  type        = string
}

variable "server_manager_cidrs" {
  description = "Address blocks `@grove/server-manager` reaches the agents from (its static egress), which is what opens the control port to it. No default: an empty list is a fleet the router cannot start a world on."
  type        = list(string)

  validation {
    condition     = length(var.server_manager_cidrs) > 0 && alltrue([for block in var.server_manager_cidrs : can(cidrhost(block, 0))])
    error_message = "server_manager_cidrs needs at least one block, and each must be a CIDR."
  }
}

variable "child_memory_max_bytes" {
  description = "Memory one game process's cgroup may hold, `memory.max`; `CHILD_MEMORY_MAX_BYTES` for the agent."
  type        = number
  default     = 1073741824
}

variable "child_pids_max" {
  description = "Tasks one game process's cgroup may hold, `pids.max`; `CHILD_PIDS_MAX` for the agent."
  type        = number
  default     = 256
}

variable "server_manager_url" {
  description = "Where a box's heartbeat goes; `SERVER_MANAGER_URL` for the agent."
  type        = string
}

variable "game_manager_url" {
  description = "Where every game process on a box reads and writes its state; `GAME_MANAGER_URL` for the agent."
  type        = string
}

variable "fleet_cidrs" {
  description = "Address blocks allowed to reach the agent's own port. The fleet's own networks, never the internet."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for block in var.fleet_cidrs : can(cidrhost(block, 0))])
    error_message = "Each block must be a CIDR, or its rule is one that matches nothing and is never noticed."
  }
}

variable "artifact_bucket_arn" {
  description = "Games bucket a box may read build output and assets from."
  type        = string
}

variable "tags" {
  description = "Tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}

