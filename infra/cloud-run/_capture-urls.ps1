[CmdletBinding()]
param([string]$Project = 'mmo-mw-prod')
$ErrorActionPreference = 'Stop'

$services = @(
    @{ name = 'mmo-ace-step';  region = 'europe-west4'; var = 'GCP_ACESTEP_URL' },
    @{ name = 'mmo-demucs';    region = 'europe-west4'; var = 'GCP_DEMUCS_URL' },
    @{ name = 'mmo-voice-tts'; region = 'europe-west4'; var = 'GCP_VOICE_TTS_URL' },
    @{ name = 'mmo-rvc';       region = 'europe-west4'; var = 'GCP_RVC_URL' },
    @{ name = 'mmo-piper';     region = 'europe-west1'; var = 'GCP_PIPER_URL' }
)

$urls = [ordered]@{}
foreach ($s in $services) {
    $name = $s.name; $region = $s.region
    $u = & gcloud run services describe $name --project=$Project --region=$region --format='value(status.url)'
    if ($LASTEXITCODE -eq 0 -and $u) { $urls[$name] = ($u | Out-String).Trim() }
    else { Write-Warning "[$name] no URL (exit=$LASTEXITCODE)" }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $root '../..')
$jsonFile = Join-Path $root '.deploy-urls.json'
$urls | ConvertTo-Json | Set-Content -Path $jsonFile -Encoding UTF8
Write-Host "Wrote $jsonFile" -ForegroundColor Green
Get-Content $jsonFile

$envFile = Join-Path $repoRoot 'app/.env.local'
$existing = [ordered]@{}
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $existing[$Matches[1]] = $Matches[2] }
    }
}
foreach ($s in $services) {
    if ($urls.Contains($s.name)) {
        $existing[$s.var] = $urls[$s.name]
        Write-Host ("  {0,-22} = {1}" -f $s.var, $urls[$s.name]) -ForegroundColor Green
    }
}
if (-not $existing.Contains('GCP_PROJECT_ID')) { $existing['GCP_PROJECT_ID'] = $Project }
if (-not $existing.Contains('GCS_BUCKET_GENERATED')) { $existing['GCS_BUCKET_GENERATED'] = 'mmo-generated-prod' }

$existing.GetEnumerator() | Sort-Object Key | ForEach-Object { "$($_.Key)=$($_.Value)" } | Set-Content -Path $envFile -Encoding UTF8
Write-Host "Wrote $envFile" -ForegroundColor Green
