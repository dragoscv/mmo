#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"
read -r -d '' PSCMD <<'EOF'
Remove-Item -Recurse -Force C:\Users\dragos\companion-dev -ErrorAction SilentlyContinue
Write-Host "cleaned"
EOF
$SSH "$PSCMD"
