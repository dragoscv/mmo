#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
Write-Host "==STEP 1: UNINSTALL OLD=="
$un = Get-ChildItem 'C:\Users\dragos\AppData\Local\Programs\mmo-companion' -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($un) { Start-Process -FilePath $un.FullName -ArgumentList '/S' -Wait; Write-Host "Uninstalled $($un.FullName)" } else { Write-Host "no prior install" }
Start-Sleep -Seconds 3

Write-Host "==STEP 2: DOWNLOAD v0.9.12=="
$url = 'https://github.com/dragoscv/mmo/releases/download/v0.9.12/MMO-Companion-Setup-0.9.12.exe'
$dst = "$env:USERPROFILE\Downloads\MMO-Companion-Setup-0.9.12.exe"
Remove-Item $dst -ErrorAction SilentlyContinue
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
Get-Item $dst | Select-Object Name,Length

Write-Host "==STEP 3: SILENT INSTALL=="
$proc = Start-Process -FilePath $dst -ArgumentList '/S' -Wait -PassThru
Write-Host "ExitCode: $($proc.ExitCode)"
Start-Sleep -Seconds 3

Write-Host "==STEP 4: PACKAGED RESOURCES=="
$exe = Get-ChildItem -Path 'C:\Users\dragos\AppData\Local\Programs' -Filter 'MMO Companion.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
  Write-Host "EXE: $($exe.FullName)"
  $rootDir = Split-Path $exe.FullName -Parent
  Write-Host "--- resources\virtual-audio ---"
  Get-ChildItem (Join-Path $rootDir 'resources\virtual-audio') -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length | Format-Table -AutoSize
} else {
  Write-Host "EXE NOT FOUND"
}
EOF

$SSH "$PSCMD"
