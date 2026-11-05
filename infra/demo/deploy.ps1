<#
.SYNOPSIS
  Ship the demo stack to the VM: compose.yaml, Caddyfile, loop.sh, gen-epg.mjs, content script, .env and
  demo.env (TMDB_API_KEY straight from Secret Manager into a 0600 file — never printed), then `compose up`.
.PARAMETER Image  full Artifact Registry ref, e.g. europe-west1-docker.pkg.dev/mmo-mw-prod/mixai/mmo-server:3.9.2-abc1234
.PARAMETER Hosts  Caddy site addresses (comma list). Default: demo.mixai.ro + <ip>.sslip.io (works before DNS).
#>
param(
    [Parameter(Mandatory)][string]$Image,
    [string]$Project = 'mmo-mw-prod',
    [string]$Zone = 'europe-central2-a',
    [string]$Name = 'mixai-demo',
    [string]$Hosts = '',
    [string]$WebAppUrl = 'https://mixai-web-622082681070.europe-west1.run.app'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$tmp = Join-Path ([IO.Path]::GetTempPath()) "mixai-demo-$([guid]::NewGuid().ToString('n').Substring(0, 8))"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
    $ip = (& gcloud compute instances describe $Name --zone $Zone --project $Project --format='value(networkInterfaces[0].accessConfigs[0].natIP)').Trim()
    if (-not $Hosts) { $Hosts = "demo.mixai.ro, $($ip -replace '\.', '-').sslip.io" }
    $lf = { param($p, $s) [IO.File]::WriteAllText($p, ($s -replace "`r`n", "`n"), [Text.UTF8Encoding]::new($false)) }
    foreach ($f in 'compose.yaml', 'Caddyfile', 'loop.sh', 'gen-epg.mjs', 'content.sh', 'setup.mjs', 'ATTRIBUTION.md') {
        & $lf (Join-Path $tmp $f) (Get-Content (Join-Path $here $f) -Raw)
    }
    & $lf (Join-Path $tmp '.env') "MMO_IMAGE=$Image`nDEMO_HOSTS=$Hosts`nDEMO_HOST=$(($Hosts -split ',')[0].Trim())`nMMO_WEB_APP_URL=$WebAppUrl`n"
    $key = (& gcloud secrets versions access latest --secret mixai-web-tmdb-api-key --project $Project | Out-String).Trim()
    if (-not $key) { throw 'TMDB key empty' }
    & $lf (Join-Path $tmp 'demo.env') "TMDB_API_KEY=$key`n"
    $key = $null
    Write-Host "::step copy (hosts=$Hosts)"
    & gcloud compute ssh $Name --zone $Zone --project $Project --quiet --command 'sudo mkdir -p /srv/mixai/app && sudo chown $(id -u):$(id -g) /srv/mixai/app'
    if ($LASTEXITCODE -ne 0) { throw 'ssh mkdir failed' }
    $files = Get-ChildItem $tmp -Force | ForEach-Object { $_.FullName }
    & gcloud compute scp @files "${Name}:/srv/mixai/app/" --zone $Zone --project $Project --quiet
    if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
    Write-Host '::step compose up'
    $remote = 'cd /srv/mixai/app && chmod 600 demo.env .env && chmod +x loop.sh content.sh && sudo docker compose pull -q && sudo docker compose up -d --remove-orphans && sudo docker compose ps --format "{{.Name}} {{.Status}}"'
    & gcloud compute ssh $Name --zone $Zone --project $Project --quiet --command $remote
    if ($LASTEXITCODE -ne 0) { throw 'compose up failed' }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Write-Host 'DEPLOYDONE'
