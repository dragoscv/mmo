// ─────────────────────────────────────────────────────────────────────────────
// MMO — Azure Speech (TTS for spoken intros/outros, ASR, real-time translation)
//
// Created out-of-band on 2026-05-20:
//   az cognitiveservices account create --name speech-mmo --kind SpeechServices
//     --sku S0 --custom-domain speech-mmo --assign-identity --yes
//
// SKU S0 = pay-as-you-go, no upfront. Costs:
//   Neural TTS:  $15 / 1M chars
//   Standard STT: $1 / hour
//   Real-time translation: $2.50 / hour
//
// Endpoint: https://speech-mmo.cognitiveservices.azure.com/
// Region:   westeurope
// Identity: SystemAssigned (for future Key Vault secret rotation)
// ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_cognitive_account" "speech" {
  name                  = "speech-mmo"
  resource_group_name   = azurerm_resource_group.mmo.name
  location              = azurerm_resource_group.mmo.location
  kind                  = "SpeechServices"
  sku_name              = "S0"
  custom_subdomain_name = "speech-mmo"
  tags                  = local.azure_tags

  identity {
    type = "SystemAssigned"
  }
}

import {
  to = azurerm_cognitive_account.speech
  id = "/subscriptions/${var.azure_subscription_id}/resourceGroups/${var.azure_resource_group}/providers/Microsoft.CognitiveServices/accounts/speech-mmo"
}
