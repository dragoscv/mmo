// ─────────────────────────────────────────────────────────────────────────────
// MMO — Azure ML training stack
//
// Tracks the resources provisioned out-of-band on 2026-05-20 to host
// ACE-Step LoRA training and other Azure-ML workloads. Originally
// created via:
//   az group create ...
//   az storage account create ...
//   az keyvault create ...
//   az monitor log-analytics workspace create ...
//   az rest --method PUT ...   (App Insights — extension was broken)
//   az acr create ...
//   az deployment group create ... (workspace.arm.json)
//   az ad sp create-for-rbac --role Contributor
//
// The `import {}` blocks below adopt these resources into Terraform
// state without recreating them. After the first `terraform apply`
// the imports become no-ops and the resources are managed from here.
//
// Subscription: a2845388-ce62-4b42-a6ea-e32e7441e635 (MuzicAI)
// Region:       westeurope (closest EU region to RO with broadest SKU
//               availability; A100 quota request pending — file via
//               portal, see README).
//
//   Idle cost: ~$3-8/mo (Storage LRS, KV standard, LAW pay-as-you-go,
//              App Insights ingestion only, ACR Basic $5/mo). The ML
//              workspace itself is free; compute is metered by usage.
// ─────────────────────────────────────────────────────────────────────────────

provider "azurerm" {
  subscription_id = var.azure_subscription_id
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}
locals {
  azure_tags = {
    app = "mmo"
    env = "prod"
  }
}

// ── Resource group ──────────────────────────────────────────────────────────

resource "azurerm_resource_group" "mmo" {
  name     = var.azure_resource_group
  location = var.azure_location
  tags     = local.azure_tags
}

import {
  to = azurerm_resource_group.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}"
}

// ── Storage (datasets, model artifacts, default Azure ML datastore) ────────

resource "azurerm_storage_account" "mmo" {
  name                            = var.azure_storage_account
  resource_group_name             = azurerm_resource_group.mmo.name
  location                        = azurerm_resource_group.mmo.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  account_kind                    = "StorageV2"
  access_tier                     = "Hot"
  allow_nested_items_to_be_public = false
  min_tls_version                 = "TLS1_2"
  tags                            = local.azure_tags
}

import {
  to = azurerm_storage_account.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.Storage/storageAccounts/${var.azure_storage_account}"
}

// ── Key Vault (Azure ML stores workspace secrets here; RBAC mode) ──────────

data "azurerm_client_config" "current" {}

resource "azurerm_key_vault" "mmo" {
  name                       = var.azure_keyvault_name
  resource_group_name        = azurerm_resource_group.mmo.name
  location                   = azurerm_resource_group.mmo.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  soft_delete_retention_days = 7
  purge_protection_enabled   = false
  tags                       = local.azure_tags
}

import {
  to = azurerm_key_vault.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.KeyVault/vaults/${var.azure_keyvault_name}"
}

// ── Log Analytics + Application Insights ───────────────────────────────────

resource "azurerm_log_analytics_workspace" "mmo" {
  name                = "law-mmo"
  resource_group_name = azurerm_resource_group.mmo.name
  location            = azurerm_resource_group.mmo.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.azure_tags
}

import {
  to = azurerm_log_analytics_workspace.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.OperationalInsights/workspaces/law-mmo"
}

resource "azurerm_application_insights" "mmo" {
  name                = "appi-mmo"
  resource_group_name = azurerm_resource_group.mmo.name
  location            = azurerm_resource_group.mmo.location
  workspace_id        = azurerm_log_analytics_workspace.mmo.id
  application_type    = "web"
  tags                = local.azure_tags
}

import {
  to = azurerm_application_insights.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/microsoft.insights/components/appi-mmo"
}

// ── Container Registry (Azure ML builds curated env images here) ───────────

resource "azurerm_container_registry" "mmo" {
  name                = var.azure_acr_name
  resource_group_name = azurerm_resource_group.mmo.name
  location            = azurerm_resource_group.mmo.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.azure_tags
}

import {
  to = azurerm_container_registry.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.ContainerRegistry/registries/${var.azure_acr_name}"
}

// ── Azure ML workspace ──────────────────────────────────────────────────────

resource "azurerm_machine_learning_workspace" "mmo" {
  name                          = "mlw-mmo"
  resource_group_name           = azurerm_resource_group.mmo.name
  location                      = azurerm_resource_group.mmo.location
  application_insights_id       = azurerm_application_insights.mmo.id
  key_vault_id                  = azurerm_key_vault.mmo.id
  storage_account_id            = azurerm_storage_account.mmo.id
  container_registry_id         = azurerm_container_registry.mmo.id
  public_network_access_enabled = true
  sku_name                      = "Basic"

  identity {
    type = "SystemAssigned"
  }

  tags = local.azure_tags
}

import {
  to = azurerm_machine_learning_workspace.mmo
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.MachineLearningServices/workspaces/mlw-mmo"
}

// ── GPU compute cluster (blocked on A100 quota request) ────────────────────
//
// Once Microsoft approves the quota request, uncomment the block below
// and run `terraform apply`. Verified spec matches what
// `infra/azureml/compute-a100.yml` would produce via `az ml`.
//
// resource "azurerm_machine_learning_compute_cluster" "gpu_a100" {
//   name                          = "gpu-a100"
//   machine_learning_workspace_id = azurerm_machine_learning_workspace.mmo.id
//   location                      = azurerm_resource_group.mmo.location
//   vm_priority                   = "Dedicated"
//   vm_size                       = "Standard_NC24ads_A100_v4"
//   scale_settings {
//     min_node_count                       = 0
//     max_node_count                       = 1
//     scale_down_nodes_after_idle_duration = "PT30M"
//   }
//   identity {
//     type = "SystemAssigned"
//   }
//   tags = local.azure_tags
// }

// ── Service principal for non-interactive ML job submission ────────────────
//
// Created out-of-band via `az ad sp create-for-rbac` because the
// azuread provider needs a separate auth chain. Tracked here for
// documentation only. To rotate the secret manually:
//   az ad sp credential reset --id <appId>
// Then update AZURE_CLIENT_SECRET in .env.local AND on Vercel
// production (use `vercel env rm AZURE_CLIENT_SECRET production --yes`
// then `echo <new-secret> | vercel env add AZURE_CLIENT_SECRET production`).
//
// Role assignments held by sp-mmo-azureml (appId 602a3708-…):
//   - Contributor                    on rg-mmo
//   - Storage Blob Data Contributor  on the storage account
