#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
Write-Host "==STEP 1: DOWNLOAD=="
$url = 'https://github.com/dragoscv/mmo/releases/download/v0.9.12/MMO-Companion-Setup-0.9.12.exe'
$dst = "$env:USERPROFILE\Downloads\MMO-Companion-Setup-0.9.12.exe"
if (-not (Test-Path $dst) -or (Get-Item $dst).Length -lt 80000000) {
  Write-Host "Downloading..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
}
Get-Item $dst | Select-Object Name,Length

Write-Host "==STEP 2: SILENT INSTALL (NSIS oneClick)=="
$proc = Start-Process -FilePath $dst -ArgumentList '/S' -Wait -PassThru
Write-Host "ExitCode: $($proc.ExitCode)"

Write-Host "==STEP 3: VERIFY INSTALL=="
Get-ChildItem 'C:\Users\dragos\AppData\Local\Programs','C:\Program Files','C:\Program Files (x86)' -Filter 'MMO Companion*' -Directory -ErrorAction SilentlyContinue | Select-Object FullName

$exe = Get-ChildItem -Path 'C:\Users\dragos\AppData\Local\Programs','C:\Program Files','C:\Program Files (x86)' -Filter 'MMO Companion.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
  Write-Host "EXE: $($exe.FullName)"
  Write-Host "==STEP 4: PACKAGED RESOURCES=="
  $rootDir = Split-Path $exe.FullName -Parent
  Get-ChildItem (Join-Path $rootDir 'resources\virtual-audio') -ErrorAction SilentlyContinue | Select-Object Name
  Get-ChildItem (Join-Path $rootDir 'resources\virtual-audio\windows') -ErrorAction SilentlyContinue | Select-Object Name,Length
}
EOF

$SSH "$PSCMD"
