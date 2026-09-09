variable "primary_region" {
  description = "Region holding the bucket, the tables and the distribution."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Globally unique name for the games bucket."
  type        = string
}

variable "fleet" {
  description = "The three fleet slots, keyed a/b/c. A slot's region must match the provider alias of the same letter, which `fleet-region` asserts."
  type = map(object({
    region                = string
    vpc_cidr              = string
    instance_type         = string
    instance_count        = optional(number, 1)
    max_instances_per_box = optional(number, 8)
    root_volume_gb        = optional(number, 30)
  }))
}

variable "server_manager_url" {
  description = "Where every box's heartbeat goes."
  type        = string
}

variable "control_plane_cidrs" {
  description = "Address blocks outside the fleet networks that may reach a box's agent."
  type        = list(string)
  default     = []
}

variable "build_alarm_actions" {
  description = "SNS topics notified when a build dead-letters."
  type        = list(string)
  default     = []
}
