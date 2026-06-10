#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
Write-Host "node:"; node --version
Write-Host "npm:"; & npm --version
Write-Host "tar:"; (Get-Command tar -ErrorAction SilentlyContinue).Source
Write-Host "ssh:"; (Get-Command ssh -ErrorAction SilentlyContinue).Source
EOF

$SSH "$PSCMD"
