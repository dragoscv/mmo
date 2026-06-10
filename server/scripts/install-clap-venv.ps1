# Create a per-engine Python venv for CLAP audio embeddings.
#
# Companion engines use one venv per engine to avoid CUDA + transformer
# version conflicts (CLAP needs transformers≥4.45 + numpy<2; XTTS pins
# transformers<4.30 + numpy<1.24, so they cannot coexist).
#
#   pwsh server/scripts/install-clap-venv.ps1
#
# Tested on Windows 11 + Python 3.11. The companion's engine config
# (server/src/voice/engines/clap.ts) reads PYTHON_BIN from .venvs/clap.

param(
    [string]$VenvDir = ".venvs/clap",
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$serverRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$venvAbs = Join-Path $serverRoot $VenvDir

Write-Host "=== Creating CLAP venv at $venvAbs ===" -ForegroundColor Cyan
if (Test-Path $venvAbs) {
    Write-Host "Venv already exists — re-using." -ForegroundColor Yellow
} else {
    & $Python -m venv $venvAbs
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}

$venvPy = Join-Path $venvAbs "Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    # Linux/macOS layout (in case anyone runs this on a VM)
    $venvPy = Join-Path $venvAbs "bin/python"
}

Write-Host "Installing torch (CPU-only by default; pass --gpu for CUDA)…" -ForegroundColor Cyan
if ($args -contains "--gpu") {
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cu124
} else {
    & $venvPy -m pip install --upgrade pip
    & $venvPy -m pip install torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu
}
if ($LASTEXITCODE -ne 0) { throw "torch install failed" }

Write-Host "Installing transformers + audio libs…" -ForegroundColor Cyan
& $venvPy -m pip install `
    transformers==4.45.2 `
    soundfile==0.12.1 `
    librosa==0.10.2 `
    "numpy<2.0"
if ($LASTEXITCODE -ne 0) { throw "deps install failed" }

Write-Host "Pre-downloading CLAP weights (one-time, ~1.5 GB)…" -ForegroundColor Cyan
& $venvPy -c "from transformers import ClapModel, ClapProcessor; ClapModel.from_pretrained('laion/larger_clap_music_and_speech'); ClapProcessor.from_pretrained('laion/larger_clap_music_and_speech'); print('OK')"
if ($LASTEXITCODE -ne 0) { throw "weights download failed" }

Write-Host ""
Write-Host "CLAP venv ready: $venvAbs" -ForegroundColor Green
Write-Host "Set in server/.env or per-engine config:" -ForegroundColor Yellow
Write-Host "  CLAP_PYTHON_BIN=$venvPy"
