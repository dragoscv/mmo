<#
.SYNOPSIS
  Build the MMO Server image for linux/amd64 and push it to Artifact Registry for the demo VM.
  Run ONLY through deploy-clean.ps1 (clean detached worktree at a pushed commit):
    pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1" -Target demo-image -Command 'pwsh -NoProfile -File infra/demo/image.ps1'
  Prints `IMAGE=<ref>` (tag = <server version>-<short sha>).
#>
param([string]$Registry = 'europe-west1-docker.pkg.dev/mmo-mw-prod/mixai/mmo-server')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content (Join-Path $repo 'server\package.json') -Raw | ConvertFrom-Json).version
$sha = if ($env:DEPLOY_SHA) { $env:DEPLOY_SHA.Substring(0, 8) } else { (git -C $repo rev-parse --short=8 HEAD).Trim() }
if (-not $env:DEPLOY_SHA -and (git -C $repo status --porcelain -- server)) { throw 'server/ is dirty: build through deploy-clean.ps1' }
$tag = "${Registry}:$version-$sha"
& gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet 2>$null | Out-Null
& pwsh -NoProfile -File (Join-Path $repo 'scripts\build-mmo-server-image.ps1') -Platforms linux/amd64 -Tag $tag -Push
if ($LASTEXITCODE -ne 0) { throw "image build failed ($LASTEXITCODE)" }
& gcloud artifacts docker images describe $tag --format='value(image_summary.digest)'
if ($LASTEXITCODE -ne 0) { throw 'pushed image not found in Artifact Registry' }
Write-Host "IMAGE=$tag"
