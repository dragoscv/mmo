<#
.SYNOPSIS
  Build the MMO Server Docker image LOCALLY (never on the Pi), measured.
  Uses docker buildx with QEMU for arm64 and a persistent local cache dir.
.PARAMETER Platforms  e.g. linux/arm64 (default) or linux/amd64,linux/arm64
.PARAMETER Tag        image tag (default mmo-server:local)
.PARAMETER Load       load into local docker (single platform only)
.PARAMETER Out        write an OCI tar here (for shipping to the Pi)
#>
param(
    [string]$Platforms = "linux/arm64",
    [string]$Tag = "mmo-server:local",
    [switch]$Load,
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $repo ".copilot-tmp\buildx-cache\mmo-server"
New-Item -ItemType Directory -Force $cache | Out-Null

# Ensure a container-driver builder (needed for --cache-to type=local and multi-platform).
$builder = "mmo-builder"
if (-not (docker buildx inspect $builder 2>$null)) {
    docker buildx create --name $builder --driver docker-container --bootstrap | Out-Null
}
docker run --privileged --rm tonistiigi/binfmt --install arm64 2>$null | Out-Null

$args = @("buildx", "build", "--builder", $builder, "--platform", $Platforms,
    "-f", (Join-Path $repo "server\Dockerfile"), "-t", $Tag,
    "--cache-from", "type=local,src=$cache",
    "--cache-to", "type=local,dest=$cache,mode=max",
    "--provenance=false")
if ($Load) { $args += "--load" }
if ($Out) { $args += @("--output", "type=docker,dest=$Out") }
$args += (Join-Path $repo "server")

$sw = [Diagnostics.Stopwatch]::StartNew()
& docker @args
if ($LASTEXITCODE -ne 0) { throw "buildx failed ($LASTEXITCODE)" }
$sw.Stop()
Write-Host ("BUILD OK  {0}  platforms={1}  {2:n1}s" -f $Tag, $Platforms, $sw.Elapsed.TotalSeconds)
if ($Load) { docker image inspect $Tag --format 'size={{.Size}} bytes ({{.Architecture}})' }
if ($Out) { Get-Item $Out | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,1)}} }
