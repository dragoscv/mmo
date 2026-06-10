#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion'
Write-Host "==FULL RESOURCES TREE=="
Get-ChildItem (Join-Path $root 'resources\virtual-audio') -Recurse | Select-Object FullName,Length | Format-Table -AutoSize | Out-String -Width 200

Write-Host "==FIND LOG FILES=="
@("$env:APPDATA\MMO Companion","$env:LOCALAPPDATA\MMO Companion","$env:USERPROFILE\AppData\Roaming\mmo-companion") | ForEach-Object {
  if (Test-Path $_) {
    Write-Host "Dir: $_"
    Get-ChildItem $_ -Recurse -Filter '*.log' -ErrorAction SilentlyContinue | Select-Object FullName,LastWriteTime,Length | Format-Table -AutoSize | Out-String -Width 200
  }
}

Write-Host "==COMPANION PROC=="
Get-Process -Name 'MMO Companion' -ErrorAction SilentlyContinue | Select-Object Id,StartTime | Format-Table -AutoSize | Out-String

Write-Host "==ANY 17899 LISTEN ANYWHERE=="
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq 17899 } | Format-Table -AutoSize | Out-String
EOF

$SSH "$PSCMD"
