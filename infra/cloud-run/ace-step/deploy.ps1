# Deploy the MMO ACE-Step song-generation service to Cloud Run on GPU.
#
# Cloud Run GPU (L4, europe-west4) became GA in 2024. Min-instances=0 so
# we only pay when in use; concurrency=1 since each request owns the GPU.
# First call after a cold start downloads ~6 GB of weights (~90 s); warm
# calls are instant.
#
# Usage:
#   pwsh infra/cloud-run/ace-step/deploy.ps1
#   pwsh infra/cloud-run/ace-step/deploy.ps1 -Tag v2
#
# Prereqs (one-time):
#   - gcloud beta enabled  (Cloud Run GPU flags live under `gcloud beta run`)
#   - L4 quota in $Region (Console → IAM → Quotas, "Nvidia L4 GPU per region")
#   - SA `sa-ace-step` created (see Terraform) with:
#       roles/storage.objectAdmin on mmo-generated-prod
#       roles/artifactregistry.reader on mmo-training (image pull)

param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west4",          # L4 lives in west4, not west1
    [string]$Repo = "mmo-training",
    [string]$ServiceName = "mmo-ace-step",
    [string]$ServiceAccount = "sa-ace-step@mmo-mw-prod.iam.gserviceaccount.com",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

# Cloud Build runs in europe-west1 (Artifact Registry repo lives there).
$image = "europe-west1-docker.pkg.dev/$Project/$Repo/$ServiceName`:$Tag"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Building image $image ===" -ForegroundColor Cyan
gcloud builds submit $scriptDir `
    --tag=$image `
    --project=$Project `
    --region=europe-west1 `
    --machine-type=e2-highcpu-32 `
    --timeout=2400s

if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed." }

Write-Host ""
Write-Host "=== Deploying Cloud Run GPU service $ServiceName to $Region ===" -ForegroundColor Cyan
# Cloud Run GPU options (as of May 2026):
#   --gpu=1 --gpu-type=nvidia-l4    L4 24GB, ~$0.71/hr
#   --no-cpu-throttling             required by --gpu (CPU stays warm during requests)
#   --memory >= 16Gi recommended    (model loading peaks; safe at 32Gi)
#   --concurrency=1                 each request owns the GPU
#   --max-instances=2               cap to prevent runaway cost
gcloud beta run deploy $ServiceName `
    --image=$image `
    --region=$Region `
    --project=$Project `
    --service-account=$ServiceAccount `
    --no-allow-unauthenticated `
    --gpu=1 `
    --gpu-type=nvidia-l4 `
    --no-cpu-throttling `
    --memory=32Gi `
    --cpu=8 `
    --min-instances=0 `
    --max-instances=2 `
    --timeout=900 `
    --concurrency=1 `
    --execution-environment=gen2

if ($LASTEXITCODE -ne 0) { throw "Cloud Run deploy failed." }

$url = gcloud run services describe $ServiceName --region=$Region --project=$Project --format="value(status.url)"
Write-Host ""
Write-Host "Service URL: $url" -ForegroundColor Green
Write-Host ""
Write-Host "Add to app/.env.local + Vercel prod:" -ForegroundColor Yellow
Write-Host "  GCP_ACESTEP_URL=$url"
Write-Host ""
Write-Host "Smoke test:" -ForegroundColor Yellow
Write-Host "  `$tok = gcloud auth print-identity-token --audiences=$url"
Write-Host "  curl -H `"Authorization: Bearer `$tok`" $url/health"
