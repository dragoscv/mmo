# Deploy Piper TTS to Cloud Run CPU (no GPU).
[CmdletBinding()]
param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west1",
    [string]$Repo = "mmo-training",
    [string]$ServiceName = "mmo-piper",
    [string]$ServiceAccount = "sa-piper@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Memory = "2Gi",
    [string]$Cpu = "2",
    [int]$Concurrency = 4,
    [int]$Timeout = 120,
    [int]$MaxInstances = 5
)
$ErrorActionPreference = "Stop"
$image = "$Region-docker.pkg.dev/$Project/$Repo/$ServiceName" + ":latest"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    Write-Host "[piper] Building $image ..." -ForegroundColor Cyan
    gcloud builds submit --project=$Project --region=$Region `
        --machine-type=e2-highcpu-8 --timeout=1200s `
        --tag=$image .
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "[piper] Deploying $ServiceName to $Region ..." -ForegroundColor Cyan
    gcloud run deploy $ServiceName --project=$Project --region=$Region `
        --image=$image `
        --service-account=$ServiceAccount `
        --memory=$Memory --cpu=$Cpu `
        --min-instances=0 --max-instances=$MaxInstances `
        --timeout=$Timeout --concurrency=$Concurrency `
        --no-allow-unauthenticated
    if ($LASTEXITCODE -ne 0) { throw "deploy failed" }

    $url = gcloud run services describe $ServiceName --project=$Project --region=$Region --format="value(status.url)"
    Write-Host ""
    Write-Host "GCP_PIPER_URL=$url" -ForegroundColor Green
} finally {
    Pop-Location
}
