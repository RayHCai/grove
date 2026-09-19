variable "environment" {
  description = "Which deployment this cache belongs to; it namespaces every name here."
  type        = string
}

variable "vpc_cidr" {
  description = "Address block for the network the cache sits in. It must not overlap a fleet region's."
  type        = string
  default     = "10.90.0.0/16"
}

variable "subnet_count" {
  description = "How many availability zones the cache is spread over. Two is the floor ElastiCache takes."
  type        = number
  default     = 2
}

variable "client_cidrs" {
  description = "Blocks the three services that touch the streams are deployed into. Empty leaves the cache reachable from nothing, which is what an unwired deployment should be."
  type        = list(string)
  default     = []
}

variable "max_storage_gb" {
  description = "Ceiling on what the streams may hold. A trimmed stream of task ids is kilobytes; this bounds a producer that stopped trimming."
  type        = number
  default     = 1
}

variable "max_ecpu_per_second" {
  description = "Ceiling on the compute the cache may draw."
  type        = number
  default     = 5000
}

variable "latency_alarm_threshold_us" {
  description = "Microseconds a read may take before the cache is treated as unreachable."
  type        = number
  default     = 50000
}

variable "alarm_actions" {
  description = "SNS topics notified when the streams stop answering. Empty raises the alarm without paging anyone."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}
