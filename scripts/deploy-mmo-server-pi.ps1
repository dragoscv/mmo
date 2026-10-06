<#
.SYNOPSIS
  Ship MMO Server to the Raspberry Pi. The arm64 image is built LOCALLY
  (scripts/build-mmo-server-image.ps1, QEMU) — the Pi only receives an image
  tar and runs `docker load` + compose. Never builds on the Pi.
.PARAMETER Pi        ssh alias/host (default homepi)
.PARAMETER Tag       image tag (default mmo-server:local)
.PARAMETER SkipBuild reuse the last local build tar
#>
param(
    [string]$Pi = "homepi",
    [string]$Tag = "mmo-server:local",
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$tar = Join-Path $repo ".copilot-tmp\mmo-server-arm64.tar"
$total = [Diagnostics.Stopwatch]::StartNew()

if (-not $SkipBuild) {
    & pwsh -NoProfile -File (Join-Path $PSScriptRoot "build-mmo-server-image.ps1") -Platforms linux/arm64 -Tag $Tag -Out $tar
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
ssh $Pi "sudo mkdir -p /srv/homepi/mmo /srv/media/Movies /srv/media/Music && sudo chown -R `$(id -u):`$(id -g) /srv/homepi/mmo /srv/media"
scp -q (Join-Path $repo "infra\pi\compose.mmo.yaml") "${Pi}:/srv/homepi/mmo/compose.yaml"
scp -q $tar "${Pi}:/tmp/mmo-server.tar"
ssh $Pi "docker load -i /tmp/mmo-server.tar && rm /tmp/mmo-server.tar && docker image inspect $Tag --format 'loaded {{.Id}} {{.Created}}'"
Write-Host ("SHIP OK  {0:n1}s  ({1:n0} MB tar)" -f $sw.Elapsed.TotalSeconds, ((Get-Item $tar).Length / 1MB))

ssh $Pi "cd /srv/homepi/mmo && MMO_IMAGE=$Tag docker compose -f compose.yaml up -d --force-recreate --remove-orphans && docker image prune -f >/dev/null"
Start-Sleep -Seconds 6
ssh $Pi "docker ps --filter name=mmo-server --format '{{.Names}} {{.Status}}'; docker images $Tag --format 'image {{.Size}}'; wget -qO- http://127.0.0.1:17899/health"
Write-Host ("DEPLOY OK  total {0:n1}s" -f $total.Elapsed.TotalSeconds)
