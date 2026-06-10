// Variables for the Azure ML stack. Defaults match what was
// provisioned on 2026-05-20. The two _suffix names (storage, kv, acr)
// have random 4-char suffixes because they're globally unique — keep
// in sync with `.azure-names.txt` at repo root.

variable "azure_subscription_id" {
  description = "Azure subscription ID for the MMO ML stack."
  type        = string
  default     = "a2845388-ce62-4b42-a6ea-e32e7441e635"
}

variable "azure_resource_group" {
  description = "Resource group name."
  type        = string
  default     = "rg-mmo"
}

variable "azure_location" {
  description = "Azure region. westeurope = Amsterdam (closest to RO)."
  type        = string
  default     = "westeurope"
}

variable "azure_storage_account" {
  description = "Globally-unique storage account name."
  type        = string
  default     = "stmmofnes"
}

variable "azure_keyvault_name" {
  description = "Globally-unique key vault name."
  type        = string
  default     = "kv-mmo-fnes"
}

variable "azure_acr_name" {
  description = "Globally-unique container registry name."
  type        = string
  default     = "crmmofnes"
}
