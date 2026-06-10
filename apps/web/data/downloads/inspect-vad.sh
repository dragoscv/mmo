#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
Write-Host "==SCAN-DEVICES=="
& pnputil.exe /scan-devices 2>&1
Write-Host "exit=$LASTEXITCODE"

Write-Host "==MEDIA DEVICES=="
Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Format-Table Status,FriendlyName,InstanceId -AutoSize -Wrap

Write-Host "==Win32_SoundDevice=="
Get-CimInstance Win32_SoundDevice | Format-Table Name,Status -AutoSize

Write-Host "==INF CONTENTS (Manufacturer + Models + Service)=="
$inf = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion\resources\virtual-audio\windows\VirtualAudioDriver.inf'
Get-Content $inf | Select-Object -First 200
EOF

$SSH "$PSCMD"
