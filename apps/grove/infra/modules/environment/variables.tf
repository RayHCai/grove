variable "environment" {
  description = "The deployment this whole stack is. Every name in it is namespaced by this."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment is staging or production."
  }
}

variable "bucket_name" {
  description = "Globally unique name for the games bucket."
  type        = string
}

variable "fleet" {
  description = "The three fleet slots, keyed a/b/c, each matching the provider alias of the same letter."
  type = map(object({
    region                = string
    vpc_cidr              = string
    instance_type         = string
    instance_count        = optional(number, 1)
    max_instances_per_box = optional(number, 8)
    root_volume_gb        = optional(number, 30)
  }))

  validation {
    condition     = alltrue([for slot in ["a", "b", "c"] : contains(keys(var.fleet), slot)])
    error_message = "fleet needs one entry per provider alias: a, b and c."
  }

  validation {
    condition     = length(distinct([for slot in var.fleet : slot.vpc_cidr])) == length(var.fleet)
    error_message = "Each fleet slot needs its own address block, or two of them can never be routed to each other."
  }

  validation {
    condition     = length(distinct([for slot in var.fleet : slot.region])) == length(var.fleet)
    error_message = "Two slots in one region is one region's failure taking two thirds of the fleet."
  }
}

variable "server_manager_url" {
  description = "Where every box's heartbeat goes. One of it, for the whole fleet."
  type        = string
}

variable "dynamodb_replica_regions" {
  description = "Regions the tables are replicated into. A box reading its own region's replica is the difference between a tick's store call and a cross-continent one."
  type        = list(string)
  default     = []
}

variable "point_in_time_recovery" {
  description = "Whether every table keeps a 35-day restore window."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Whether the tables refuse to be deleted, and the bucket refuses to be emptied."
  type        = bool
  default     = false
}

variable "cdn_price_class" {
  description = "Which edge locations the games distribution uses."
  type        = string
  default     = "PriceClass_100"
}

variable "cdn_access_logs_enabled" {
  description = "Whether the distribution writes standard access logs."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged onto every resource in this deployment."
  type        = map(string)
  default     = {}
}

variable "build_alarm_actions" {
  description = "SNS topics notified when a build dead-letters."
  type        = list(string)
  default     = []
}
