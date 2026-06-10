<#
.SYNOPSIS
  Train an ACE-Step LoRA on a user's audio corpus, tuned for 8GB VRAM (RTX 3060 Ti).

.DESCRIPTION
  Wraps the upstream ACE-Step trainer at external/ACE-Step/trainer.py.

  Expected dataset layout (raw):
    <DataDir>/
      track001.mp3
      track001_prompt.txt   # comma-separated tags (genre, instruments, mood, bpm…)
      track001_lyrics.txt   # optional but recommended
      track002.mp3
      …

  This script:
    1. Runs convert2hf_dataset.py → builds a HuggingFace dataset on disk
    2. Launches trainer.py with the small-VRAM LoRA config + bf16 + grad accum
    3. Checkpoints land under <OutDir>/exps/<ExpName>/

  Resulting LoRA weights can be loaded by the ACE-Step sidecar via the
  loraPath / loraWeight args on /voice/engines/ace-step/song.

.PARAMETER DataDir
  Directory containing the raw <name>.mp3 + <name>_prompt.txt files.

.PARAMETER ExpName
  Short experiment name (used for checkpoint dir + tensorboard).

.PARAMETER MaxSteps
  Hard cap on training steps. Default 5000 is enough for small style LoRAs.

.PARAMETER RepeatCount
  How many times the raw dataset is repeated when building the HF dataset.
  Use higher values for very small corpora (≤20 tracks).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $DataDir,
    [Parameter(Mandatory = $true)] [string] $ExpName,
    [int] $MaxSteps = 5000,
    [int] $RepeatCount = 200,
    [int] $EveryNTrainSteps = 500,
    [string] $LoraConfig = "$PSScriptRoot/../server/python/lora_configs/rtx3060ti_8gb.json",
    [string] $OutDir = "$PSScriptRoot/../data/lora-training"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path "$PSScriptRoot/.."
$aceRepo = Join-Path $repoRoot "external/ACE-Step"
$venvPy = Join-Path $repoRoot "server/python/.venvs/ace_step/Scripts/python.exe"

if (-not (Test-Path $aceRepo))   { throw "ACE-Step repo missing at $aceRepo (run: git clone https://github.com/ace-step/ACE-Step external/ACE-Step)" }
if (-not (Test-Path $venvPy))    { throw "ACE-Step venv missing at $venvPy" }
if (-not (Test-Path $DataDir))   { throw "Data dir not found: $DataDir" }
if (-not (Test-Path $LoraConfig)){ throw "LoRA config not found: $LoraConfig" }

$OutDir = (New-Item -ItemType Directory -Force -Path $OutDir).FullName
$datasetDir = Join-Path $OutDir "datasets/$ExpName"
$logDir     = Join-Path $OutDir "exps/$ExpName"
New-Item -ItemType Directory -Force -Path $datasetDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir     | Out-Null

# Important: DO NOT set PYTHONNOUSERSITE here — at runtime the venv must
# inherit base user-site torch/torchvision for CUDA + nms ops to resolve.
Remove-Item env:PYTHONNOUSERSITE -ErrorAction SilentlyContinue

Write-Host "── 1/2 Converting raw data → HF dataset" -ForegroundColor Cyan
Push-Location $aceRepo
try {
    & $venvPy "convert2hf_dataset.py" `
        --data_dir $DataDir `
        --repeat_count $RepeatCount `
        --output_name $datasetDir
    if ($LASTEXITCODE -ne 0) { throw "convert2hf_dataset.py failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host "── 2/2 Launching trainer (bf16, grad_accum=4, $MaxSteps steps)" -ForegroundColor Cyan
Push-Location $aceRepo
try {
    & $venvPy "trainer.py" `
        --exp_name $ExpName `
        --dataset_path $datasetDir `
        --lora_config_path $LoraConfig `
        --max_steps $MaxSteps `
        --every_n_train_steps $EveryNTrainSteps `
        --precision "bf16-mixed" `
        --accumulate_grad_batches 4 `
        --gradient_clip_val 0.5 `
        --learning_rate 1e-4 `
        --num_workers 2 `
        --devices 1 `
        --logger_dir (Join-Path $logDir "tb") `
        --checkpoint_dir (Join-Path $logDir "ckpts")
    if ($LASTEXITCODE -ne 0) { throw "trainer.py failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host ""
Write-Host "Done. Checkpoints: $logDir/ckpts" -ForegroundColor Green
Write-Host "Use the resulting .ckpt as the loraPath arg on POST /voice/engines/ace-step/song." -ForegroundColor Green
