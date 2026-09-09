variable "environment" {
  description = "Which deployment these tables belong to; it namespaces every table name."
  type        = string
}

variable "replica_regions" {
  description = "Regions each table is replicated into. A fleet box reads its own region's replica; empty keeps one copy in the primary region."
  type        = list(string)
  default     = []
}

variable "point_in_time_recovery" {
  description = "Whether every table keeps a 35-day restore window."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Whether a table refuses to be deleted until this is turned off."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags merged onto every table this module creates."
  type        = map(string)
  default     = {}
}
