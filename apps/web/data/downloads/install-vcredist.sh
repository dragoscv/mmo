#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"
read -r -d '' PSCMD <<'EOF'
$env:Path = "$env:LOCALAPPDATA\Microsoft\WindowsApps;$env:Path"
Write-Host "==INSTALL VC++ Redistributable 2015-2022 x64=="
& winget install --id Microsoft.VCRedist.2015+.x64 -e --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity --silent
Write-Host "exitcode=$LASTEXITCODE"
Write-Host "==VERIFY=="
Get-ChildItem 'C:\Windows\System32' -Filter 'vcruntime140*.dll' | Select-Object Name,Length
Get-ChildItem 'C:\Windows\System32' -Filter 'msvcp140*.dll' | Select-Object Name,Length
EOF
$SSH "$PSCMD"
