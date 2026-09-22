variable "project" {
  type    = string
  default = "ledgercore"
}

variable "env" {
  type        = string
  description = "prod | staging"
}

variable "region" {
  type        = string
  description = "Single region. The bank is one country; multi-region would add cross-region replication lag to a LEDGER, which is the last place you want eventual consistency."
  default     = "ap-south-1"
}

variable "azs" {
  type        = list(string)
  description = "Three AZs. Two survives one AZ loss; three means losing one still leaves a quorum and the remaining capacity is 67% rather than 50%."
  default     = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}

variable "domain_name" {
  type = string
}

variable "api_desired_count" {
  type        = number
  description = "Matches the three nodes proven in Phase 8."
  default     = 3
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type        = string
  description = "Phase 15 sizes this properly. Phase 8 measured Postgres at 21-58% CPU while the API saturated, so the database is not the first thing to scale."
  default     = "db.t4g.medium"
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}
