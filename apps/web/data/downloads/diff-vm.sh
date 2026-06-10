#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"
read -r -d '' PSCMD <<'EOF'
$d = 'C:\Users\dragos\companion-dev'
Write-Host "==tsc version=="
& node "$d\node_modules\typescript\bin\tsc" --version
Write-Host "==node version=="
node --version
Write-Host "==electron-store dir on VM=="
Get-ChildItem "$d\node_modules\electron-store"
Write-Host "==electron-store dts head=="
Get-Content "$d\node_modules\electron-store\index.d.ts" -TotalCount 5
Write-Host "==conf in nm root=="
Test-Path "$d\node_modules\conf"
if (Test-Path "$d\node_modules\conf\package.json") {
  Get-Content "$d\node_modules\conf\package.json" | Select-String '"version"|"main"|"types"' | Select-Object -First 5
  Write-Host "==conf dts methods=="
  Get-ChildItem "$d\node_modules\conf" -Recurse -Filter '*.d.ts' | Select-Object FullName
}
Write-Host "==files in src/audio/virtual-devices=="
Get-ChildItem "$d\src\audio\virtual-devices" | Select-Object Name,Length
Write-Host "==tsconfig=="
Get-Content "$d\tsconfig.json" -Raw
EOF
$SSH "$PSCMD"
