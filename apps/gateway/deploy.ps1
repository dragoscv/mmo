# Deploy the MuzicAI gateway to Cloud Run.
#
# Usage:
#   pwsh apps/gateway/deploy.ps1                 # build + deploy
#   pwsh apps/gateway/deploy.ps1 -SkipBuild      # redeploy current image
#
# Secrets (DATABASE_URL, AUTH_SECRET, CLOUDFLARE_*) are read from
# apps/web/.env.local and set as Cloud Run env vars on each deploy. For a
# hardened setup, move these to Secret Manager and use --set-secrets.
[CmdletBinding()]
param(
    [string]$Project = "mmo-mw-prod",
    [string]$Region = "europe-west4",
    [string]$Service = "muzicai-gateway",
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $root "../..")
$image = "europe-west4-docker.pkg.dev/${Project}/mmo/${Service}:latest"

if (-not $SkipBuild) {
    Write-Host "=== Building bundle locally (tsup) ===" -ForegroundColor Magenta
    Push-Location $root
    & pnpm build
    $bc = $LASTEXITCODE
    Pop-Location
    if ($bc -ne 0) { throw "Local tsup build failed" }
    Write-Host "=== Building $image via Cloud Build ===" -ForegroundColor Magenta
    & gcloud builds submit $root --tag $image --project $Project
    if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed" }
}

# Read required env from apps/web/.env.local.
$envFile = Join-Path $repoRoot "apps/web/.env.local"
if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
$envMap = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#') { return }
    $i = $_.IndexOf('=')
    if ($i -lt 1) { return }
    $envMap[$_.Substring(0, $i).Trim()] = $_.Substring($i + 1).Trim()
}
$keys = @("DATABASE_URL", "AUTH_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_TUNNEL_ZONE_ID", "CLOUDFLARE_TUNNEL_BASE_HOSTNAME")
$pairs = @()
foreach ($k in $keys) {
    if ($envMap.ContainsKey($k) -and $envMap[$k]) { $pairs += "$k=$($envMap[$k])" }
}
$pairs += "CORS_ALLOW_ORIGINS=https://muzicai.ro"
# Web facet-cache revalidation hook (Phase 2 sync). Optional.
if ($envMap.ContainsKey("WEB_REVALIDATE_SECRET") -and $envMap["WEB_REVALIDATE_SECRET"]) {
    $pairs += "WEB_REVALIDATE_SECRET=$($envMap['WEB_REVALIDATE_SECRET'])"
    $pairs += "WEB_REVALIDATE_URL=https://muzicai.ro/api/internal/revalidate"
}
$envArg = ($pairs -join "`n")

# Write env vars to a temp YAML to avoid comma-splitting issues with values
# that contain commas (e.g. connection strings).
$tmp = New-TemporaryFile
$yaml = ($pairs | ForEach-Object {
    $i = $_.IndexOf('='); $k = $_.Substring(0, $i); $v = $_.Substring($i + 1)
    "${k}: " + ('"' + ($v -replace '"', '\"') + '"')
}) -join "`n"
Set-Content -Path $tmp -Value $yaml -Encoding utf8

Write-Host "=== Deploying $Service ===" -ForegroundColor Magenta
& gcloud run deploy $Service `
    --image $image `
    --project $Project `
    --region $Region `
    --platform managed `
    --allow-unauthenticated `
    --port 8080 `
    --cpu 1 `
    --memory 512Mi `
    --min-instances 1 `
    --max-instances 4 `
    --session-affinity `
    --timeout 3600 `
    --env-vars-file $tmp
$code = $LASTEXITCODE
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "Cloud Run deploy failed" }

$url = & gcloud run services describe $Service --project $Project --region $Region --format="value(status.url)"
Write-Host "Gateway URL: $url" -ForegroundColor Green
