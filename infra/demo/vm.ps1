<#
.SYNOPSIS
  Create (idempotently) the always-on store-review demo VM `mixai-demo` and its network pieces.
  Owner-approved always-on server (D39, WP16-53): NO max-run-duration on purpose. Cost: see README.md.
.NOTES
  Resources (project mmo-mw-prod, region europe-central2):
    address  mixai-demo-ip       static external IPv4
    sa       mixai-demo@...      Artifact Registry reader (repo mixai) + log/metric writer, nothing else
    firewall mixai-demo-web      tcp:80,443 -> tag mixai-demo (17899 stays closed; ssh = project default rule)
    disk     mixai-demo-data     50 GB pd-balanced, mounted at /srv/mixai by startup.sh
    vm       mixai-demo          e2-small, Debian 12, 30 GB pd-balanced boot
#>
param(
    [string]$Project = 'mmo-mw-prod',
    [string]$Region = 'europe-central2',
    [string]$Zone = 'europe-central2-a',
    [string]$Name = 'mixai-demo'
)
$ErrorActionPreference = 'Stop'
$labels = 'purpose=store-review-demo,owner=mixai'
$sa = "$Name@$Project.iam.gserviceaccount.com"
function Invoke-G { param([string[]]$GArgs) & gcloud @GArgs --project $Project --quiet; if ($LASTEXITCODE -ne 0) { throw "gcloud $($GArgs -join ' ') failed ($LASTEXITCODE)" } }
function Test-G { param([string[]]$GArgs) & gcloud @GArgs --project $Project --format='value(name)' 2>$null | Out-Null; return ($LASTEXITCODE -eq 0) }

Write-Host '::step address'
if (-not (Test-G @('compute', 'addresses', 'describe', "$Name-ip", '--region', $Region))) {
    Invoke-G @('compute', 'addresses', 'create', "$Name-ip", '--region', $Region, '--network-tier', 'PREMIUM', '--description', 'MixAI store-review demo server')
}
$ip = (& gcloud compute addresses describe "$Name-ip" --region $Region --project $Project --format='value(address)').Trim()
Write-Host "ip=$ip"

Write-Host '::step service account'
if (-not (Test-G @('iam', 'service-accounts', 'describe', $sa))) {
    Invoke-G @('iam', 'service-accounts', 'create', $Name, '--display-name', 'MixAI demo VM (store review)')
}
Invoke-G @('artifacts', 'repositories', 'add-iam-policy-binding', 'mixai', '--location', 'europe-west1', '--member', "serviceAccount:$sa", '--role', 'roles/artifactregistry.reader')
foreach ($role in 'roles/logging.logWriter', 'roles/monitoring.metricWriter') {
    & gcloud projects add-iam-policy-binding $Project --member "serviceAccount:$sa" --role $role --condition=None --quiet --format=none
    if ($LASTEXITCODE -ne 0) { throw "iam binding $role failed" }
}

Write-Host '::step firewall'
if (-not (Test-G @('compute', 'firewall-rules', 'describe', "$Name-web"))) {
    Invoke-G @('compute', 'firewall-rules', 'create', "$Name-web", '--network', 'default', '--direction', 'INGRESS', '--action', 'allow',
        '--rules', 'tcp:80,tcp:443', '--source-ranges', '0.0.0.0/0', '--target-tags', $Name, '--description', 'MixAI demo: HTTPS + ACME HTTP-01 only (17899 closed)')
}

Write-Host '::step data disk'
if (-not (Test-G @('compute', 'disks', 'describe', "$Name-data", '--zone', $Zone))) {
    Invoke-G @('compute', 'disks', 'create', "$Name-data", '--zone', $Zone, '--size', '50GB', '--type', 'pd-balanced', '--labels', $labels)
}

Write-Host '::step vm'
if (-not (Test-G @('compute', 'instances', 'describe', $Name, '--zone', $Zone))) {
    $startup = Join-Path $PSScriptRoot 'startup.sh'
    Invoke-G @('compute', 'instances', 'create', $Name, '--zone', $Zone, '--machine-type', 'e2-small',
        '--image-family', 'debian-12', '--image-project', 'debian-cloud',
        '--boot-disk-size', '30GB', '--boot-disk-type', 'pd-balanced', '--boot-disk-device-name', $Name,
        '--disk', "name=$Name-data,device-name=mixai-data,mode=rw,auto-delete=no",
        '--address', $ip, '--network-tier', 'PREMIUM', '--tags', $Name, '--labels', $labels,
        '--service-account', $sa, '--scopes', 'cloud-platform',
        '--shielded-secure-boot', '--shielded-vtpm', '--shielded-integrity-monitoring',
        '--metadata-from-file', "startup-script=$startup")
}
& gcloud compute instances describe $Name --zone $Zone --project $Project --format='value(name,status,networkInterfaces[0].accessConfigs[0].natIP,labels)'
Write-Host 'VMDONE'
