# Build the ACE-Step trainer image and push to Artifact Registry.
# Run once when the trainer Dockerfile or train.py changes.
#
#   pwsh infra/vertex/build-trainer.ps1
#
# Cold build is slow (15-20 min: CUDA base + torch + ACE-Step). Use a large
# Cloud Build machine to keep it under 15 min.

param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west1",
    [string]$Repo = "mmo-training",
    [string]$ImageName = "acestep-trainer",
    [string]$Tag = "latest"
)

$ErrorActionPreference = "Stop"

$image = "$Region-docker.pkg.dev/$Project/$Repo/$ImageName`:$Tag"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$contextDir = Join-Path $scriptDir "train-acestep"

Write-Host "=== Building trainer image $image ===" -ForegroundColor Cyan
gcloud builds submit $contextDir `
    --tag=$image `
    --project=$Project `
    --region=$Region `
    --machine-type=e2-highcpu-32 `
    --timeout=2400s

if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed." }

Write-Host ""
Write-Host "Trainer image built: $image" -ForegroundColor Green
Write-Host ""
Write-Host "Set on the Next.js app (app/.env.local + Vercel prod) if you override the default:" -ForegroundColor Yellow
Write-Host "  VERTEX_TRAINER_IMAGE=$image"
