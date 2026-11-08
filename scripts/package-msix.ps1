<#
.SYNOPSIS
  Shared MSIX packager for the MixAI Tauri desktop apps (WP17-25 / 50 / 51): TV, Studio, DJ.
.DESCRIPTION
  Tauri 2 bundles NSIS/WiX only, so the MSIX is assembled from the release exe:
    1. stage <exe> + Store icons (src-tauri/icons) into <out>\layout
    2. render scripts/msix/AppxManifest.template.xml with the Partner Center identity + display strings
    3. makeappx pack -> <out>\<FilePrefix>_<ver>_x64.msix (unsigned; the Store signs it)
    4. -TestSign: sign with a throwaway self-signed cert (subject = -Publisher) for local sideload tests.
.EXAMPLE
  pwsh -NoProfile -File scripts/package-msix.ps1 -App apps/native -Exe mmo-native.exe -IdentityName DragosCatalin.MixAIStudio `
    -DisplayName 'MixAI Studio' -Description 'Organise and prepare your music library' -FilePrefix MixAIStudio -AppId MixAIStudio
#>
param(
    [Parameter(Mandatory)][string]$App,
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$IdentityName,
    [Parameter(Mandatory)][string]$DisplayName,
    [Parameter(Mandatory)][string]$Description,
    [Parameter(Mandatory)][string]$FilePrefix,
    [Parameter(Mandatory)][string]$AppId,
    [string]$Publisher = 'CN=FE8B5839-E0F9-495F-854C-53165710EB07',
    [string]$PublisherDisplay = 'Dragos Catalin',
    [string]$TargetDir = '',
    [string]$Protocol = '',
    [switch]$LanServer,
    [switch]$TestSign
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$appDir = if ([IO.Path]::IsPathRooted($App)) { $App } else { Join-Path $repo $App }
$conf = Get-Content (Join-Path $appDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$ver = ($conf.version -split '[.-]')[0..2] -join '.'
$msixVer = "$ver.0"
$target = if ($TargetDir) { $TargetDir } else { Join-Path $appDir 'src-tauri\target' }
$exePath = Join-Path $target "release\$Exe"
if (-not (Test-Path $exePath)) { throw "missing $exePath - run 'pnpm tauri build --no-bundle' first" }

$kits = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object Name -match '^10\.' | Sort-Object Name -Descending
$makeappx = $kits | ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
$signtool = $kits | ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makeappx) { throw 'makeappx.exe not found (install the Windows 10/11 SDK)' }

$out = Join-Path $appDir 'msix-out'
$layout = Join-Path $out 'layout'
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $layout 'Assets') | Out-Null
Copy-Item $exePath $layout
$icons = Join-Path $appDir 'src-tauri\icons'
foreach ($n in 'StoreLogo.png', 'Square150x150Logo.png', 'Square44x44Logo.png', 'Square310x310Logo.png') {
    $src = Join-Path $icons $n
    if (-not (Test-Path $src)) { throw "missing icon $src - run 'pnpm tauri icon <png>'" }
    Copy-Item $src (Join-Path $layout "Assets\$n")
}
$lan = if ($LanServer) { '        <Capability Name="privateNetworkClientServer" />' } else { '' }
if ($Protocol -and $Protocol -notmatch '^[a-z][a-z0-9-]{1,38}$') { throw "invalid -Protocol '$Protocol'" }
$proto = if ($Protocol) {
  "            <Extensions>`n                <uap:Extension Category=`"windows.protocol`">`n                    <uap:Protocol Name=`"$Protocol`" />`n                </uap:Extension>`n            </Extensions>"
} else { '' }
$manifest = Get-Content (Join-Path $PSScriptRoot 'msix\AppxManifest.template.xml') -Raw
$map = @{
    '__IDENTITY_NAME__' = $IdentityName; '__PUBLISHER__' = $Publisher; '__PUBLISHER_DISPLAY__' = $PublisherDisplay
    '__VERSION__' = $msixVer; '__DISPLAY_NAME__' = $DisplayName; '__DESCRIPTION__' = $Description
    '__EXE__' = $Exe; '__APP_ID__' = $AppId
}
foreach ($k in $map.Keys) { $manifest = $manifest.Replace($k, [Security.SecurityElement]::Escape($map[$k])) }
  $manifest = $manifest.Replace('__LAN_CAPABILITY__', $lan)
$manifest = $manifest.Replace('__EXTENSIONS__', $proto)
[IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

$msix = Join-Path $out "${FilePrefix}_${msixVer}_x64.msix"
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /o /d $layout /p $msix | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
if ($TestSign) {
    if (-not $signtool) { throw 'signtool.exe not found' }
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName 'MixAI MSIX test' `
            -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    }
    & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $msix | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
}
"MSIX=$msix ($([math]::Round((Get-Item $msix).Length / 1MB, 1)) MB, identity $IdentityName, version $msixVer, signed=$([bool]$TestSign))"
