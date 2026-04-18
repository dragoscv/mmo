variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "mmo-mw-prod"
}

variable "region" {
  description = "GCP region for the static IP and firewall scope"
  type        = string
  default     = "europe-west1"
}

variable "zone" {
  description = "GCP zone for the VM"
  type        = string
  default     = "europe-west1-b"
}

variable "name" {
  description = "Resource name prefix for the TURN server"
  type        = string
  default     = "mmo-turn"
}

variable "machine_type" {
  description = "GCE machine type. e2-micro is cheapest (~$6/mo); e2-small for headroom."
  type        = string
  default     = "e2-micro"
}

variable "realm" {
  description = "TURN realm — should match your application's primary host"
  type        = string
  default     = "mmo.local"
}
