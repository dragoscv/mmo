output "azure_resource_group_id" {
  value = azurerm_resource_group.mmo.id
}

output "azure_ml_workspace_id" {
  value = azurerm_machine_learning_workspace.mmo.id
}

output "azure_storage_account_id" {
  value = azurerm_storage_account.mmo.id
}

output "azure_key_vault_uri" {
  value = azurerm_key_vault.mmo.vault_uri
}

output "azure_acr_login_server" {
  value = azurerm_container_registry.mmo.login_server
}

output "azure_app_insights_connection_string" {
  value     = azurerm_application_insights.mmo.connection_string
  sensitive = true
}
