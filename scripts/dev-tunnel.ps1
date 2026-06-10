#!/usr/bin/env pwsh
<#
  Starts a cloudflared quick tunnel pointing at the local Next.js dev
  server (port 13789) and writes the assigned public URL to a sentinel
  file so the companion task can pick it up.

  Resolves the cloudflared binary in this order:
    1. server/node_modules/cloudflared (installed by `pnpm install`)
    2. cloudflared on PATH

  Stays in the foreground and streams cloudflared output so VS Code's
  task panel shows tunnel reconnects / errors live.
#>
[CmdletBinding()]
param(
    [int]$Port = 13789,
    [string]$UrlFile = "$PSScriptRoot/../.vscode/.dev-tunnel-url"
)

$ErrorActionPreference = "Stop"
$urlFileFull = [System.IO.Path]::GetFullPath($UrlFile)
$urlDir = Split-Path $urlFileFull -Parent
if (-not (Test-Path $urlDir)) { New-Item -ItemType Directory -Force -Path $urlDir | Out-Null }
# Wipe any stale URL so the companion task blocks until we publish a fresh one.
if (Test-Path $urlFileFull) { Remove-Item $urlFileFull -Force }

function Resolve-Cloudflared {
    $candidates = @(
        Join-Path $PSScriptRoot "..\server\node_modules\cloudflared\bin\cloudflared.exe"
    )
    foreach ($c in $candidates) {
        $full = [System.IO.Path]::GetFullPath($c)
        if (Test-Path $full) { return $full }
    }
    $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "cloudflared not found. Run 'pnpm install' in /server (the cloudflared npm package downloads the binary) or install cloudflared on PATH."
}

$bin = Resolve-Cloudflared
Write-Host "[dev-tunnel] cloudflared -> $bin"
Write-Host "[dev-tunnel] tunneling http://localhost:$Port"
Write-Host "[dev-tunnel] URL will be written to $urlFileFull once issued"
Write-Host ""

# Quick tunnel: prints `https://<random>.trycloudflare.com` to stderr.
# We tee both streams to stdout and grep the URL out as it appears.
$args = @("tunnel", "--no-autoupdate", "--url", "http://localhost:$Port")
$published = $false
$urlRegex = [regex]'https://[a-z0-9-]+\.trycloudflare\.com'

& $bin @args 2>&1 | ForEach-Object {
    $line = $_.ToString()
    Write-Host $line
    if (-not $published) {
        $m = $urlRegex.Match($line)
        if ($m.Success) {
            $url = $m.Value
            Set-Content -Path $urlFileFull -Value $url -NoNewline -Encoding utf8
            Write-Host ""
            Write-Host "[dev-tunnel] published: $url"
            Write-Host "[dev-tunnel] wrote $urlFileFull"
            Write-Host ""
            $published = $true
        }
    }
}
