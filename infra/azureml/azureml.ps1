# Wraps infra/azureml/manage.py with credentials loaded from .azure-sp.json
# + .azure-names.txt. Run from repo root.
#
# Usage:
#   .\infra\azureml\azureml.ps1 list-envs
#   .\infra\azureml\azureml.ps1 register-env .\infra\azureml\acestep-env.yml
#   .\infra\azureml\azureml.ps1 ensure-compute .\infra\azureml\compute-a100.yml
#   .\infra\azureml\azureml.ps1 submit-job <jobspec.yml>
#   .\infra\azureml\azureml.ps1 job-status <jobName>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)] [string]$Command,
    [Parameter(Position = 1)] [string]$Arg
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

$namesFile = Join-Path $repoRoot ".azure-names.txt"
$spFile    = Join-Path $repoRoot ".azure-sp.json"
if (-not (Test-Path $namesFile)) { throw "Missing $namesFile - run initial provisioning first." }
if (-not (Test-Path $spFile))    { throw "Missing $spFile - run SP creation first." }

$names = Get-Content $namesFile
$sp    = Get-Content $spFile | ConvertFrom-Json
$env:AZURE_SUBSCRIPTION_ID = "a2845388-ce62-4b42-a6ea-e32e7441e635"
$env:AZURE_RESOURCE_GROUP  = $names[0]
$env:AZUREML_WORKSPACE     = $names[7]
$env:AZURE_TENANT_ID       = $sp.tenant
$env:AZURE_CLIENT_ID       = $sp.appId
$env:AZURE_CLIENT_SECRET   = $sp.password

$python = Join-Path $repoRoot ".venvs\azureml-mgmt\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Missing python venv at $python" }

$pyArgs = @((Join-Path $PSScriptRoot "manage.py"), $Command)
if ($Arg) { $pyArgs += $Arg }
& $python @pyArgs
exit $LASTEXITCODE
