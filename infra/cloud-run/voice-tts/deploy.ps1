# Deploy voice-cloning TTS scaffold to Cloud Run GPU (L4).
# See server.py: endpoint is 501 until voice-storage layer ships.
[CmdletBinding()]
param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west4",
    [string]$BuildRegion = "europe-west1",
    [string]$Repo = "mmo-training",
    [string]$ServiceName = "mmo-voice-tts",
    [string]$ServiceAccount = "sa-voice-tts@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Memory = "24Gi",
    [string]$Cpu = "8",
    [int]$Concurrency = 1,
    [int]$Timeout = 600,
    [int]$MaxInstances = 2
)
$ErrorActionPreference = "Stop"
$image = "$BuildRegion-docker.pkg.dev/$Project/$Repo/$ServiceName" + ":latest"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    Write-Host "[voice-tts] Building $image ..." -ForegroundColor Cyan
    gcloud builds submit --project=$Project --region=$BuildRegion `
        --machine-type=e2-highcpu-32 --timeout=2400s --tag=$image .
    if ($LASTEXITCODE -ne 0) { throw "build failed" }

    Write-Host "[voice-tts] Deploying $ServiceName to $Region ..." -ForegroundColor Cyan
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
    Write-Host "GCP_VOICE_TTS_URL=$url" -ForegroundColor Green
} finally {
    Pop-Location
}
