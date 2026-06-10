# Deploy the CLAP embedding fallback service to Cloud Run.
param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west1",
    [string]$Repo = "mmo-clap",
    [string]$ServiceName = "mmo-clap",
    [string]$ServiceAccount = "sa-clap@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

$image = "$Region-docker.pkg.dev/$Project/$Repo/$ServiceName`:$Tag"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Building CLAP image $image (cold build ≈ 12-15 min, weights bake-in is ~1.5 GB) ===" -ForegroundColor Cyan
gcloud builds submit $scriptDir `
    --tag=$image `
    --project=$Project `
    --region=$Region `
    --machine-type=e2-highcpu-8 `
    --timeout=1800s

if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed." }

Write-Host ""
Write-Host "=== Deploying Cloud Run service $ServiceName ===" -ForegroundColor Cyan
# 2 GB RAM and 1 CPU is enough for the larger_clap_music_and_speech model;
# concurrency=2 since inference is ~2s per request on CPU.
gcloud run deploy $ServiceName `
    --image=$image `
    --region=$Region `
    --project=$Project `
    --service-account=$ServiceAccount `
    --no-allow-unauthenticated `
    --memory=2Gi `
    --cpu=1 `
    --min-instances=0 `
    --max-instances=5 `
    --timeout=300 `
    --concurrency=2 `
    --execution-environment=gen2

if ($LASTEXITCODE -ne 0) { throw "Cloud Run deploy failed." }

$url = gcloud run services describe $ServiceName --region=$Region --project=$Project --format="value(status.url)"
Write-Host ""
Write-Host "Service URL: $url" -ForegroundColor Green
Write-Host ""
Write-Host "Add to app/.env.local + Vercel prod:" -ForegroundColor Yellow
Write-Host "  GCP_CLAP_URL=$url"
