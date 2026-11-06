<#
.SYNOPSIS
  MixAI TV for macOS — Mac App Store build/upload on vmui-mac (WP17-26; port of vitals scripts/macos-appstore.ps1).
.DESCRIPTION
  Ships the COMMITTED apps/tv-desktop + apps/tv-tizen (+ the icon source) at -Ref to the guest, fetches the
  MAC_APP_STORE profile, copies the signing .p12 files + ASC key from Secret Manager (dragos-devcloud) into a 0700 dir on
  the guest for the run only, and runs scripts/macos/build-appstore.sh. Nothing secret is printed.
.EXAMPLE
  pwsh -NoProfile -File apps/tv-desktop/scripts/macos-appstore.ps1 -Mode build
  pwsh -NoProfile -File apps/tv-desktop/scripts/macos-appstore.ps1 -Mode upload -AppleId <App Store app id>
#>
[CmdletBinding()]
param(
  [ValidateSet('build', 'upload')] [string]$Mode = 'build',
  [string]$Ref = 'HEAD',
  [string]$AppleId = '',
  [string]$GuestHost = '100.106.244.19',
  [int]$GuestPort = 10022,
  [string]$GuestUser = 'dragos',
  [string]$Key = (Join-Path $HOME '.ssh\id_ed25519_macvm'),
  [string]$Project = 'dragos-devcloud'
)
$ErrorActionPreference = 'Stop'
$repo = (git rev-parse --show-toplevel).Trim()
$sha = (git -C $repo rev-parse --short=12 "$Ref^{commit}").Trim()
$tmp = Join-Path $repo ".copilot-tmp\tv-macos\$sha"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$ssh = @('-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-i', $Key, '-p', "$GuestPort")
$scp = @('-q', '-o', 'BatchMode=yes', '-i', $Key, '-P', "$GuestPort")
$target = "$GuestUser" + [char]64 + "$GuestHost"
function Invoke-Guest([string]$cmd) {
  & ssh @ssh $target $cmd
  if ($LASTEXITCODE -ne 0) { throw "guest command failed ($LASTEXITCODE)" }
}
if ($Mode -eq 'upload' -and $AppleId -notmatch '^\d{9,12}$') { throw '-AppleId (numeric App Store app id) is required for upload' }

& ssh @ssh $target 'true' 2>$null
if ($LASTEXITCODE -ne 0) { throw "guest ssh not reachable at ${GuestHost}:$GuestPort (mac-gce.ps1 -Start)" }
$guestEpoch = [long]((& ssh @ssh $target 'date -u +%s') | Select-Object -Last 1)
$skew = [math]::Abs($guestEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
if ($skew -gt 120) { throw "guest clock is off by $skew s - run 'sudo sntp -sS time.apple.com' on the Mac" }
$freeGb = [int]((& ssh @ssh $target "df -g /System/Volumes/Data | awk 'NR==2{print `$4}'") | Select-Object -Last 1)
if ($freeGb -lt 10) { throw "vmui-mac has only $freeGb GB free (need 10)" }

# Same relative layout as the repo (tv-desktop imports ../tv-tizen/src and ../web/public/icon-512.png).
$tar = Join-Path $tmp 'tree.tar'
git -C $repo -c core.autocrlf=false -c core.eol=lf archive --format=tar -o $tar $sha -- apps/tv-desktop apps/tv-tizen apps/web/public/icon-512.png packages/design-tokens/dist
$remote = 'mixai-tv-mas'
Invoke-Guest "mkdir -p ~/$remote"
& scp @scp $tar "${target}:$remote/tree.tar"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
Invoke-Guest "cd ~/$remote && tar -xf tree.tar && rm tree.tar"

$prov = Join-Path $tmp 'embedded.provisionprofile'
node (Join-Path $repo 'apps\tv-desktop\scripts\macos\appstore-profile.mjs') $prov
if ($LASTEXITCODE -ne 0) { throw 'provisioning profile fetch failed' }
& scp @scp $prov "${target}:$remote/apps/tv-desktop/src-tauri/macos/embedded.provisionprofile"
if ($LASTEXITCODE -ne 0) { throw 'scp profile failed' }

function Get-SecretFile([string]$name, [string]$path) {
  gcloud secrets versions access latest --secret=$name --project $Project --out-file=$path 2>$null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $path)) { throw "secret $name missing" }
}
function Get-SecretText([string]$name) {
  $v = (gcloud secrets versions access latest --secret=$name --project $Project 2>$null)
  if ($LASTEXITCODE -ne 0) { throw "secret $name missing" }
  return ($v -join '').Trim()
}
function ConvertTo-Der([string]$path) {
  $b = [IO.File]::ReadAllBytes($path)
  if ($b.Length -gt 1 -and $b[0] -eq 0x30) { return }
  $txt = [Text.Encoding]::ASCII.GetString($b) -replace '\s', ''
  [IO.File]::WriteAllBytes($path, [Convert]::FromBase64String($txt))
}
$files = @{ dist = Join-Path $tmp 'd.p12'; inst = Join-Path $tmp 'i.p12'; pw = Join-Path $tmp 'pw'; p8 = Join-Path $tmp 'k.p8' }
try {
  Get-SecretFile 'apple-distribution-p12' $files.dist; ConvertTo-Der $files.dist
  Get-SecretFile 'apple-mac-installer-p12' $files.inst; ConvertTo-Der $files.inst
  Get-SecretFile 'apple-signing-p12-password' $files.pw
  Get-SecretFile 'apple-asc-key-p8' $files.p8
  $kid = Get-SecretText 'apple-asc-key-id'
  $iss = Get-SecretText 'apple-asc-issuer'
  $team = Get-SecretText 'apple-team-id'
  if ($kid -notmatch '^[A-Z0-9]{8,12}$' -or $team -notmatch '^[A-Z0-9]{10}$' -or $iss -notmatch '^[0-9a-f-]{36}$') { throw 'ASC ids have an unexpected shape' }
  Invoke-Guest "mkdir -p ~/$remote/.sec && chmod 700 ~/$remote/.sec"
  & scp @scp $files.dist $files.inst $files.pw $files.p8 "${target}:$remote/.sec/"
  if ($LASTEXITCODE -ne 0) { throw 'scp secrets failed' }
} finally {
  $files.Values | ForEach-Object { Remove-Item $_ -Force -ErrorAction SilentlyContinue }
}

$build = (git -C $repo rev-list --count $sha).Trim()
$log = Join-Path $tmp "$Mode.log"
$envs = "TEAM_ID=$team BUILD_NUMBER=$build APPLE_ID=$AppleId DIST_P12=`$S/d.p12 INSTALLER_P12=`$S/i.p12 ASC_KEY_ID=$kid ASC_ISSUER_ID=$iss ASC_KEY_PATH=`$S/k.p8"
$cmd = "export PATH=`$HOME/.local/bin:`$HOME/.cargo/bin:/opt/homebrew/bin:`$PATH; cd ~/$remote && S=`$PWD/.sec && chmod 600 `$S/* && P12_PASSWORD=`$(tr -d '\r\n' < `$S/pw) $envs bash apps/tv-desktop/scripts/macos/build-appstore.sh $Mode; rc=`$?; rm -rf `$S; exit `$rc"
& ssh @ssh $target $cmd *>&1 | Tee-Object -FilePath $log
$rc = $LASTEXITCODE
Write-Host "tv macos-appstore $Mode @ $sha (build $build) -> rc=$rc (log $log)"
exit $rc
