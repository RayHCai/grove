variable "environment" {
  description = "Which deployment this bucket belongs to; it namespaces every name here."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique name for the games bucket."
  type        = string
}

variable "cdn_prefixes" {
  description = "Key prefixes the distribution may read. Everything else in the bucket is unreachable from the edge."
  type        = list(string)
  default     = ["bundles/", "assets/"]
}

variable "noncurrent_version_expiration_days" {
  description = "How long a superseded object version is kept before it is deleted."
  type        = number
  default     = 30
}

variable "price_class" {
  description = "Which edge locations the distribution uses."
  type        = string
  default     = "PriceClass_100"
}

variable "access_logs_enabled" {
  description = "Whether the distribution writes standard access logs to a bucket of its own."
  type        = bool
  default     = false
}

variable "access_log_retention_days" {
  description = "How long an access log object is kept."
  type        = number
  default     = 90
}

variable "force_destroy" {
  description = "Whether `terraform destroy` may delete a bucket that still holds objects."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged onto every resource this module creates."
  type        = map(string)
  default     = {}
}
