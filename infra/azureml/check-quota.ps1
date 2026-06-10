# Polls all 3 Azure GPU quota requests filed on 2026-05-20.
# Run: pwsh -NoProfile -File infra/azureml/check-quota.ps1
$ErrorActionPreference = "Stop"
$SUB = "a2845388-ce62-4b42-a6ea-e32e7441e635"
$LOC = "westeurope"

$requests = @(
    @{ Name = "A100 (NC24ads_A100_v4)"; QuotaName = "StandardNCADSA100v4Family";  ReqId = "97e92915-84a9-41fe-868b-ac9e6bfa4a25"; Target = 24 },
    @{ Name = "T4 fallback";            QuotaName = "Standard NCASv3_T4 Family";  ReqId = "92efbc80-3292-4f76-baee-8e95972d2d93"; Target = 8  },
    @{ Name = "Total Regional vCPUs";   QuotaName = "cores";                      ReqId = "6dedbf91-4cf6-40f3-870b-026488a91d58"; Target = 32 }
)

foreach ($r in $requests) {
    $qEnc  = [System.Uri]::EscapeDataString($r.QuotaName)
    Write-Host ("=== {0} (target: {1} vCPU) ===" -f $r.Name, $r.Target) -ForegroundColor Cyan
    # Request status
    $req = az rest --method GET --uri "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.Compute/locations/$LOC/providers/Microsoft.Quota/quotaRequests/$($r.ReqId)?api-version=2023-02-01" 2>$null | ConvertFrom-Json
    if ($req) {
        Write-Host ("  status: {0}" -f $req.properties.provisioningState) -ForegroundColor Yellow
        if ($req.properties.message) { Write-Host ("  message: {0}" -f $req.properties.message) }
    }
    # Current quota
    $now = az rest --method GET --uri "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.Compute/locations/$LOC/providers/Microsoft.Quota/quotas/$qEnc`?api-version=2023-02-01" 2>$null | ConvertFrom-Json
    if ($now) { Write-Host ("  current limit: {0}" -f $now.properties.limit.value) -ForegroundColor Green }
    Write-Host ""
}
