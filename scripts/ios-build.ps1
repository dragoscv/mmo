<#
.SYNOPSIS
  Build / test / sign / TestFlight-upload the MixAI iPhone app (apps/ios) on the devcloud macOS VM vmui-mac.
  Port of codai scripts/ops/ios-build.ps1 (WP16-47).

.DESCRIPTION
  Ships the COMMITTED apps/ios tree at -Ref (git archive, never the dirty working tree) to the guest over Tailscale
  SSH, then runs apps/ios/scripts/build.sh there. For signed modes the App Store Connect API key is read from Secret
  Manager (project dragos-devcloud), copied to the guest as a 0600 file and deleted in the same remote command;
  nothing secret is printed or written into the repo. Runbook: E:\gh\codai\docs\runbooks\apple-publishing.md.

  Before Apple calls the guest clock must be right (GCE suspend/resume freezes it): the script refuses a skew > 120 s.
  Keep the VM awake for the whole build (hold an SSH session; the host idle timer suspends it otherwise).

.EXAMPLE
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode test
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode build
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode devipa      # development-signed ro.mixai.app for registered devices
  pwsh -NoProfile -File scripts/ios-build.ps1 -Mode upload -Ref origin/main
#>
[CmdletBinding()]
param(
  [ValidateSet('test', 'build', 'devipa', 'upload')] [string]$Mode = 'build',
  [string]$Ref = 'HEAD',
  [string]$GuestHost = '100.106.244.19',
  [int]$GuestPort = 10022,
  [string]$GuestUser = 'dragos',
  [string]$Key = (Join-Path $HOME '.ssh\id_ed25519_macvm'),
  [string]$Project = 'dragos-devcloud',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$repo = (git rev-parse --show-toplevel).Trim()
$sha = (git -C $repo rev-parse --short=12 "$Ref^{commit}").Trim()
$tmp = Join-Path $repo ".copilot-tmp\ios-build\$sha"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-i', $Key, '-p', "$GuestPort")
$target = "$GuestUser" + [char]64 + "$GuestHost"

function Invoke-Guest([string]$cmd) {
  & ssh @ssh $target $cmd
  if ($LASTEXITCODE -ne 0) { throw "guest command failed ($LASTEXITCODE): $($cmd.Split(';')[0])" }
}

$signed = $Mode -in @('upload', 'devipa')
if ($signed) {
  $names = @(gcloud secrets list --project $Project --filter='name~apple-' --format='value(name)' 2>$null) | ForEach-Object { ($_ -split '/')[-1] }
  $missing = @('apple-asc-key-p8', 'apple-asc-key-id', 'apple-asc-issuer', 'apple-team-id') | Where-Object { $names -notcontains $_ }
  if ($missing) { throw "missing secrets in ${Project}: $($missing -join ', ')" }
}

if (-not $NoStart) {
  $st = (gcloud compute instances describe vmui-mac --zone europe-central2-a --project dragos-devcloud --format='value(status)' 2>$null)
  if ($st -eq 'SUSPENDED') {
    Write-Host 'vmui-mac is SUSPENDED -> resuming'
    gcloud compute instances resume vmui-mac --zone europe-central2-a --project dragos-devcloud --quiet
  } elseif ($st -ne 'RUNNING') {
    Write-Host "vmui-mac is $st -> starting"
    & pwsh -NoProfile -File 'E:\gh\vmui\infra\devcloud\mac\mac-gce.ps1' -Start
  }
}
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
  & ssh @ssh $target 'true' 2>$null
  $ok = $LASTEXITCODE -eq 0
  if (-not $ok) { Start-Sleep -Seconds 10 }
}
if (-not $ok) { throw "guest ssh not reachable at ${GuestHost}:$GuestPort" }

$guestEpoch = [long]((& ssh @ssh $target 'date -u +%s') | Select-Object -Last 1)
$skew = [math]::Abs($guestEpoch - [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
if ($signed -and $skew -gt 120) { throw "guest clock is off by $skew s - run 'sudo sntp -sS time.apple.com' on the Mac first" }

# Committed tree only: an iOS build must name exactly one commit. autocrlf=false keeps LF in build.sh.
$tar = Join-Path $tmp 'ios.tar'
git -C $repo -c core.autocrlf=false archive --format=tar -o $tar "${sha}:apps/ios"
$remote = "mixai-ios/$sha"
& ssh @ssh $target "mkdir -p ~/mixai-ios && find ~/mixai-ios -mindepth 1 -maxdepth 1 -type d -mmin +1440 -exec rm -rf {} +" 2>$null
$freeGb = [int]((& ssh @ssh $target "df -g /System/Volumes/Data | awk 'NR==2{print `$4}'") | Select-Object -Last 1)
Write-Host "vmui-mac free: $freeGb GB"
if ($freeGb -lt 8) { throw "vmui-mac has only $freeGb GB free (need 8): delete finished ~/mixai-ios / ~/codai-ios trees" }
Invoke-Guest "rm -rf ~/$remote && mkdir -p ~/$remote"
& scp -q -o BatchMode=yes -i $Key -P $GuestPort $tar "${target}:$remote/ios.tar"
if ($LASTEXITCODE -ne 0) { throw 'scp failed' }
Invoke-Guest "cd ~/$remote && tar -xf ios.tar && rm ios.tar && chmod +x scripts/*.sh"

$log = Join-Path $tmp "$Mode.log"
$build = (git -C $repo rev-list --count $sha).Trim()
if (-not $signed) {
  & ssh @ssh $target "cd ~/$remote && BUILD_NUMBER=$build ./scripts/build.sh $Mode" *>&1 | Tee-Object -FilePath $log
  $rc = $LASTEXITCODE
} else {
  $p8 = Join-Path $tmp 'k.p8'
  try {
    gcloud secrets versions access latest --secret=apple-asc-key-p8 --project $Project --out-file=$p8 2>$null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $p8)) { throw 'secret apple-asc-key-p8 missing' }
    $kid = (gcloud secrets versions access latest --secret=apple-asc-key-id --project $Project 2>$null).Trim()
    $iss = (gcloud secrets versions access latest --secret=apple-asc-issuer --project $Project 2>$null).Trim()
    $team = (gcloud secrets versions access latest --secret=apple-team-id --project $Project 2>$null).Trim()
    if ($kid -notmatch '^[A-Z0-9]{8,12}$' -or $team -notmatch '^[A-Z0-9]{10}$' -or $iss -notmatch '^[0-9a-f-]{36}$') { throw 'ASC ids have an unexpected shape' }
    & scp -q -o BatchMode=yes -i $Key -P $GuestPort $p8 "${target}:$remote/.k.p8"
    if ($LASTEXITCODE -ne 0) { throw 'scp key failed' }
  } finally {
    Remove-Item $p8 -Force -ErrorAction SilentlyContinue
  }
  # ids are not secret (key id / issuer / team); the .p8 is, and it is removed whatever build.sh returns.
  $cmd = "cd ~/$remote && chmod 600 .k.p8 && DEVELOPMENT_TEAM=$team ASC_KEY_ID=$kid ASC_ISSUER_ID=$iss ASC_KEY_PATH=`$PWD/.k.p8 BUILD_NUMBER=$build ./scripts/build.sh $Mode; rc=`$?; rm -f .k.p8; exit `$rc"
  & ssh @ssh $target $cmd *>&1 | Tee-Object -FilePath $log
  $rc = $LASTEXITCODE
  if ($rc -eq 0 -and $Mode -eq 'devipa') {
    $ipa = Join-Path $tmp 'mixai-dev.ipa'
    & scp -q -o BatchMode=yes -i $Key -P $GuestPort "${target}:$remote/build/mixai-dev.ipa" $ipa
    $rc = $LASTEXITCODE
    if ($rc -eq 0) { Write-Host "IPA: $ipa ($([math]::Round((Get-Item $ipa).Length / 1MB, 1)) MB)" }
  }
}
if ($rc -eq 0) { & ssh @ssh $target "rm -rf ~/$remote" 2>$null }
Write-Host "ios-build $Mode @ $sha -> rc=$rc (log $log)"
exit $rc
