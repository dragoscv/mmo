<#
.SYNOPSIS
  Measure every build in the monorepo: cold (output dir removed) then warm,
  recording wall time + output size into .copilot-tmp/build-metrics.json.

.DESCRIPTION
  Targets: web, server, gateway, mixai, tv-tizen, tv-android, pkg-ai, pkg-db.
  Each is run twice; a target whose node_modules / toolchain is missing is
  reported as SKIPPED with the reason instead of failing the run.

  The web build goes through the cross-session build wrapper
  (~/.copilot/hooks/run-build.ps1) because two next builds in one clone
  corrupt each other's .next. Gradle is launched via the wrapper JAR in a
  hidden java process — gradlew.bat in a shared terminal dies on a foreign
  Ctrl+C ("Terminate batch job (Y/N)?").

.EXAMPLE
  pwsh -NoProfile -File scripts/measure-builds.ps1 -Label before
  pwsh -NoProfile -File scripts/measure-builds.ps1 -Label after -Only web,gateway
  pwsh -NoProfile -File scripts/measure-builds.ps1 -Label after -Skip tv-android -NoCold
#>
[CmdletBinding()]
param(
  [string]$Label = (Get-Date -Format 'yyyyMMdd-HHmmss'),
  [string[]]$Only,
  [string[]]$Skip,
  [switch]$NoCold,
  [switch]$NoWarm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmp = Join-Path $root '.copilot-tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$metricsPath = Join-Path $tmp 'build-metrics.json'
$logDir = Join-Path $tmp 'build-metrics-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$wrapper = Join-Path $env:USERPROFILE '.copilot\hooks\run-build.ps1'

function Get-DirBytes([string[]]$paths) {
  $sum = 0L
  foreach ($p in $paths) {
    if (-not (Test-Path $p)) { continue }
    $item = Get-Item $p
    if ($item.PSIsContainer) {
      $sum += (Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    } else { $sum += $item.Length }
  }
  return [long]$sum
}

function Remove-Dirs([string[]]$paths) {
  foreach ($p in $paths) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

# Run a command in its own process, capture to a log, return exit code.
# NOTE: parameter must not be named $args — that is the automatic variable and
# shadows the bound value (every child process ran with NO arguments).
function Invoke-Logged([string]$cwd, [string]$file, [string[]]$argList, [string]$log) {
  $err = "$log.err"
  Remove-Item $log, $err -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $file -ArgumentList $argList -WorkingDirectory $cwd `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $log -RedirectStandardError $err
  $p.WaitForExit()
  if (Test-Path $err) { Get-Content $err -ErrorAction SilentlyContinue | Add-Content $log }
  return $p.ExitCode
}

$pwshExe = (Get-Process -Id $PID).Path
$pnpmCmd = Get-Command pnpm.cmd, pnpm -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $pnpmCmd) { throw 'pnpm not found on PATH' }

function New-PnpmTarget($name, $rel, $script, $out, $cleanExtra = @()) {
  $cwd = Join-Path $root $rel
  $invoke = ${function:Invoke-Logged}
  $pnpm = $pnpmCmd
  [pscustomobject]@{
    Name = $name; Cwd = $cwd
    Outputs = @($out | ForEach-Object { Join-Path $cwd $_ })
    Clean = @(($out + $cleanExtra) | ForEach-Object { Join-Path $cwd $_ })
    # Scriptblocks are not closures by default: capture $cwd/$rel/$script.
    Check = { if (-not (Test-Path (Join-Path $cwd 'node_modules'))) { "node_modules missing in $rel" } }.GetNewClosure()
    Run = { param($log) & $invoke $cwd $pnpm @('run', $script) $log }.GetNewClosure()
  }
}

$targets = @(
  # web: through the build wrapper, from repo root (it always runs at git top).
  [pscustomobject]@{
    Name = 'web'; Cwd = $root
    Outputs = @((Join-Path $root 'apps\web\.next'))
    Clean = @((Join-Path $root 'apps\web\.next'))
    Check = {
      if (-not (Test-Path (Join-Path $root 'apps\web\node_modules'))) { return 'node_modules missing in apps/web' }
      if (-not (Test-Path $wrapper)) { return "build wrapper missing: $wrapper" }
    }
    Run = {
      param($log)
      # Start-Process re-joins the argument list; quote the command so the
      # wrapper receives it as ONE value.
      Invoke-Logged $root $pwshExe @('-NoProfile', '-File', $wrapper, '-Command', '"pnpm --filter music-organizer build"', '-Wait', '-TimeoutMin', '40') $log
    }
  },
  (New-PnpmTarget 'server' 'server' 'build' @('dist') @('node_modules\.cache\tsbuildinfo')),
  (New-PnpmTarget 'gateway' 'apps\gateway' 'build' @('dist')),
  (New-PnpmTarget 'mixai' 'apps\mixai' 'build' @('dist') @('node_modules\.cache\tsbuildinfo', 'node_modules\.vite')),
  (New-PnpmTarget 'tv-tizen' 'apps\tv-tizen' 'build' @('dist') @('node_modules\.cache\tsbuildinfo', 'node_modules\.vite')),
  [pscustomobject]@{
    Name = 'tv-android'; Cwd = (Join-Path $root 'apps\tv-android')
    Outputs = @((Join-Path $root 'apps\tv-android\app\build\outputs'))
    Clean = @((Join-Path $root 'apps\tv-android\app\build'), (Join-Path $root 'apps\tv-android\build'), (Join-Path $root 'apps\tv-android\.gradle'))
    Check = {
      $jh = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
      if (-not (Test-Path "$jh\bin\java.exe")) { return "java missing ($jh)" }
      if (-not (Test-Path (Join-Path $root 'apps\tv-android\gradle\wrapper\gradle-wrapper.jar'))) { return 'gradle-wrapper.jar missing' }
      if (-not (Test-Path "$env:LOCALAPPDATA\Android\Sdk") -and -not $env:ANDROID_HOME) { return 'Android SDK missing' }
    }
    Run = {
      param($log)
      $jh = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "$env:ProgramFiles\Android\Android Studio\jbr" }
      $env:JAVA_HOME = $jh
      Invoke-Logged (Join-Path $root 'apps\tv-android') "$jh\bin\java.exe" @('-classpath', 'gradle\wrapper\gradle-wrapper.jar', 'org.gradle.wrapper.GradleWrapperMain', '--console=plain', 'assembleDebug') $log
    }
  },
  (New-PnpmTarget 'pkg-ai' 'packages\ai' 'typecheck' @() @('node_modules\.cache\tsbuildinfo')),
  # packages/db has no tsconfig/scripts of its own — typecheck via tsc from apps/web's toolchain.
  [pscustomobject]@{
    Name = 'pkg-db'; Cwd = (Join-Path $root 'packages\db')
    Outputs = @(); Clean = @((Join-Path $root 'packages\db\node_modules\.cache\tsbuildinfo'))
    Check = {
      if (-not (Test-Path (Join-Path $root 'packages\db\node_modules'))) { return 'node_modules missing in packages/db' }
      if (-not (Test-Path (Join-Path $root 'packages\db\tsconfig.json'))) { return 'packages/db has no tsconfig.json' }
    }
    Run = { param($log) Invoke-Logged (Join-Path $root 'packages\db') $pnpmCmd @('exec', 'tsc', '--noEmit') $log }
  }
)

if ($Only) { $targets = $targets | Where-Object { $Only -contains $_.Name } }
if ($Skip) { $targets = $targets | Where-Object { $Skip -notcontains $_.Name } }

$all = @{}
if (Test-Path $metricsPath) { $all = Get-Content $metricsPath -Raw | ConvertFrom-Json -AsHashtable }
if (-not $all.ContainsKey($Label)) { $all[$Label] = @{} }
$results = @()

foreach ($t in $targets) {
  $reason = & $t.Check
  if ($reason) {
    Write-Host "[$($t.Name)] SKIPPED: $reason" -ForegroundColor Yellow
    $results += [pscustomobject]@{ Target = $t.Name; Cold_s = $null; Warm_s = $null; Size_MB = $null; Status = "skipped: $reason" }
    $all[$Label][$t.Name] = @{ skipped = $reason }
    continue
  }
  $rec = @{}
  foreach ($phase in @('cold', 'warm')) {
    if ($phase -eq 'cold' -and $NoCold) { continue }
    if ($phase -eq 'warm' -and $NoWarm) { continue }
    if ($phase -eq 'cold') { Remove-Dirs $t.Clean }
    $log = Join-Path $logDir "$Label-$($t.Name)-$phase.log"
    Write-Host "[$($t.Name)] $phase build…" -NoNewline
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $code = & $t.Run $log
    $sw.Stop()
    $sec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $bytes = Get-DirBytes $t.Outputs
    Write-Host " exit=$code ${sec}s $([math]::Round($bytes/1MB,1)) MB"
    $rec[$phase] = @{ seconds = $sec; exit = $code; bytes = $bytes; log = $log }
  }
  $all[$Label][$t.Name] = $rec
  $status = if (($rec.Values | Where-Object { $_.exit -ne 0 })) { 'FAILED' } else { 'ok' }
  $results += [pscustomobject]@{
    Target = $t.Name
    Cold_s = $rec.cold.seconds
    Warm_s = $rec.warm.seconds
    Size_MB = if ($rec.warm) { [math]::Round($rec.warm.bytes / 1MB, 1) } elseif ($rec.cold) { [math]::Round($rec.cold.bytes / 1MB, 1) } else { $null }
    Status = $status
  }
  # Persist after every target so a crash mid-run loses nothing.
  $all | ConvertTo-Json -Depth 6 | Set-Content $metricsPath -Encoding utf8
}

Write-Host "`n== build metrics [$Label] ==" -ForegroundColor Cyan
$results | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "saved: $metricsPath"
