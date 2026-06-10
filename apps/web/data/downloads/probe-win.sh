#!/usr/bin/env bash
# Default ssh shell on the Windows VM is PowerShell. Send a single PS
# block via heredoc-like single-quoted command to avoid double-escaping.
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'SilentlyContinue'
Write-Host "==NODE/PNPM/PWSH=="
node --version
pnpm --version
pwsh --version
Write-Host "==PNPUTIL=="
(Get-Command pnputil).Source
Write-Host "==INSTALLED COMPANION=="
Get-ChildItem 'C:\Users\dragos\AppData\Local\Programs','C:\Program Files','C:\Program Files (x86)' -Filter 'MMO Companion*' -Directory | Select-Object FullName
Write-Host "==AUDIO DEVICES=="
Get-CimInstance Win32_SoundDevice | Select-Object Name,Status | Format-Table -AutoSize | Out-String -Width 200
Write-Host "==VAD DRIVER=="
$drv = pnputil /enum-drivers
($drv -split "`n") | Select-String -Pattern 'VirtualAudio','VAD','Virtual Audio'
Write-Host "==DOWNLOADS=="
Get-ChildItem 'C:\Users\dragos\Downloads' -Filter 'MMO*' | Select-Object Name,Length
EOF

$SSH "$PSCMD"
