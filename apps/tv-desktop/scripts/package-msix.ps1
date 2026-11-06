<#
.SYNOPSIS
  Builds the MixAI TV MSIX for the Microsoft Store (WP17-25).
.DESCRIPTION
  Tauri 2 bundles NSIS/WiX only, so the MSIX is assembled here from the release exe:
    1. stage target\release\mixai-tv.exe + icons into msix-out\layout
    2. render packaging\msix\AppxManifest.xml with the Partner Center identity
    3. makeappx pack -> msix-out\MixAITV_<ver>_x64.msix
    4. -TestSign: sign with a throwaway self-signed cert (subject = -Publisher) for local sideload tests.
  The Store re-signs uploads, so the submitted package stays unsigned.
.PARAMETER IdentityName   Package/Identity/Name from Partner Center (e.g. 12345MixAI.MixAITV).
.PARAMETER Publisher      Package/Identity/Publisher from Partner Center (e.g. CN=XXXXXXXX-....).
#>
param(
    [string]$IdentityName = 'DragosCatalin.MixAITV',
    [string]$Publisher = 'CN=FE8B5839-E0F9-495F-854C-53165710EB07',
    [string]$PublisherDisplay = 'Dragos Catalin',
    [switch]$TestSign
)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$conf = Get-Content (Join-Path $app 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$ver = ($conf.version -split '[.-]')[0..2] -join '.'
$msixVer = "$ver.0"
$exe = Join-Path $app 'src-tauri\target\release\mixai-tv.exe'
if (-not (Test-Path $exe)) { throw "missing $exe - run 'pnpm tauri build --no-bundle' first" }

$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object Name -match '^10\.' | Sort-Object Name -Descending
$makeappx = $kits | ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
$signtool = $kits | ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found (install the Windows 10/11 SDK)' }

$out = Join-Path $app 'msix-out'
$layout = Join-Path $out 'layout'
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $layout 'Assets') | Out-Null
Copy-Item $exe $layout
$icons = Join-Path $app 'src-tauri\icons'
foreach ($n in 'StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png', 'Square310x310Logo.png') {
    $src = Join-Path $icons $n
    if (-not (Test-Path $src)) { throw "missing icon $src - run 'pnpm tauri icon <png>'" }
    Copy-Item $src (Join-Path $layout "Assets\$n")
}
$manifest = Get-Content (Join-Path $app 'packaging\msix\AppxManifest.xml') -Raw
$manifest = $manifest.Replace('__IDENTITY_NAME__', $IdentityName).Replace('__PUBLISHER__', $Publisher).Replace('__PUBLISHER_DISPLAY__', $PublisherDisplay).Replace('__VERSION__', $msixVer)
[IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

$msix = Join-Path $out "MixAITV_${msixVer}_x64.msix"
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /o /d $layout /p $msix | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

if ($TestSign) {
    if (-not $signtool) { throw 'signtool.exe not found' }
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName 'MixAI TV MSIX test' `
            -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    }
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $msix | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
}
$size = [math]::Round((Get-Item $msix).Length / 1MB, 1)
"MSIX=$msix ($size MB, identity $IdentityName, version $msixVer, signed=$([bool]$TestSign))"
