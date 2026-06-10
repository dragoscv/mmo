#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
Write-Host "==FILES=="
Get-ChildItem 'C:\Users\dragos\AppData\Local\Programs\mmo-companion\resources\virtual-audio\windows' | Select-Object Name,Length | Format-Table -AutoSize

Write-Host "==AM I ADMIN?=="
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal $id
Write-Host ("isAdmin=" + $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
Write-Host ("user=" + $id.Name)
Write-Host ("groups (admin-ish):")
$id.Groups | ForEach-Object { try { $_.Translate([Security.Principal.NTAccount]).Value } catch {} } | Where-Object { $_ -match 'Admin|Power' }

Write-Host "==pnputil DRIVERS BEFORE=="
pnputil /enum-drivers 2>&1 | Select-String -Pattern 'VirtualAudio|virtualaudio' -Context 0,3

Write-Host "==INSTALL DRIVER (no /install flag — just stage)=="
$inf = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion\resources\virtual-audio\windows\VirtualAudioDriver.inf'
Test-Path $inf
& pnputil.exe /add-driver $inf /install 2>&1
Write-Host "exitcode=$LASTEXITCODE"

Write-Host "==pnputil DRIVERS AFTER=="
pnputil /enum-drivers 2>&1 | Select-String -Pattern 'VirtualAudio|virtualaudio' -Context 0,3

Write-Host "==SOUND DEVICES=="
Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,Manufacturer | Format-Table -AutoSize
EOF

$SSH "$PSCMD"
