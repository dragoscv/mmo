# Master deploy script: builds + deploys all Cloud Run services (ACE-Step,
# Demucs, Piper, RVC, voice-TTS), captures URLs, and writes them into
# app/.env.local. Optionally pushes to Vercel production.
#
# Usage:
#   pwsh infra/cloud-run/deploy-all.ps1                   # build + deploy + env.local
#   pwsh infra/cloud-run/deploy-all.ps1 -VercelPush       # also push to Vercel prod
#   pwsh infra/cloud-run/deploy-all.ps1 -SkipBuild        # redeploy without rebuild
#   pwsh infra/cloud-run/deploy-all.ps1 -Only ace-step,demucs
[CmdletBinding()]
param(
    [string[]]$Only = @("ace-step", "demucs", "piper", "rvc", "voice-tts"),
    [switch]$VercelPush,
    [switch]$SkipBuild,
    [string]$Project = "mmo-mw-prod"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $root "../..")
$envFile = Join-Path $repoRoot "app/.env.local"

$plan = @{
    "ace-step"  = @{ url = $null; envVar = "GCP_ACESTEP_URL"   }
    "demucs"    = @{ url = $null; envVar = "GCP_DEMUCS_URL"    }
    "piper"     = @{ url = $null; envVar = "GCP_PIPER_URL"     }
    "rvc"       = @{ url = $null; envVar = "GCP_RVC_URL"       }
    "voice-tts" = @{ url = $null; envVar = "GCP_VOICE_TTS_URL" }
}

foreach ($svc in $Only) {
    $svcDir = Join-Path $root $svc
    if (-not (Test-Path $svcDir)) {
        Write-Warning "[$svc] directory not found at $svcDir — skipping."
        continue
    }
    $deploy = Join-Path $svcDir "deploy.ps1"
    if (-not (Test-Path $deploy)) {
        Write-Warning "[$svc] deploy.ps1 not found — skipping."
        continue
    }
    Write-Host "=== Deploying $svc ===" -ForegroundColor Magenta
    & pwsh -NoProfile -File $deploy -Project $Project
    if ($LASTEXITCODE -ne 0) { throw "[$svc] deploy failed (exit $LASTEXITCODE)" }
}

# Capture URLs from gcloud (single source of truth).
foreach ($svc in $plan.Keys) {
    if ($Only -notcontains $svc) { continue }
    $sname = "mmo-$svc"
    $region = if ($svc -eq "piper") { "europe-west1" } else { "europe-west4" }
    $url = & gcloud run services describe $sname --project=$Project --region=$region --format="value(status.url)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $url) {
        $plan[$svc].url = $url.Trim()
    }
}

# Merge into app/.env.local (preserving existing lines).
$existing = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') {
            $existing[$Matches[1]] = $Matches[2]
        }
    }
}
foreach ($svc in $plan.Keys) {
    $u = $plan[$svc].url
    if ($u) { $existing[$plan[$svc].envVar] = $u }
}
# Ensure GCP_PROJECT_ID + GCS_BUCKET_GENERATED defaults are present.
if (-not $existing.ContainsKey("GCP_PROJECT_ID")) { $existing["GCP_PROJECT_ID"] = $Project }
if (-not $existing.ContainsKey("GCS_BUCKET_GENERATED")) { $existing["GCS_BUCKET_GENERATED"] = "mmo-generated-prod" }

$lines = $existing.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
$lines | Set-Content -Path $envFile -Encoding UTF8
Write-Host ""
Write-Host "Wrote env to $envFile" -ForegroundColor Green
$plan.GetEnumerator() | ForEach-Object {
    if ($_.Value.url) { Write-Host ("  {0,-20} = {1}" -f $_.Value.envVar, $_.Value.url) }
}

if ($VercelPush) {
    Write-Host ""
    Write-Host "Pushing to Vercel production ..." -ForegroundColor Cyan
    Push-Location (Join-Path $repoRoot "app")
    try {
        foreach ($svc in $plan.Keys) {
            $u = $plan[$svc].url
            if (-not $u) { continue }
            $k = $plan[$svc].envVar
            # Remove existing (ignore error if not present), then add fresh.
            & vercel env rm $k production --yes 2>$null | Out-Null
            $u | & vercel env add $k production
            if ($LASTEXITCODE -ne 0) { Write-Warning "[$k] vercel env add failed" }
        }
        # Static defaults.
        foreach ($pair in @(@("GCP_PROJECT_ID", $Project), @("GCS_BUCKET_GENERATED", "mmo-generated-prod"))) {
            $k = $pair[0]; $v = $pair[1]
            & vercel env rm $k production --yes 2>$null | Out-Null
            $v | & vercel env add $k production
        }
        Write-Host "Vercel prod env updated." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}
