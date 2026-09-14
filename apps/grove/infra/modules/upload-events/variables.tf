variable "environment" {
  description = "Which deployment this listener belongs to; it namespaces every name here."
  type        = string
}

variable "bucket_name" {
  description = "Games bucket whose object events this rule matches."
  type        = string
}

variable "source_prefix" {
  description = "Key prefix an upload must land under to queue a build."
  type        = string
  default     = "sources/"
}

variable "visibility_timeout_seconds" {
  description = "How long a claimed build stays invisible to other builders. A compile is minutes, so this is not the default thirty seconds."
  type        = number
  default     = 900
}

variable "message_retention_seconds" {
  description = "How long an unclaimed build stays in the queue."
  type        = number
  default     = 345600
}

variable "max_receive_count" {
  description = "Deliveries a build gets before it is moved to the dead-letter queue."
  type        = number
  default     = 3
}

variable "alarm_actions" {
  description = "SNS topics notified when a build reaches the dead-letter queue. Empty raises the alarm without paging anyone."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}
