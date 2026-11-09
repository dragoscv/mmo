<#
.SYNOPSIS
  Build apps/web with Cloud Build and deploy it to Cloud Run `mixai-web` (europe-west1, project
  mmo-mw-prod, next to Cloud SQL `mmo-pg`).

.DESCRIPTION
  Run ONLY from a clean tree at a pushed commit:
    pwsh -NoProfile -File "$env:USERPROFILE\.copilot\hooks\deploy-clean.ps1" -Command 'pwsh -NoProfile -File apps/web/scripts/deploy-cloud-run.ps1'
  1. Ensures the Artifact Registry repo, IAM for the runtime SA (secret accessor, Cloud SQL client).
  2. Syncs Secret Manager secrets from apps/web/.env.local (values never printed; a new version is
     added only when the value changed; temp files deleted). Names: see $SecretMap below and
     apps/web/README.md § Cloud Run.
  3. Stages a repo-root build context with `git archive <sha>` (only committed files; no
     public/samples, no data/) and runs `gcloud builds submit` with apps/web/cloudbuild.yaml.
  4. `gcloud run deploy` with the Cloud SQL socket (/cloudsql/<connection>), plain env from
     .env.local (non-secret names only) and secrets by reference.
  DB migrations are NOT run here: check `pnpm -C apps/web db:status` first (apps/web/.env.local = PROD).
#>
param(
  [string]$Project = 'mmo-mw-prod',
  [string]$Region = 'europe-west1',
  [string]$Service = 'mixai-web',
  [string]$Repo = 'mixai',
  [string]$SqlInstance = 'mmo-pg',
  [string]$RuntimeSa = 'mmo-web-app',
  # Public origin for Auth.js. mixai.ro (+ www) are Cloud Run domain mappings since 2026-11-05; the
  # run.app URL keeps serving the same app (no redirect) and stays in the Google OAuth redirect URIs.
  [string]$AppUrl = 'https://mixai.ro',
  [string]$EnvFile,
  [switch]$NoSecretSync,
  [switch]$SkipBuild,
  # WP17-10: turn on tv./music./app./decks. host routing (dj. 308s to decks., D60) + the .mixai.ro session cookie. Only after the domain
  # mappings for every product host have a certificate (otherwise 308s point at hosts without TLS).
  [switch]$HostRouting
)
$ErrorActionPreference = 'Stop'
$repoRoot = (git rev-parse --show-toplevel).Trim()
if (-not $EnvFile) { $EnvFile = Join-Path $repoRoot 'apps/web/.env.local' }
$sha = if ($env:DEPLOY_SHA) { $env:DEPLOY_SHA } else { (git -C $repoRoot rev-parse HEAD).Trim() }
$short = $sha.Substring(0, 12)
$image = "$Region-docker.pkg.dev/$Project/$Repo/${Service}:$short"
$connection = "${Project}:${Region}:$SqlInstance"
$saEmail = "$RuntimeSa@$Project.iam.gserviceaccount.com"
function Step([string]$m) { Write-Host "::step $m" }
function Invoke-Gcloud { & gcloud @args; if ($LASTEXITCODE -ne 0) { throw "gcloud $($args -join ' ') failed ($LASTEXITCODE)" } }
function Phase([string]$p, [switch]$Unsafe) {
  if (-not $env:AGENTQ_RELEASE_FILE) { return }
  $q = Join-Path $env:USERPROFILE '.copilot\bin\agentq.ps1'
  $a = @('-NoProfile', '-File', $q, 'release-phase', '-Phase', $p); if ($Unsafe) { $a += '-Unsafe' }
  & pwsh @a; if ($LASTEXITCODE -eq 4) { Write-Host 'superseded'; exit 4 }
}

# Env var → Secret Manager secret. Everything else non-empty in .env.local that is listed in
# $PlainEnv is passed as a plain env var; names not in either list are NOT deployed.
$SecretMap = [ordered]@{
  DATABASE_URL                          = 'mixai-web-database-url'
  AUTH_SECRET                           = 'mixai-web-auth-secret'
  AUTH_TOKEN_ENC_KEY                    = 'mixai-web-auth-token-enc-key'
  AUTH_GOOGLE_ID                        = 'mixai-web-auth-google-id'
  AUTH_GOOGLE_SECRET                    = 'mixai-web-auth-google-secret'
  AUTH_GITHUB_ID                        = 'mixai-web-auth-github-id'
  AUTH_GITHUB_SECRET                    = 'mixai-web-auth-github-secret'
  STRIPE_SECRET_KEY                     = 'mixai-web-stripe-secret-key'
  STRIPE_WEBHOOK_SECRET                 = 'mixai-web-stripe-webhook-secret'
  TMDB_API_KEY                          = 'mixai-web-tmdb-api-key'
  TMDB_READ_TOKEN                       = 'mixai-web-tmdb-read-token'
  AZURE_OPENAI_KEY                      = 'mixai-web-azure-openai-key'
  AZURE_SPEECH_KEY                      = 'mixai-web-azure-speech-key'
  AZURE_CLIENT_SECRET                   = 'mixai-web-azure-client-secret'
  CLOUDFLARE_API_TOKEN                  = 'mixai-web-cloudflare-api-token'
  MMO_TRAINER_SECRET                    = 'mixai-web-mmo-trainer-secret'
  WEB_REVALIDATE_SECRET                 = 'mixai-web-revalidate-secret'
  TURN_SHARED_SECRET                    = 'mixai-web-turn-shared-secret'
  APPLICATIONINSIGHTS_CONNECTION_STRING = 'mixai-web-appinsights-connection-string'
  GCP_SERVICE_ACCOUNT_KEY               = 'mixai-web-gcp-service-account-key'
}
# Optional secrets that usually live ONLY in Secret Manager (multi-line PEM / JSON don't fit .env.local):
# synced from .env.local when present there, otherwise mounted iff the secret already has a version.
# Absent ⇒ not mounted, and the feature stays off (Sign in with Apple, FCM, APNs are env-gated).
# Setup: docs/followups/apple-siwa-setup.md.
$OptionalSecretMap = [ordered]@{
  AUTH_APPLE_ID            = 'mixai-web-apple-services-id'
  AUTH_APPLE_SECRET        = 'mixai-web-auth-apple-secret'
  APPLE_KEY_ID             = 'mixai-web-apple-key-id'
  APPLE_PRIVATE_KEY        = 'mixai-web-apple-p8'
  FCM_SERVICE_ACCOUNT_JSON = 'mixai-web-fcm-sa'
  APNS_KEY_ID              = 'mixai-web-apns-key-id'
  APNS_PRIVATE_KEY         = 'mixai-web-apns-p8'
}
foreach ($k in $OptionalSecretMap.Keys) { $SecretMap[$k] = $OptionalSecretMap[$k] }
$PlainEnv = @(
  'TMDB_DEFAULT_LANG', 'GCP_PROJECT_ID', 'GCP_REGION', 'GCP_TRAINING_REGION', 'GCS_BUCKET', 'GCS_BUCKET_UPLOADS',
  'GCS_BUCKET_GENERATED', 'GCP_ACESTEP_URL', 'GCP_DEMUCS_URL', 'GCP_PIPER_URL', 'GCP_RVC_URL', 'GCP_VOICE_TTS_URL',
  'VERTEX_TRAINER_IMAGE', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION',
  'AZURE_SPEECH_REGION', 'AZURE_SPEECH_ENDPOINT', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_TUNNEL_BASE_HOSTNAME', 'CLOUDFLARE_TUNNEL_ZONE_ID', 'TURN_HOST', 'TURN_REALM',
  'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_YEARLY', 'NEXT_PUBLIC_STRIPE_PUBLIC_KEY',
  'APPLE_TEAM_ID', 'APPLE_BUNDLE_ID', 'APPLE_NATIVE_AUDIENCES', 'GOOGLE_NATIVE_CLIENT_IDS',
  'APNS_TEAM_ID', 'APNS_TOPIC', 'FCM_PROJECT_ID'
)

$envMap = @{}
if (Test-Path $EnvFile) {
  foreach ($l in [IO.File]::ReadAllLines($EnvFile)) {
    if ($l -match '^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$') {
      $v = $matches[2].Trim()
      if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) { $v = $v.Substring(1, $v.Length - 2) }
      $envMap[$matches[1]] = $v
    }
  }
} elseif (-not $NoSecretSync) { throw "env file not found: $EnvFile (needed for the secret sync; pass -NoSecretSync to reuse existing secrets)" }

Phase prepare
$projectNumber = (Invoke-Gcloud projects describe $Project --format='value(projectNumber)').Trim()
if (-not $AppUrl) { $AppUrl = "https://$Service-$projectNumber.$Region.run.app" }
Write-Host "sha=$short image=$image appUrl=$AppUrl"

Step 'artifact registry'
& gcloud artifacts repositories describe $Repo --location $Region --project $Project --format='value(name)' 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Invoke-Gcloud artifacts repositories create $Repo --repository-format docker --location $Region --project $Project --description 'MixAI container images'
}

Step 'iam'
foreach ($role in 'roles/secretmanager.secretAccessor', 'roles/cloudsql.client') {
  Invoke-Gcloud projects add-iam-policy-binding $Project --member "serviceAccount:$saEmail" --role $role --condition None --quiet --format none
}

$deployed = [ordered]@{}
foreach ($k in $SecretMap.Keys) { if ($envMap[$k]) { $deployed[$k] = $SecretMap[$k] } }
if (-not $NoSecretSync) {
  Step 'secrets'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("mxs-" + [guid]::NewGuid().ToString('N'))
  try {
    foreach ($k in $deployed.Keys) {
      $name = $deployed[$k]
      $value = $envMap[$k]
      & gcloud secrets describe $name --project $Project --format='value(name)' 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Invoke-Gcloud secrets create $name --project $Project --replication-policy automatic --labels app=mixai-web --format none
        $current = $null
      } else {
        $current = (& gcloud secrets versions access latest --secret $name --project $Project 2>$null) -join "`n"
        if ($LASTEXITCODE -ne 0) { $current = $null }
      }
      if ($current -ceq $value) { Write-Host "secret $name unchanged"; continue }
      [IO.File]::WriteAllText($tmp, $value)
      Invoke-Gcloud secrets versions add $name --project $Project --data-file $tmp --format none
      Remove-Item $tmp -Force
      Write-Host "secret $name new version"
    }
  } finally { if (Test-Path $tmp) { Remove-Item $tmp -Force } }
} else {
  # Reuse whatever exists in Secret Manager.
  $deployed = [ordered]@{}
  foreach ($k in $SecretMap.Keys) {
    & gcloud secrets describe $SecretMap[$k] --project $Project --format='value(name)' 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $deployed[$k] = $SecretMap[$k] }
  }
}
# Optional secrets not in .env.local: mount only when an ENABLED latest version exists (a secret with
# no version would make `gcloud run deploy` fail the revision).
foreach ($k in $OptionalSecretMap.Keys) {
  if ($deployed.Contains($k)) { continue }
  $state = (& gcloud secrets versions describe latest --secret $OptionalSecretMap[$k] --project $Project --format='value(state)' 2>$null)
  if ($LASTEXITCODE -eq 0 -and "$state".Trim() -eq 'ENABLED') { $deployed[$k] = $OptionalSecretMap[$k]; Write-Host "optional secret $($OptionalSecretMap[$k]) mounted" }
  else { Write-Host "optional secret $($OptionalSecretMap[$k]) absent (feature off)" }
}
foreach ($req in 'DATABASE_URL', 'AUTH_SECRET') { if (-not $deployed.Contains($req)) { throw "required secret for $req missing" } }

if (-not $SkipBuild) {
  Step 'stage context'
  $ctx = Join-Path ([IO.Path]::GetTempPath()) "mixai-web-ctx-$short"
  if (Test-Path $ctx) { Remove-Item $ctx -Recurse -Force }
  New-Item -ItemType Directory $ctx | Out-Null
  $tar = "$ctx.tar"
  # autocrlf=false: ship the LF blobs as stored (core.autocrlf=true on this machine would CRLF the
  # Dockerfile and every script inside the Linux image).
  git -C $repoRoot -c core.autocrlf=false archive --format=tar -o $tar $sha -- package.json pnpm-workspace.yaml .npmrc .dockerignore apps/web packages docs ':(exclude)apps/web/public/samples' ':(exclude)apps/web/data'
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  tar -xf $tar -C $ctx; if ($LASTEXITCODE -ne 0) { throw 'tar extract failed' }
  Remove-Item $tar -Force
  # Upload everything staged (gcloud would otherwise apply apps/web/.gitignore semantics only to the root).
  [IO.File]::WriteAllText((Join-Path $ctx '.gcloudignore'), ".gcloudignore`n")
  Step 'cloud build'
  Phase build
  Invoke-Gcloud builds submit $ctx --project $Project --config (Join-Path $ctx 'apps/web/cloudbuild.yaml') --substitutions "_IMAGE=$image,_COMMIT_SHA=$sha"
  Remove-Item $ctx -Recurse -Force
}

Step 'deploy'
$envFileYaml = Join-Path ([IO.Path]::GetTempPath()) ("mxe-" + [guid]::NewGuid().ToString('N') + '.yaml')
try {
  $plain = [ordered]@{
    DB_SOCKET_DIR    = "/cloudsql/$connection"
    AUTH_URL         = $AppUrl
    NEXTAUTH_URL     = $AppUrl
    AUTH_TRUST_HOST  = 'true'
    MMO_APP_URL      = $AppUrl
    COMMIT_SHA       = $sha
    MIXAI_HOST_ROUTING = $(if ($HostRouting) { '1' } else { '0' })
  }
  foreach ($k in $PlainEnv) { if ($envMap[$k]) { $plain[$k] = $envMap[$k] } }
  $yaml = foreach ($k in $plain.Keys) { "${k}: '" + ($plain[$k] -replace "'", "''") + "'" }
  [IO.File]::WriteAllLines($envFileYaml, [string[]]$yaml)
  $secrets = ($deployed.Keys | ForEach-Object { "$_=$($deployed[$_]):latest" }) -join ','
  Phase deploy -Unsafe
  Invoke-Gcloud run deploy $Service --project $Project --region $Region --image $image `
    --service-account $saEmail --add-cloudsql-instances $connection `
    --env-vars-file $envFileYaml --set-secrets $secrets `
    --port 8080 --cpu 1 --memory 1Gi --concurrency 40 --min-instances 0 --max-instances 4 `
    --cpu-boost --timeout 300 --allow-unauthenticated --labels "app=mixai-web,commit=$short" --quiet
} finally { if (Test-Path $envFileYaml) { Remove-Item $envFileYaml -Force } }

$svc = Invoke-Gcloud run services describe $Service --project $Project --region $Region --format json | ConvertFrom-Json
Write-Host "url=$($svc.status.url)"
Write-Host "latestReady=$($svc.status.latestReadyRevisionName) latestCreated=$($svc.status.latestCreatedRevisionName)"
Write-Host "image=$image secrets=$(($deployed.Values) -join ',')"
if ($svc.status.latestReadyRevisionName -ne $svc.status.latestCreatedRevisionName) { throw 'latest revision is not ready' }
'DEPLOY_CLOUD_RUN_DONE'
