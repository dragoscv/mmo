#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"
read -r -d '' PSCMD <<'EOF'
Write-Host "==/health (local)=="
try {
  $r = Invoke-WebRequest -Uri http://127.0.0.1:17899/health -UseBasicParsing -TimeoutSec 5
  Write-Host "HTTP $($r.StatusCode)"
  Write-Host $r.Content.Substring(0, [Math]::Min(200, $r.Content.Length))
} catch {
  Write-Host "ERR: $($_.Exception.Message)"
}
Write-Host ""
Write-Host "==/api/va/probe=="
try {
  $r = Invoke-WebRequest -Uri http://127.0.0.1:17899/api/va/probe -UseBasicParsing -TimeoutSec 5
  Write-Host "HTTP $($r.StatusCode)"
  Write-Host $r.Content
} catch {
  Write-Host "ERR: $($_.Exception.Message)"
}
Write-Host ""
Write-Host "==process/PID 1684=="
Get-Process -Id 1684 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime,Path
EOF
$SSH "$PSCMD"
