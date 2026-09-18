<#
.SYNOPSIS
  Package apps/tv-tizen/dist into a Tizen .wgt and (optionally) install it on the TV.

.DESCRIPTION
  1. Requires a prior `pnpm build` (dist/ must exist).
  2. Copies config.xml + icon.png into dist/.
  3. If Tizen Studio CLI is present ($env:USERPROFILE\tizen-studio\tools\ide\bin\tizen.bat)
      -> `tizen package -t wgt -s <Profile> -- dist` (signed with author-signature.xml +
          signature1.xml, installable on a TV in Developer Mode).
     Else -> UNSIGNED dist/MixAITV.wgt via Compress-Archive + instructions to sign.
  4. With -Install (and sdb available) -> `sdb connect <TvIp>; sdb install <wgt>`.

.PARAMETER Profile   Tizen security profile name (default: $env:TIZEN_PROFILE or "mixai";
                            created by scripts/setup-tizen-cert.ps1).
.PARAMETER TvIp      TV/monitor LAN IP (default: 192.168.100.135).
.PARAMETER Install   Try sdb connect + install after packaging.
#>
[CmdletBinding()]
param(
     [string]$Profile = $(if ($env:TIZEN_PROFILE) { $env:TIZEN_PROFILE } else { "mixai" }),
    [string]$TvIp = "192.168.100.135",
    [switch]$Install
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$wgtName = "MixAITV.wgt"

if (-not (Test-Path (Join-Path $dist "index.html"))) {
    Write-Error "dist/index.html missing - run 'pnpm build' in apps/tv-tizen first."
}

Copy-Item (Join-Path $root "config.xml") (Join-Path $dist "config.xml") -Force
if (Test-Path (Join-Path $root "icon.png")) { Copy-Item (Join-Path $root "icon.png") (Join-Path $dist "icon.png") -Force }

# Tizen web runtime resolves relative asset URLs against the widget root; Vite's
# `base: './'` already produces ./assets/..., so nothing to rewrite.

$studioBat = Join-Path $env:USERPROFILE "tizen-studio\tools\ide\bin\tizen.bat"
$studioSdb = Join-Path $env:USERPROFILE "tizen-studio\tools\sdb.exe"
$tizenCmd = Get-Command tizen -ErrorAction SilentlyContinue
$sdbCmd = Get-Command sdb -ErrorAction SilentlyContinue
$tizenExe = if ($tizenCmd) { $tizenCmd.Source } elseif (Test-Path $studioBat) { $studioBat } else { $null }
$sdbExe = if ($sdbCmd) { $sdbCmd.Source } elseif (Test-Path $studioSdb) { $studioSdb } else { $null }

Write-Host "tizen CLI : $(if ($tizenExe) { $tizenExe } else { 'NOT FOUND' })"
Write-Host "sdb       : $(if ($sdbExe) { $sdbExe } else { 'NOT FOUND' })"

$wgtPath = Join-Path $dist $wgtName
$signed = $false

if ($tizenExe) {
    Write-Host "Packaging with Tizen Studio (profile '$Profile')..."
    Get-ChildItem $dist -Filter *.wgt | Remove-Item -Force
    # Stale signatures from a previous run make `tizen package` fail verification.
    Get-ChildItem $dist -Include "author-signature.xml", "signature*.xml", ".manifest.tmp" -Recurse | Remove-Item -Force -ErrorAction SilentlyContinue
    & $tizenExe package -t wgt -s $Profile -- $dist
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "tizen package failed (exit $LASTEXITCODE). Create the security profile first:"
        Write-Warning "  pwsh -File apps/tv-tizen/scripts/setup-tizen-cert.ps1   (author cert + profile '$Profile')"
        Write-Warning "  (for a Samsung TV outside Developer Mode you also need a Samsung distributor cert with the TV DUID)"
    } else {
        $produced = Get-ChildItem $dist -Filter *.wgt | Select-Object -First 1
        if ($produced -and $produced.Name -ne $wgtName) { Move-Item $produced.FullName $wgtPath -Force }
        # Verify the archive really carries both signatures.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zipRead = [System.IO.Compression.ZipFile]::OpenRead($wgtPath)
        try { $names = $zipRead.Entries | ForEach-Object { $_.FullName } } finally { $zipRead.Dispose() }
        $signed = ($names -contains "author-signature.xml") -and ($names -contains "signature1.xml")
        if ($signed) {
            Write-Host "SIGNED package: $wgtPath  ($([math]::Round((Get-Item $wgtPath).Length / 1KB)) KB) [author-signature.xml + signature1.xml]"
        } else {
            Write-Warning "tizen package succeeded but signatures are missing in $wgtPath - falling back to unsigned."
        }
    }
}

if (-not $signed) {
    Write-Host "Producing UNSIGNED $wgtName via Compress-Archive (Tizen Studio not available or signing failed)..."
    if (Test-Path $wgtPath) { Remove-Item $wgtPath -Force }
    $zip = Join-Path $dist "MixAITV.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    $items = Get-ChildItem $dist | Where-Object { $_.Name -notin @("MixAITV.zip", $wgtName) }
    Compress-Archive -Path ($items | ForEach-Object { $_.FullName }) -DestinationPath $zip -CompressionLevel Optimal
    Move-Item $zip $wgtPath -Force
    Write-Host ""
    Write-Host "UNSIGNED package: $wgtPath  ($([math]::Round((Get-Item $wgtPath).Length / 1KB)) KB)"
    Write-Host "Samsung TVs refuse unsigned widgets. To sign + install:"
    Write-Host "  1. Install Tizen Studio (https://developer.tizen.org/development/tizen-studio/download) + 'TV Extensions' + 'Samsung Certificate Extension'."
    Write-Host "  2. Certificate Manager -> new Samsung certificate -> add the TV DUID (sdb shell 0 getduid)."
    Write-Host "  3. Re-run this script: it will use tizen.bat automatically."
    Write-Host "  Alternative: Apps2Samsung / Tizen Studio 'Run As > Tizen Web Application' on the dist/ folder."
}

$installTarget = $wgtPath
if ($Install) {
    if (-not $sdbExe) {
        Write-Warning "sdb not found - cannot install. Install Tizen Studio, then: sdb connect $TvIp ; sdb install `"$installTarget`""
        exit 0
    }
    Write-Host "sdb connect $TvIp ..."
    $out = & $sdbExe connect $TvIp 2>&1
    Write-Host $out
    if ($out -match "connected to") {
        & $sdbExe install $installTarget
        Write-Host "sdb install exit: $LASTEXITCODE"
    } else {
        Write-Warning "sdb connect failed. On the monitor: Apps -> type 1 2 3 4 5 on the remote -> Developer mode ON, Host PC IP = your PC IP (e.g. 192.168.100.61) -> reboot the monitor, then retry."
    }
} else {
    Write-Host ""
    Write-Host "Install manually: sdb connect $TvIp ; sdb install `"$installTarget`""
}
