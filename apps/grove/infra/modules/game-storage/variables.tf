variable "environment" {
  description = "Which deployment this bucket belongs to; it namespaces every name here."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique name for the games bucket."
  type        = string
}

variable "cdn_prefixes" {
  description = "Key patterns, relative to a game, that the distribution may read: each is matched as `<bucket>/*/<pattern>*`. Everything else in the bucket is unreachable from the edge."
  type        = list(string)
  default     = ["build/", "assets/"]
}

variable "browser_origins" {
  description = "Origins a browser may presign a PUT or GET against this bucket from."
  type        = list(string)

  validation {
    condition     = length(var.browser_origins) > 0
    error_message = "At least one origin, or no browser can upload an asset."
  }
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
