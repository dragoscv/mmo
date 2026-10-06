<#
.SYNOPSIS
  Run the MixAI Companion headless core (server/dist/headless.js) on this PC
  under Node 22, detached, serving local media folders on the LAN.

.DESCRIPTION
  Same server code as the Electron companion (port 17899, mDNS
  `_mmo-companion._tcp`, /pair Quick Connect, /video/*), but as a plain Node
  process — no Electron ABI juggling. Data dir defaults to
  %APPDATA%\mixai-companion-headless (config.json holds the device token).

  Logs:   .copilot-tmp/companion-local.log
  PID:    .copilot-tmp/companion-local.pid   (a previous instance is killed first)

  Node 22 is located via fnm (%APPDATA%\fnm\node-versions\v22*) or -NodeExe.
  better-sqlite3 must carry the Node ABI; when `require` fails the script runs
  `prebuild-install -r node` (this flips the binary away from Electron —
  `pnpm rebuild:electron` / `npx prebuild-install -r electron -t 34.5.8` restores it).

.EXAMPLE
    pwsh -NoProfile -File scripts/run-companion-local.ps1 -Media 'D:\Movies,D:\TV Shows,H:\Music'
    (with -File, pass the folders as ONE comma-separated string; paths with spaces break array binding)
  pwsh -NoProfile -File scripts/run-companion-local.ps1 -Stop
#>
[CmdletBinding()]
param(
    [string[]] $Media = @('D:\Movies', 'D:\TV Shows', 'H:\Movies', 'H:\TV Shows', 'H:\Music'),
    [int] $Port = 17899,
    [string] $Data = (Join-Path $env:APPDATA 'mixai-companion-headless'),
    [string] $NodeExe,
    [switch] $Build,
    [switch] $Stop
)

$ErrorActionPreference = 'Stop'
$Media = @($Media | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$repo = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repo 'server'
$tmp = Join-Path $repo '.copilot-tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pidFile = Join-Path $tmp 'companion-local.pid'
$logFile = Join-Path $tmp 'companion-local.log'
$errFile = Join-Path $tmp 'companion-local.err.log'

function Stop-Previous {
    if (-not (Test-Path $pidFile)) { return }
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($old -match '^\d+$') {
        $p = Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -eq 'node') {
            Write-Host "Stopping previous companion (pid $old)"
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 800
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

Stop-Previous
if ($Stop) { Write-Host 'Stopped.'; exit 0 }

if (-not $NodeExe) {
    $NodeExe = Get-ChildItem "$env:APPDATA\fnm\node-versions\v22*\installation\node.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
    throw 'Node 22 not found. Install via fnm (fnm install 22) or pass -NodeExe.'
}
$nodeDir = Split-Path $NodeExe
$env:PATH = "$nodeDir;$env:PATH"
Write-Host "node: $NodeExe ($(& $NodeExe --version))"

Push-Location $serverDir
try {
    $dist = Join-Path $serverDir 'dist\headless.js'
    if ($Build -or -not (Test-Path $dist)) {
        Write-Host 'Building server (tsc)…'
        & $NodeExe node_modules\typescript\bin\tsc
        if ($LASTEXITCODE -ne 0) { throw "tsc failed ($LASTEXITCODE)" }
    }

    # better-sqlite3 must match the Node ABI (Electron dev leaves it at ABI 132).
    & $NodeExe -e "require('better-sqlite3')" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'better-sqlite3 is not built for this Node ABI — fetching Node prebuild…'
        Push-Location (Join-Path $serverDir 'node_modules\better-sqlite3')
        try {
            & $NodeExe "$nodeDir\node_modules\npm\bin\npx-cli.js" --yes prebuild-install -r node
            if ($LASTEXITCODE -ne 0) { throw 'prebuild-install failed' }
        } finally { Pop-Location }
        & $NodeExe -e "require('better-sqlite3')"
        if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 still fails to load under Node 22' }
        Write-Warning 'better-sqlite3 now targets Node; run `pnpm rebuild:electron` in server/ before `pnpm dev:once`.'
    }

    $existing = $Media | Where-Object { Test-Path $_ }
    $missing = $Media | Where-Object { -not (Test-Path $_) }
    foreach ($m in $missing) { Write-Warning "media folder missing, skipped: $m" }

    New-Item -ItemType Directory -Force -Path $Data | Out-Null
    $env:MMO_HEADLESS = '1'
    $env:MMO_DATA = $Data
    $env:MMO_PORT = "$Port"
    $env:MMO_MEDIA = ($existing -join ',')

    if (Test-Path $logFile) { Move-Item $logFile "$logFile.prev" -Force }
    if (Test-Path $errFile) { Remove-Item $errFile -Force }

    $proc = Start-Process -FilePath $NodeExe -ArgumentList 'dist/headless.js' -WorkingDirectory $serverDir `
        -RedirectStandardOutput $logFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
    Set-Content -Path $pidFile -Value $proc.Id
    Write-Host "Started companion pid $($proc.Id) on port $Port"
    Write-Host "  data:  $Data"
    Write-Host "  media: $($env:MMO_MEDIA)"
    Write-Host "  log:   $logFile"

    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
        if ($proc.HasExited) { break }
    }
    if ($ok) {
        Write-Host "health: OK"
        try { Write-Host ("pair/info: " + (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/pair/info" -TimeoutSec 3).Content) } catch { }
    } else {
        Write-Warning "companion did not answer /health within 20 s — see $logFile / $errFile"
        if (Test-Path $errFile) { Get-Content $errFile -Tail 20 }
        exit 1
    }
} finally { Pop-Location }
