# Deploy the MMO mastering service to Cloud Run.
#
# Builds the Docker image via Cloud Build (no local Docker required), pushes
# to Artifact Registry, deploys to Cloud Run with scale-to-zero + the
# dedicated sa-mastering service account. Idempotent: re-running just
# pushes a new revision.
#
# Usage:  pwsh infra/cloud-run/mastering/deploy.ps1
#         pwsh infra/cloud-run/mastering/deploy.ps1 -Tag v2

param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west1",
    [string]$Repo = "mmo-mastering",
    [string]$ServiceName = "mmo-mastering",
    [string]$ServiceAccount = "sa-mastering@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

$image = "$Region-docker.pkg.dev/$Project/$Repo/$ServiceName`:$Tag"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Building image $image ===" -ForegroundColor Cyan
gcloud builds submit $scriptDir `
    --tag=$image `
    --project=$Project `
    --region=$Region

if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed." }

Write-Host ""
Write-Host "=== Deploying Cloud Run service $ServiceName ===" -ForegroundColor Cyan
gcloud run deploy $ServiceName `
    --image=$image `
    --region=$Region `
    --project=$Project `
    --service-account=$ServiceAccount `
    --no-allow-unauthenticated `
    --memory=1Gi `
    --cpu=1 `
    --min-instances=0 `
    --max-instances=3 `
    --timeout=480 `
    --concurrency=1 `
    --execution-environment=gen2

if ($LASTEXITCODE -ne 0) { throw "Cloud Run deploy failed." }

$url = gcloud run services describe $ServiceName --region=$Region --project=$Project --format="value(status.url)"
Write-Host ""
Write-Host "Service URL: $url" -ForegroundColor Green
Write-Host ""
Write-Host "Add to app/.env.local + Vercel prod:" -ForegroundColor Yellow
Write-Host "  GCP_MASTERING_URL=$url"
