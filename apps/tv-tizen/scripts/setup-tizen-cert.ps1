<#
.SYNOPSIS
  Create the MixAI Tizen author certificate + security profile non-interactively.

.DESCRIPTION
  - Generates a random password and stores it ONLY in
    $env:USERPROFILE\tizen-studio-data\mixai-cert.env (outside the repo). Never printed.
  - `tizen certificate` -> author p12 (mixai_author.p12)
  - `tizen security-profiles add -n <Profile>` with the Tizen default distributor cert
    (enough for sideload on a TV in Developer Mode).
  Idempotent: re-running reuses the stored password and re-creates the profile.

.PARAMETER Profile  Security profile name (default: mixai).
.PARAMETER Force    Recreate the author certificate even if the .p12 exists.
#>
[CmdletBinding()]
param(
    [string]$Profile = "mixai",
    [switch]$Force
)
$ErrorActionPreference = "Stop"

$studio = Join-Path $env:USERPROFILE "tizen-studio"
$tizen = Join-Path $studio "tools\ide\bin\tizen.bat"
if (-not (Test-Path $tizen)) { throw "tizen.bat not found at $tizen - install Tizen Studio (CLI) first." }

$dataDir = Join-Path $env:USERPROFILE "tizen-studio-data"
$envFile = Join-Path $dataDir "mixai-cert.env"
$alias = "MixAI"
$fileName = "mixai_author"
$authorDir = Join-Path $dataDir "keystore\author"
$p12 = Join-Path $authorDir "$fileName.p12"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -like "TIZEN_CERT_PASSWORD=*" } | Select-Object -First 1
    $pass = if ($line) { $line.Substring("TIZEN_CERT_PASSWORD=".Length) } else { $null }
}
if (-not $pass) {
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $pass = [Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', 'x'
    [IO.File]::WriteAllText($envFile, "TIZEN_CERT_PASSWORD=$pass`nTIZEN_PROFILE=$Profile`nTIZEN_AUTHOR_P12=$p12`n")
    Write-Host "Password generated -> $envFile (not displayed)"
} else {
    Write-Host "Reusing password from $envFile"
}

if ($Force -or -not (Test-Path $p12)) {
    if (Test-Path $p12) { Remove-Item $p12 -Force }
    Write-Host "Creating author certificate ($alias)..."
    & $tizen certificate -a $alias -p $pass -c RO -s Bucharest -ct Bucharest -o MixAI -n MixAI -e dev@mixai.ro -f $fileName 2>&1 |
        ForEach-Object { $_ -replace [regex]::Escape($pass), '********' }
    if ($LASTEXITCODE -ne 0) { throw "tizen certificate failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "Author certificate exists: $p12"
}
if (-not (Test-Path $p12)) { throw "Expected $p12 after 'tizen certificate'" }

Write-Host "Adding security profile '$Profile'..."
& $tizen security-profiles remove -n $Profile 2>&1 | Out-Null
& $tizen security-profiles add -n $Profile -a $p12 -p $pass 2>&1 |
    ForEach-Object { $_ -replace [regex]::Escape($pass), '********' }
if ($LASTEXITCODE -ne 0) { throw "tizen security-profiles add failed (exit $LASTEXITCODE)" }

# `tizen package -s <profile>` only finds the profile if the CLI config points at profiles.xml.
$profilesXml = Join-Path $dataDir "profile\profiles.xml"
& $tizen cli-config "profiles.path=$profilesXml" | Out-Null

Write-Host ""
& $tizen security-profiles list
Write-Host ""
Write-Host "Done. Package with: pnpm package   (profile '$Profile')"
