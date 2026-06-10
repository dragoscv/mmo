# Deploy RVC scaffold to Cloud Run GPU (L4). See server.py for status:
# the endpoint is live but returns 501 until per-user voice-model GCS
# storage is wired.
[CmdletBinding()]
param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west4",
    [string]$BuildRegion = "europe-west1",
    [string]$Repo = "mmo-training",
    [string]$ServiceName = "mmo-rvc",
    [string]$ServiceAccount = "sa-rvc@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Memory = "16Gi",
    [string]$Cpu = "4",
    [int]$Concurrency = 1,
    [int]$Timeout = 900,
    [int]$MaxInstances = 2
)
$ErrorActionPreference = "Stop"
$image = "$BuildRegion-docker.pkg.dev/$Project/$Repo/$ServiceName" + ":latest"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    Write-Host "[rvc] Building $image ..." -ForegroundColor Cyan
    gcloud builds submit --project=$Project --region=$BuildRegion `
        --machine-type=e2-highcpu-32 --timeout=2400s --tag=$image .
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "[rvc] Deploying $ServiceName to $Region ..." -ForegroundColor Cyan
    gcloud beta run deploy $ServiceName --project=$Project --region=$Region `
        --image=$image `
        --service-account=$ServiceAccount `
        --gpu=1 --gpu-type=nvidia-l4 --no-cpu-throttling `
        --memory=$Memory --cpu=$Cpu `
        --min-instances=0 --max-instances=$MaxInstances `
        --timeout=$Timeout --concurrency=$Concurrency `
        --execution-environment=gen2 `
        --no-allow-unauthenticated
    if ($LASTEXITCODE -ne 0) { throw "deploy failed" }

    $url = gcloud run services describe $ServiceName --project=$Project --region=$Region --format="value(status.url)"
    Write-Host ""
    Write-Host "GCP_RVC_URL=$url" -ForegroundColor Green
} finally {
    Pop-Location
}
