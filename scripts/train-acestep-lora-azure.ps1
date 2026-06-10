<#
.SYNOPSIS
  Submit an ACE-Step LoRA training job to Azure ML.

.DESCRIPTION
  Local sibling: scripts/train-acestep-lora.ps1 (RTX 3060 Ti, 8GB).
  This script uploads the prepared HuggingFace dataset to an Azure
  Datastore, then launches a CommandJob on an A100 / V100 cluster
  running the same external/ACE-Step/trainer.py.

  Prereqs:
    1. `az login`
    2. `pip install azure-ai-ml azure-identity`
    3. Subscription id, resource group, workspace name in env or args.
    4. A compute cluster (any GPU SKU); we recommend Standard_NC24ads_A100_v4.
    5. A custom env with: pytorch>=2.8 + transformers==4.50.3 + peft + pytorch-lightning + acestep.
       Build once:
         az ml environment create --file infra/azureml/acestep-env.yml -w <ws> -g <rg>

  Outputs land under `runs:/<jobName>/outputs/ckpts/*.ckpt`. Download
  with `az ml job download --name <jobName> -p ckpts`.

.PARAMETER DataDir
  Local path to the HF-formatted dataset (produced by convert2hf_dataset.py).

.PARAMETER ExpName
  Short experiment name (becomes Azure ML run display name).

.PARAMETER SubscriptionId / ResourceGroup / Workspace
  Azure ML resource coordinates. May be supplied via $env:AZUREML_*.

.PARAMETER Compute
  Compute cluster name. Defaults to "gpu-a100".

.PARAMETER MaxSteps
  Cap on training steps. Default 20000 (≈3h on A100).
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $DataDir,
    [Parameter(Mandatory = $true)] [string] $ExpName,
    [string] $SubscriptionId = $env:AZUREML_SUBSCRIPTION_ID,
    [string] $ResourceGroup  = $env:AZUREML_RESOURCE_GROUP,
    [string] $Workspace      = $env:AZUREML_WORKSPACE,
    [string] $Compute        = "gpu-a100",
    [string] $Environment    = "acestep-train:1",
    [int]    $MaxSteps       = 20000,
    [string] $LoraConfig     = "$PSScriptRoot/../server/python/lora_configs/rtx3060ti_8gb.json"
)

$ErrorActionPreference = "Stop"

foreach ($p in @("SubscriptionId","ResourceGroup","Workspace")) {
    if (-not (Get-Variable $p).Value) {
        throw "Missing -$p (or AZUREML_$($p.ToUpper().Replace('SUBSCRIPTIONID','SUBSCRIPTION_ID').Replace('RESOURCEGROUP','RESOURCE_GROUP').Replace('WORKSPACE','WORKSPACE')) env var)"
    }
}
if (-not (Test-Path $DataDir))   { throw "Data dir not found: $DataDir" }
if (-not (Test-Path $LoraConfig)){ throw "LoRA config not found: $LoraConfig" }

$repoRoot = Resolve-Path "$PSScriptRoot/.."
$aceRepo = Join-Path $repoRoot "external/ACE-Step"
if (-not (Test-Path $aceRepo)) {
    throw "External ACE-Step missing at $aceRepo. Run: git clone https://github.com/ace-step/ACE-Step $aceRepo"
}

# Write a transient YAML job spec next to the script.
$jobYaml = Join-Path $env:TEMP "acestep-job-$ExpName.yml"
$dataUri = (Resolve-Path $DataDir).Path -replace '\\','/'
$loraUri = (Resolve-Path $LoraConfig).Path -replace '\\','/'
$codeUri = (Resolve-Path $aceRepo).Path  -replace '\\','/'

@"
`$schema: https://azuremlschemas.azureedge.net/latest/commandJob.schema.json
display_name: acestep-lora-$ExpName
experiment_name: acestep-lora
compute: azureml:$Compute
environment: azureml:$Environment
code: $codeUri
inputs:
  dataset:
    type: uri_folder
    path: $dataUri
  lora_config:
    type: uri_file
    path: $loraUri
outputs:
  ckpts:
    type: uri_folder
    mode: rw_mount
command: >-
  python trainer.py
  --exp_name $ExpName
  --dataset_path `${{inputs.dataset}}
  --lora_config_path `${{inputs.lora_config}}
  --max_steps $MaxSteps
  --every_n_train_steps 1000
  --precision bf16-mixed
  --accumulate_grad_batches 2
  --gradient_clip_val 0.5
  --learning_rate 1e-4
  --num_workers 4
  --devices 1
  --logger_dir `${{outputs.ckpts}}/tb
  --checkpoint_dir `${{outputs.ckpts}}
"@ | Set-Content -LiteralPath $jobYaml -Encoding UTF8

Write-Host "── Submitting Azure ML job (see $jobYaml)" -ForegroundColor Cyan
az ml job create `
    --file $jobYaml `
    --subscription $SubscriptionId `
    --resource-group $ResourceGroup `
    --workspace-name $Workspace
if ($LASTEXITCODE -ne 0) { throw "az ml job create failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Job submitted. Monitor with:" -ForegroundColor Green
Write-Host "  az ml job stream --name acestep-lora-$ExpName -w $Workspace -g $ResourceGroup" -ForegroundColor Green
Write-Host ""
Write-Host "Download checkpoints when done:" -ForegroundColor Green
Write-Host "  az ml job download --name acestep-lora-$ExpName -p ckpts -w $Workspace -g $ResourceGroup" -ForegroundColor Green
Write-Host "Then copy *.ckpt into data/lora-training/exps/$ExpName/ckpts/ so the companion exposes them." -ForegroundColor Green
