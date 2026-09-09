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
  description = "Public SSM parameter naming the AMI a box boots. Resolved at plan time, so a new image is a visible diff rather than a silent replacement."
  type        = string
  default     = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
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
  description = "Port the agent binds. Reachable from the fleet network and from nowhere else."
  type        = number
  default     = 4004
}

variable "game_port_range" {
  description = "Ports the game processes bind. The agent asks the kernel for a free one, so this is the kernel's ephemeral range — and it is open to the internet because a player dials their game process directly."
  type        = list(number)
  default     = [32768, 60999]
}

variable "server_manager_url" {
  description = "Where a box's heartbeat goes; `SERVER_MANAGER_URL` for the agent."
  type        = string
}

variable "fleet_cidrs" {
  description = "Address blocks allowed to reach the agent's own port. The fleet's own networks, never the internet."
  type        = list(string)
  default     = []
}

variable "artifact_bucket_arn" {
  description = "Games bucket a box pulls bundle sets from."
  type        = string
}

variable "dynamodb_arn_patterns" {
  description = "Tables and indexes a box may reach, as ARN patterns spanning every replica region."
  type        = list(string)
  default     = []
}

variable "build_queue_arn" {
  description = "Build queue a box's `@grove/game-builder` claims work from. Empty grants nothing."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}
