# Fetches Apple's ShazamKit for Android AAR (not redistributable, never committed) from the private vendor bucket into
# apps/keybpm-android/app/libs/. Builds without it compile the src/noshazam stub and hide Song ID.
param(
    [string]$Version = '2.1.1',
    [string]$Sha256 = 'E85310C6737F1025A3B0F7852FA73F06840FAD5B484EA38CA4912D5D8AD2BC86',
    [string]$Bucket = 'gs://mmo-mw-prod_cloudbuild/vendor/shazamkit'
)
$ErrorActionPreference = 'Stop'
$dest = Join-Path $PSScriptRoot '..\app\libs\shazamkit-android-release.aar'
New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
if ((Test-Path $dest) -and (Get-FileHash $dest).Hash -eq $Sha256) { "shazamkit $Version already present"; exit 0 }
gcloud storage cp "$Bucket/$Version/shazamkit-android-release.aar" $dest --project mmo-mw-prod
if ($LASTEXITCODE -ne 0) { throw "gcloud storage cp failed ($LASTEXITCODE)" }
$h = (Get-FileHash $dest).Hash
if ($h -ne $Sha256) { Remove-Item $dest; throw "sha256 mismatch: $h" }
"shazamkit $Version -> $dest"
