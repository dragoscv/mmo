// ─────────────────────────────────────────────────────────────────────────────
// MMO — Azure OpenAI resource (gpt-4o-mini deployment)
//
// Created 2026-05-20: kind=OpenAI, sku S0, custom_subdomain=mmo-openai-fnes
// (subdomain "openai-mmo" was globally taken). The gpt-4o-mini deployment
// requires GlobalStandard SKU + TPM quota; tracked separately.
// ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_cognitive_account" "openai" {
  name                          = "mmo-openai-fnes"
  location                      = "westeurope"
  resource_group_name           = azurerm_resource_group.mmo.name
  kind                          = "OpenAI"
  sku_name                      = "S0"
  custom_subdomain_name         = "mmo-openai-fnes"
  public_network_access_enabled = true

  identity {
    type = "SystemAssigned"
  }

  tags = {
    app  = "mmo"
    env  = "prod"
    role = "llm"
  }
}

import {
  to = azurerm_cognitive_account.openai
  id = "/subscriptions/a2845388-ce62-4b42-a6ea-e32e7441e635/resourceGroups/rg-mmo/providers/Microsoft.CognitiveServices/accounts/mmo-openai-fnes"
}
