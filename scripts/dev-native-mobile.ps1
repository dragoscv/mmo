#requires -Version 7
<#
.SYNOPSIS
    Builds the Capacitor web assets, ensures the Android platform exists,
    starts the first available Android Virtual Device if none is running,
    and runs the app on it. Designed for the "Dev: Native Mobile (Android)"
    VS Code task — zero prompts on the happy path.

.PARAMETER UseTunnel
    Read the cloudflared quick-tunnel URL written by dev-tunnel.ps1 and
    use it as CAP_SERVER_URL so the WebView loads the LOCAL Next.js dev
    server through the cloud tunnel. Required for physical devices and
    recommended for OAuth flows. Without this flag, the script defaults
    CAP_SERVER_URL to http://10.0.2.2:13789 (emulator host-loopback).

.PARAMETER TunnelUrlFile
    Path to the sentinel file the dev-tunnel.ps1 writes the quick-tunnel
    URL to. Defaults to .vscode/.dev-tunnel-url.

.PARAMETER TunnelTimeoutSec
    How long to wait for the sentinel file when -UseTunnel is set.
#>
param(
    [switch]$UseTunnel,
    [string]$TunnelUrlFile = "$PSScriptRoot/../.vscode/.dev-tunnel-url",
    [int]$TunnelTimeoutSec = 120
)

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$nativeDir = Join-Path $repoRoot 'apps/native'

if (-not (Test-Path $nativeDir)) {
    Write-Error "apps/native not found at $nativeDir"
    exit 1
}

function Resolve-AndroidTool {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [string[]] $SubPath
    )
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($root in @($Env:ANDROID_HOME, $Env:ANDROID_SDK_ROOT, "$Env:LOCALAPPDATA\Android\Sdk")) {
        if (-not $root) { continue }
        foreach ($sp in $SubPath) {
            $candidate = Join-Path $root (Join-Path $sp ("$Name.exe"))
            if (Test-Path $candidate) { return $candidate }
            $candidate = Join-Path $root (Join-Path $sp $Name)
            if (Test-Path $candidate) { return $candidate }
        }
    }
    return $null
}

Push-Location $nativeDir
try {
    # In dev we want the WebView to load the host's `pnpm dev` server, not
    # the production origin. Two modes:
    #   * -UseTunnel: wait for the cloudflared quick-tunnel sentinel from
    #     dev-tunnel.ps1 and use that HTTPS URL. Works on real devices,
    #     unblocks Google OAuth (needs a public origin), mirrors prod.
    #   * default: 10.0.2.2:13789 — Android emulator's host-loopback alias.
    # Override either path by setting CAP_SERVER_URL before launching.
    if (-not $Env:CAP_SERVER_URL) {
        if ($UseTunnel) {
            $tunnelFile = [System.IO.Path]::GetFullPath($TunnelUrlFile)
            Write-Host "[mobile] waiting for tunnel URL at $tunnelFile (timeout ${TunnelTimeoutSec}s)" -ForegroundColor DarkGray
            $deadline = (Get-Date).AddSeconds($TunnelTimeoutSec)
            while (-not (Test-Path $tunnelFile)) {
                if ((Get-Date) -gt $deadline) {
                    throw "Timed out waiting for $tunnelFile. Is the 'Dev: Tunnel (cloudflared quick)' task running?"
                }
                Start-Sleep -Milliseconds 500
            }
            $tunnelUrl = (Get-Content -Path $tunnelFile -Raw).Trim()
            if (-not $tunnelUrl) { throw "Tunnel URL file is empty: $tunnelFile" }
            $Env:CAP_SERVER_URL = $tunnelUrl
        }
        else {
            $Env:CAP_SERVER_URL = 'http://10.0.2.2:13789'
        }
    }
    Write-Host "[mobile] CAP_SERVER_URL = $Env:CAP_SERVER_URL" -ForegroundColor DarkGray

    $distDir = Join-Path $nativeDir 'dist'
    if (-not (Test-Path $distDir)) {
        New-Item -ItemType Directory -Path $distDir | Out-Null
    }
    Copy-Item (Join-Path $nativeDir 'web/index.html') (Join-Path $distDir 'index.html') -Force

    if (-not (Test-Path (Join-Path $nativeDir 'android'))) {
        Write-Host '[mobile] android/ platform missing - running `cap add android` (one-time setup)...' -ForegroundColor Cyan
        pnpm exec cap add android
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    Write-Host '[mobile] syncing web assets to android/...' -ForegroundColor Cyan
    pnpm exec cap sync android
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $adb = Resolve-AndroidTool -Name 'adb' -SubPath @('platform-tools')
    $emulator = Resolve-AndroidTool -Name 'emulator' -SubPath @('emulator')

    if (-not $adb) {
        Write-Warning 'adb not found on PATH or under ANDROID_HOME / %LOCALAPPDATA%\Android\Sdk. Install Android Studio + Platform Tools, then re-run this task.'
        exit 1
    }

    $devicesOutput = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "`t(device|emulator)" }
    $targetId = $null
    if ($devicesOutput) {
        $targetId = ($devicesOutput[0] -split "`t")[0]
        Write-Host "[mobile] using already-running device: $targetId" -ForegroundColor Green
    }
    else {
        if (-not $emulator) {
            Write-Warning 'No device attached and `emulator` not found. Open Android Studio > Device Manager to create/start an AVD, then re-run this task.'
            exit 1
        }
        $avds = & $emulator -list-avds 2>$null | Where-Object { $_ -and $_.Trim().Length -gt 0 }
        if (-not $avds) {
            Write-Warning 'No Android Virtual Devices configured. Open Android Studio > Device Manager and create one (e.g. Pixel 7, API 34), then re-run this task.'
            exit 1
        }
        $avdName = $avds[0].Trim()
        Write-Host "[mobile] booting AVD: $avdName (this can take 30-90s on first run)..." -ForegroundColor Cyan
        $null = Start-Process -FilePath $emulator -ArgumentList @('-avd', $avdName, '-netdelay', 'none', '-netspeed', 'full') -PassThru

        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            $line = (& $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "`temulator" } | Select-Object -First 1)
            if ($line) {
                $id = ($line -split "`t")[0]
                $boot = & $adb -s $id shell getprop sys.boot_completed 2>$null
                if ($boot -and $boot.Trim() -eq '1') {
                    $targetId = $id
                    Write-Host "[mobile] emulator ready: $targetId" -ForegroundColor Green
                    break
                }
            }
        }
        if (-not $targetId) {
            Write-Warning 'Timed out waiting for the emulator to boot. Open Android Studio > Device Manager and start it manually, then re-run this task.'
            exit 1
        }
    }

    Write-Host "[mobile] installing & launching app on $targetId..." -ForegroundColor Cyan
    pnpm exec cap run android --target=$targetId --no-sync
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
