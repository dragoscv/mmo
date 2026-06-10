#!/usr/bin/env bash
# bootstrap-win-vm.sh — one-time install of Node.js LTS on the Windows VM.
# Idempotent. Uses winget (built-in on Win10 22H2+ / Win11).
set -euo pipefail
SSH="sshpass -p ${WIN_PASS:-papuci123} ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p ${WIN_PORT:-2222} ${WIN_USER:-dragos}@${WIN_HOST:-172.23.192.1}"

read -r -d '' PSCMD <<'EOF' || true
$ErrorActionPreference = 'Continue'
Write-Host "==CHECK NODE=="
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  Write-Host "node already installed: $($node.Source)"
  & node --version
  & npm --version
  exit 0
}

Write-Host "==INSTALL NODE.JS LTS via winget=="
$env:Path = "$env:LOCALAPPDATA\Microsoft\WindowsApps;$env:Path"
& winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
Write-Host "exitcode=$LASTEXITCODE"

# Refresh PATH from registry so the current session sees node/npm.
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

Write-Host "==VERIFY=="
& node --version
& npm --version
EOF

$SSH "$PSCMD"
