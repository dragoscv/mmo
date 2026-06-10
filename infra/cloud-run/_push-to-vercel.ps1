[CmdletBinding()]
param(
    [string[]]$Environments = @('production', 'preview'),
    [string]$AppDir = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '../../app')
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$urls = Get-Content (Join-Path $root '.deploy-urls.json') | ConvertFrom-Json

$vars = [ordered]@{
    GCP_ACESTEP_URL      = $urls.'mmo-ace-step'
    GCP_DEMUCS_URL       = $urls.'mmo-demucs'
    GCP_VOICE_TTS_URL    = $urls.'mmo-voice-tts'
    GCP_RVC_URL          = $urls.'mmo-rvc'
    GCP_PIPER_URL        = $urls.'mmo-piper'
    GCP_PROJECT_ID       = 'mmo-mw-prod'
    GCS_BUCKET_GENERATED = 'mmo-generated-prod'
}

Push-Location $AppDir
try {
    foreach ($env in $Environments) {
        Write-Host "=== Vercel env: $env ===" -ForegroundColor Cyan
        foreach ($k in $vars.Keys) {
            $v = $vars[$k]
            if (-not $v) { Write-Warning "[$k] empty, skipping"; continue }
            # Remove existing value (ignore failure when not present).
            & vercel env rm $k $env --yes 2>$null | Out-Null
            # Add fresh value via stdin.
            $v | & vercel env add $k $env 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warning "[$k] add failed (exit $LASTEXITCODE)" }
            else { Write-Host ("  OK  {0,-22} = {1}" -f $k, $v) -ForegroundColor Green }
        }
    }
} finally { Pop-Location }
Write-Host "Done." -ForegroundColor Green
