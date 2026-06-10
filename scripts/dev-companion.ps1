#!/usr/bin/env pwsh
<#
  Waits for the dev tunnel URL sentinel file to appear (written by
  dev-tunnel.ps1), then launches `pnpm dev` in /server with
  MMO_WEB_APP_URL pointing at that URL. The companion then talks to the
  LOCAL Next.js dev server via the cloud tunnel — exactly the same path
  the production app takes from Vercel.
#>
[CmdletBinding()]
param(
    [string]$UrlFile = "$PSScriptRoot/../.vscode/.dev-tunnel-url",
    [int]$TimeoutSec = 120
)

$ErrorActionPreference = "Stop"
$urlFileFull = [System.IO.Path]::GetFullPath($UrlFile)

Write-Host "[dev-companion] waiting for tunnel URL at $urlFileFull (timeout ${TimeoutSec}s)"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $urlFileFull)) {
    if ((Get-Date) -gt $deadline) {
        throw "Timed out waiting for $urlFileFull. Is the 'Dev: Tunnel (cloudflared)' task running?"
    }
    Start-Sleep -Milliseconds 500
}

$url = (Get-Content -Path $urlFileFull -Raw).Trim()
if (-not $url) { throw "Tunnel URL file is empty: $urlFileFull" }

Write-Host "[dev-companion] MMO_WEB_APP_URL = $url"
Write-Host "[dev-companion] launching companion (pnpm dev) in /server"
Write-Host ""

$env:MMO_WEB_APP_URL = $url

# Prefer Python 3.12 for the voice-clone sidecar (coqui-tts + torch wheels
# are not yet published for 3.13). Only set if caller didn't override.
if (-not $env:MMO_PYTHON) {
    $py312 = "C:\Python312\python.exe"
    if (Test-Path $py312) {
        $env:MMO_PYTHON = $py312
        Write-Host "[dev-companion] MMO_PYTHON = $py312"
    }
}

Push-Location (Join-Path $PSScriptRoot "..\server")
try {
    & pnpm dev
} finally {
    Pop-Location
}
