# GCE Spot escape-hatch for ACE-Step LoRA training.
#
# Vertex AI is the right way to do this (managed, auto-scaling), but when
# Vertex queues are backed up or we want a long-running interactive box,
# we can spin up a raw GCE A100 spot VM with cuda+conda preinstalled
# (Deep Learning VM image) and SSH in.
#
# Cost: A100 40GB spot ≈ $1.10/hr in europe-west1. Auto-terminate after
# the script finishes via metadata startup-script signaling its own
# `gcloud compute instances delete` at the end.
#
#   pwsh scripts/dev-gce-spot.ps1 -ExpName my-style `
#       -DatasetUri gs://mmo-training-prod/job-abc/dataset `
#       -OutputUri  gs://mmo-training-prod/job-abc/output
#
# Then `gcloud compute ssh acestep-spot-<rand> --zone=europe-west1-b` to tail.

param(
    [Parameter(Mandatory=$true)][string]$ExpName,
    [Parameter(Mandatory=$true)][string]$DatasetUri,
    [Parameter(Mandatory=$true)][string]$OutputUri,
    [int]$MaxSteps = 1500,
    [int]$Rank = 16,
    [string]$Project = "mmo-mw-prod",
    [string]$Zone = "europe-west1-b",
    [string]$MachineType = "a2-highgpu-1g",
    [string]$ServiceAccount = "sa-vertex-trainer@mmo-mw-prod.iam.gserviceaccount.com",
    [switch]$AutoDeleteOnSuccess
)

$ErrorActionPreference = "Stop"

$rand = -join ((97..122) | Get-Random -Count 6 | ForEach-Object {[char]$_})
$vmName = "acestep-spot-$rand"
$imageFamily = "pytorch-latest-gpu-debian-11-py310"
$imageProject = "deeplearning-platform-release"

$startup = @"
#!/bin/bash
set -euxo pipefail

# Install ACE-Step + deps inside the VM
cd /opt
git clone --depth=1 https://github.com/ace-step/ACE-Step.git
cd ACE-Step
pip install --no-cache-dir -e .
pip install --no-cache-dir google-cloud-storage mlflow-skinny==2.16.2 peft accelerate

# Pull our train.py
gsutil cp gs://mmo-training-prod/_scripts/train.py /opt/train.py

# Run training
python /opt/train.py \\
    --dataset-uri '$DatasetUri' \\
    --output-uri  '$OutputUri' \\
    --exp-name    '$ExpName' \\
    --max-steps   $MaxSteps \\
    --rank        $Rank

$(if ($AutoDeleteOnSuccess) {
  "gcloud compute instances delete $vmName --zone=$Zone --quiet"
})
"@

$tmpStartup = New-TemporaryFile
Set-Content -Path $tmpStartup -Value $startup -NoNewline -Encoding ascii

Write-Host "Uploading train.py helper to gs://mmo-training-prod/_scripts/..." -ForegroundColor Cyan
$trainScript = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "../infra/vertex/train-acestep/train.py"
gsutil cp $trainScript "gs://mmo-training-prod/_scripts/train.py"

Write-Host ""
Write-Host "Creating GCE SPOT VM $vmName (machine=$MachineType, A100 40GB) in $Zone..." -ForegroundColor Cyan

gcloud compute instances create $vmName `
    --project=$Project `
    --zone=$Zone `
    --machine-type=$MachineType `
    --accelerator="count=1,type=nvidia-tesla-a100" `
    --maintenance-policy=TERMINATE `
    --provisioning-model=SPOT `
    --instance-termination-action=DELETE `
    --image-family=$imageFamily `
    --image-project=$imageProject `
    --boot-disk-size=200GB `
    --boot-disk-type=pd-ssd `
    --service-account=$ServiceAccount `
    --scopes=https://www.googleapis.com/auth/cloud-platform `
    --metadata-from-file=startup-script=$tmpStartup `
    --metadata=install-nvidia-driver=True

Remove-Item $tmpStartup -Force

Write-Host ""
Write-Host "VM created. To tail the training log:" -ForegroundColor Green
Write-Host "  gcloud compute ssh $vmName --zone=$Zone --project=$Project --command='sudo journalctl -u google-startup-scripts.service -f'"
Write-Host ""
Write-Host "To delete manually when done:" -ForegroundColor Yellow
Write-Host "  gcloud compute instances delete $vmName --zone=$Zone --project=$Project"
