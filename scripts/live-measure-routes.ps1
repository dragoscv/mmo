<#
.SYNOPSIS
  Measures the real round trip on every route this machine can drive, in one go.

.DESCRIPTION
  The probes need a physical loopback (output back into the input: a cable, a Voicemeeter strip, or a
  speaker into the microphone). This script runs `latency` once per route, keeps every answer or failure
  verbatim, and writes a comparison table next to the raw output, so the numbers can be compared and
  pasted into docs/live/latency.md.

  It changes nothing: no setting, no buffer, no Voicemeeter configuration. It does open the audio devices,
  so the live engine must not be running.

.PARAMETER Routes
  Which routes to measure. Default: all of them.
    exclusive  - WASAPI Exclusive straight to the interface (--host "WASAPI Exclusive")
    shared     - plain WASAPI (the Windows mixer)
    insert     - the engine inside Voicemeeter's callback (--host "Voicemeeter Insert")
    asio       - ASIO, with the device named by -AsioDevice
  ONE comma-separated string: `-Routes exclusive,insert` works from the command line, an array does not
  (through `-File` it arrives as a single string).

.PARAMETER AsioDevice
  The ASIO device to use for the asio route (an ASIO driver's own buffer is only known once opened).
  Default: "Voicemeeter Potato Insert Vi..." - the ASIO face of the same insert point as the Remote-API
  host, so the two can be compared against each other. Note the ellipsis: ASIO limits a driver's name to
  32 characters and VB-Audio's driver really is called that, so the name must be copied from
  `mixai-live-engine devices --host ASIO` exactly.

.PARAMETER Buffer
  Requested period, in frames (the WASAPI and Voicemeeter routes). Default 128.

.PARAMETER AsioBuffer
  Requested period for the asio route, in frames. Default 256: an ASIO driver has its own fixed period
  and the Voicemeeter insert driver accepts nothing else, so reusing the WASAPI figure only produces
  "Buffer size 128 is not in the supported range 256..=256". The error names the real range when a driver
  differs.

.PARAMETER InCh
  Input channel for the insert route, in Voicemeeter's own channel space. Default 8: the microphone is the
  LEFT channel of Potato strip index 4 (insert channels 8 and 9).

.PARAMETER DirectInCh
  Input channel for exclusive / shared / asio, whose input is the interface itself and not Voicemeeter.
  Default 0. These two cannot be one number: the interface has 2 channels, so asking it for channel 8 is
  refused ("input has 2 channels, requested [8]"), while channel 0 of the insert host is Voicemeeter's
  first channel and not this microphone.

.PARAMETER ResultsDir
  Where the run is written: `<ResultsDir>/<stamp>/{comparison.md,raw.log,declared.json}`.
  NOT named `-Out`: that is the OUTPUT DEVICE (the interface), and one name for both was a bug.

.EXAMPLE
  pwsh -NoProfile -File scripts/live-measure-routes.ps1 -ResultsDir .copilot-tmp/live/measured
#>
[CmdletBinding()]
param(
    [string]$Routes = 'exclusive,shared,insert,asio',
    [string]$In = 'Audio Interface IN (2- HD-II)',
    [string]$Out = 'Audio Interface Out (2- HD-II)',
    # The microphone is the LEFT channel of Potato strip index 4 (insert channels 8 and 9).
    [string]$InCh = '8',
    [string]$DirectInCh = '0',
    [string]$AsioDevice = 'Voicemeeter Potato Insert Vi...',
    [int]$Buffer = 128,
    [int]$AsioBuffer = 256,
    [string]$Tag = '',
    [string]$ResultsDir = '.copilot-tmp\live\measured'
)

$ErrorActionPreference = 'Continue'
# The engine prints UTF-8; without this the arrow in its messages lands in the file as mojibake.
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
# One string in, a validated list out: `-File` hands a bare array over as a single argument.
$wanted = @($Routes.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$known = @('exclusive', 'shared', 'insert', 'asio')
$unknown = @($wanted | Where-Object { $_ -notin $known })
if ($unknown.Count) {
  "unknown route(s): $($unknown -join ', '); known: $($known -join ', ')"
  exit 2
}
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'apps\live\engine\target\release\mixai-live-engine.exe'
$stamp = if ($Tag) { $Tag } else { Get-Date -Format 'yyyy-MM-dd-HHmm' }
if (-not [IO.Path]::IsPathRooted($ResultsDir)) { $ResultsDir = Join-Path $repo $ResultsDir }
$dir = Join-Path $ResultsDir $stamp
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$table = Join-Path $dir 'comparison.md'
$raw = Join-Path $dir 'raw.log'

if (-not (Test-Path $exe)) {
    "the engine binary is missing: $exe`nbuild it with: pwsh -NoProfile -File `"$env:USERPROFILE\.copilot\hooks\run-build.ps1`" -Command 'cargo build --release -p live-cli --manifest-path apps/live/engine/Cargo.toml'"
    exit 2
}

"# Measured routes ($stamp, buffer $Buffer, rate 48000)" | Set-Content $table
'' | Add-Content $table
"binary: $((Get-Item $exe).LastWriteTime.ToString('yyyy-MM-dd HH:mm'))" | Add-Content $table
"machine load at the start: $((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average) %" | Add-Content $table
'' | Add-Content $table


$plan = [ordered]@{
    exclusive = @('--host', 'WASAPI Exclusive')
    shared    = @('--host', 'WASAPI')
    insert    = @('--host', 'Voicemeeter Insert')
    asio      = @('--host', 'ASIO')
}

# Preconditions, read-only: which route can even open the device, and why.
$vmRunning = $false
$vmA1 = ''
try {
  $vm = (& $exe voicemeeter 2>$null | Out-String) | ConvertFrom-Json
  $vmRunning = [bool]$vm.running
  $vmA1 = [string]$vm.a1_device
} catch { }
'## Preconditions' | Add-Content $table
"- Voicemeeter: $(if ($vmRunning) { "running, A1 = '$vmA1'" } else { 'not running' })" | Add-Content $table
if ($vmRunning -and $vmA1 -eq $Out) {
  "  - while Voicemeeter holds '$Out' as A1 the exclusive and shared routes CANNOT open it (expect
   'the device is in use by another application'). Measure those with Voicemeeter closed, or with this
   device off bus A1; measure the insert route with Voicemeeter running." | Add-Content $table
}
"- every probe needs a loopback: the output back into the input (cable, Voicemeeter strip, or a speaker
   into the microphone). Without one the engine reports the input is digitally silent." | Add-Content $table
'' | Add-Content $table

$hosts = @()
try { $hosts = @((& $exe devices 2>$null | Out-String | ConvertFrom-Json).hosts) } catch { }
$asioBuilt = $hosts -contains 'ASIO'
$asioNames = @()
if ($asioBuilt) {
  try { $asioNames = @((& $exe devices --host ASIO 2>$null | Out-String | ConvertFrom-Json).devices | ForEach-Object { $_.name }) } catch { }
}
$asioOk = $asioBuilt -and ($asioNames -contains $AsioDevice)
if (-not $asioBuilt) {
  "- ASIO is NOT built into this binary (hosts: $($hosts -join ', ')). Build it with:
   cargo build --release -p live-cli --features asio --manifest-path apps/live/engine/Cargo.toml
   (needs CPAL_ASIO_DIR and the ASIO SDK; see docs/live/latency.md#windows)" | Add-Content $table
} elseif (-not $asioOk) {
  "- the ASIO device '$AsioDevice' is not on this machine. Available: $($asioNames -join ' | ')
   (an ASIO driver's name is limited to 32 characters, so an ellipsis may be part of it - copy it
   from `mixai-live-engine devices --host ASIO`)" | Add-Content $table
}

# What each route declares, for the same settings: `routes` needs no loopback and no device.
$declared = (& $exe routes --input $In --output $Out --in-ch $InCh --buffer $Buffer 2>$null | Out-String)
$declared | Set-Content (Join-Path $dir 'declared.json')
$declaredMs = @{}
$declaredFrom = @{}
try {
    $j = $declared | ConvertFrom-Json
  foreach ($r in $j.routes) {
    $declaredMs[$r.host] = $r.terms.declared_ms
    $declaredFrom[$r.host] = $r.source
  }
  # An assumed figure is a request, not a reading: say so in the run header too.
  $assumed = @($j.routes | Where-Object { $_.source -eq 'assumed' } | ForEach-Object { $_.host })
  if ($assumed.Count) { "note: no driver figure for: $($assumed -join ', ') - their declared numbers are the REQUEST" | Add-Content $table }
    ('declared (from "routes"): ' + (($j.routes | ForEach-Object { "$($_.host) $($_.terms.declared_ms) ms" }) -join '; ')) | Add-Content $table
} catch {
    "declared: could not be read ($($_.Exception.Message))" | Add-Content $table
}
'' | Add-Content $table
'| Route | Round trip | Declared | Declared from | Where the loop failed |' | Add-Content $table
'|---|---:|---:|---|---|' | Add-Content $table

foreach ($r in $wanted) {
  if ($r -eq 'asio' -and -not $asioBuilt) {
    '| ASIO | — | 8,00 ms (request) | assumed | skipped: this binary has no ASIO host (see Preconditions) |' | Add-Content $table
    "=== asio : skipped, the binary has no ASIO host" | Add-Content $raw
    continue
  }
  if ($r -eq 'asio' -and -not $asioOk) {
    "| ASIO | — | 8,00 ms (request) | assumed | skipped: '$AsioDevice' is not among the ASIO devices (see Preconditions) |" | Add-Content $table
    "=== asio : skipped, '$AsioDevice' not found" | Add-Content $raw
    continue
  }
  # One device pair per route: ASIO uses its own device on both sides (one driver, one clock); every
  # other route uses the interface. Appending instead of replacing once sent --input twice.
  $dev = if ($r -eq 'asio') { @('--input', $AsioDevice, '--output', $AsioDevice) } else { @('--input', $In, '--output', $Out) }
  $frames = if ($r -eq 'asio') { $AsioBuffer } else { $Buffer }
  $ch = if ($r -eq 'insert') { $InCh } else { $DirectInCh }
  $args = @('latency') + $dev + @('--in-ch', $ch, '--buffer', "$frames") + $plan[$r]
    # NOT `$out`: PowerShell is case-insensitive, so `$out` IS the `-Out` parameter (the output device)
    # and assigning the probe output over it fed the error text back in as a device name.
    $probe = (& $exe @args 2>&1 | Out-String)
    "=== $r : $exe $($args -join ' ')" | Add-Content $raw
    $probe.Trim() -split "`n" | ForEach-Object { $_ } | Add-Content $raw
    $ms = $null
    $why = ''
    try {
      $ms = [double](($probe.Trim() | ConvertFrom-Json).round_trip_ms)
    } catch {
      # The engine explains the failure on stderr; keep the sentence, not a stack.
      $line = ($probe -split "`n" | Where-Object { $_ -match 'no click came back|timed out|audio stream stopped|error' } | Select-Object -First 1)
      $why = if ($line) { $line.Trim() } else { 'the probe produced no JSON' }
    }
    # NOT `$host`: that is a read-only automatic variable in PowerShell.
    $routeName = switch ($r) { 'exclusive' { 'WASAPI Exclusive' } 'shared' { 'WASAPI (shared)' } 'insert' { 'Voicemeeter Insert' } 'asio' { 'ASIO' } }
    $d = if ($declaredMs.ContainsKey($routeName)) { '{0:N2} ms' -f $declaredMs[$routeName] } else { '—' }
    $from = if ($declaredFrom.ContainsKey($routeName)) { $declaredFrom[$routeName] } else { '—' }
    $m = if ($null -ne $ms) { '{0:N2} ms' -f $ms } else { '—' }
    $w = $why.Replace('|', '\|')
    "| $routeName | $m | $d | $from | $w |" | Add-Content $table
    '' | Add-Content $raw
}

'--- (rest is the raw engine output of every probe; the table above is the summary)' | Add-Content $table
'' | Add-Content $table
"raw output: $raw" | Add-Content $table
Get-Content $table
