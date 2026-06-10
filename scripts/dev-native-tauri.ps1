#!/usr/bin/env pwsh
<#
  Waits for the dev tunnel URL sentinel file (written by
  dev-tunnel.ps1) and launches `pnpm tauri:dev` in /apps/native with
  MMO_WEB_APP_URL pointing at that URL, so the Tauri WebView loads
  the LOCAL Next.js dev server via the cloud tunnel — same path the
  production app would take.

  If -NoWait is set, the script will not block: it uses whatever URL
  is already present (or whatever MMO_WEB_APP_URL is set to in the
  environment, or the Rust-side localhost:13789 fallback).
#>
[CmdletBinding()]
param(
    [string]$UrlFile = "$PSScriptRoot/../.vscode/.dev-tunnel-url",
    [int]$TimeoutSec = 120,
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"
$urlFileFull = [System.IO.Path]::GetFullPath($UrlFile)

if (-not $NoWait) {
    Write-Host "[dev-native-tauri] waiting for tunnel URL at $urlFileFull (timeout ${TimeoutSec}s)"
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while (-not (Test-Path $urlFileFull)) {
        if ((Get-Date) -gt $deadline) {
            throw "Timed out waiting for $urlFileFull. Is the 'Dev: Tunnel (cloudflared quick)' task running?"
        }
        Start-Sleep -Milliseconds 500
    }
}

if (Test-Path $urlFileFull) {
    $url = (Get-Content -Path $urlFileFull -Raw).Trim()
    if ($url) {
        $env:MMO_WEB_APP_URL = $url
        Write-Host "[dev-native-tauri] MMO_WEB_APP_URL = $url"
    }
}

if (-not $env:MMO_WEB_APP_URL) {
    Write-Host "[dev-native-tauri] no tunnel URL — Rust will default to http://localhost:13789"
}

Push-Location (Join-Path $PSScriptRoot "..\apps\native")
try {
    & pnpm tauri:dev
} finally {
    Pop-Location
}
