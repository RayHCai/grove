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

variable "game_manager_url" {
  description = "Where every game process reads and writes its state."
  type        = string
}

variable "fleet_ami_parameter" {
  description = "SSM parameter holding the fleet image's id, in every fleet region."
  type        = string
}

variable "browser_origins" {
  description = "Origins a signed-in browser presigns against the games bucket from."
  type        = list(string)
}

