#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"
read -r -d '' PSCMD <<'EOF'
$d = 'C:\Users\dragos\companion-dev\node_modules\audify\build\Release'
Write-Host "==files=="
Get-ChildItem $d
Write-Host "==dependencies of audify.node=="
$node = Join-Path $d 'audify.node'
# Use dumpbin if available, else PE header parsing via PS
try {
  $bytes = [IO.File]::ReadAllBytes($node)
  Write-Host "size: $($bytes.Length)"
} catch {}
# Quick check: try loading via Add-Type
Write-Host "==strings — likely deps=="
$content = [IO.File]::ReadAllBytes($node)
$txt = [Text.Encoding]::ASCII.GetString($content)
[regex]::Matches($txt, '[a-zA-Z0-9_\-]+\.dll', 'IgnoreCase') | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 20

Write-Host "==VC++ runtimes installed=="
Get-ChildItem 'C:\Windows\System32' -Filter 'vcruntime*.dll' -ErrorAction SilentlyContinue | Select-Object Name,Length
Get-ChildItem 'C:\Windows\System32' -Filter 'msvcp*.dll' -ErrorAction SilentlyContinue | Select-Object Name,Length

Write-Host "==better-sqlite3.node=="
$bs = 'C:\Users\dragos\companion-dev\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
Get-Item $bs | Select-Object Name,Length
EOF
$SSH "$PSCMD"
