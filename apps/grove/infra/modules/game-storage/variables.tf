variable "environment" {
  description = "Which deployment this bucket belongs to; it namespaces every name here."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique name for the games bucket."
  type        = string
}

variable "cdn_prefixes" {
  description = "Key classes, right after a game id, that the distribution may read: each is matched as `<bucket>/<game-id>/<pattern>*`. Everything else in the bucket is unreachable from the edge."
  type        = list(string)
  default     = ["build/", "assets/"]
}

variable "upload_retention_days" {
  description = "How long an upload waits in quarantine (`uploads/`) before it is expired, inspected or not."
  type        = number
  default     = 1

  validation {
    condition     = var.upload_retention_days >= 1
    error_message = "A day at least, or an upload can expire before its inspection runs."
  }
}

variable "noncurrent_version_retention_days" {
  description = "How long a byte-set a later write replaced stays addressable, which is how far back a manifest resolves."
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_version_retention_days >= 1
    error_message = "A day at least, or a build pinned to a just-replaced version can find it gone."
  }
}

variable "asset_cache_ttl_seconds" {
  description = "How long the edge serves an asset before asking again, since an asset key is overwritten in place."
  type        = number
  default     = 60
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
