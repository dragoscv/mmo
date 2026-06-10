#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion'
Write-Host "==RESOURCES=="
Get-ChildItem (Join-Path $root 'resources\virtual-audio') | Select-Object Name | Format-Table -AutoSize | Out-String
Get-ChildItem (Join-Path $root 'resources\virtual-audio\windows') | Select-Object Name,Length | Format-Table -AutoSize | Out-String

Write-Host "==KILL EXISTING=="
Get-Process -Name 'MMO Companion' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

Write-Host "==LAUNCH (background)=="
$logDir = "$env:LOCALAPPDATA\mmo-companion\logs"
$exe = Join-Path $root 'MMO Companion.exe'
Start-Process -FilePath $exe -WindowStyle Hidden
Start-Sleep -Seconds 12

Write-Host "==PROCESSES=="
Get-Process -Name 'MMO Companion' -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | Format-Table -AutoSize | Out-String

Write-Host "==PORT 17899=="
Get-NetTCPConnection -LocalPort 17899 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String

Write-Host "==HEALTH=="
try { (Invoke-RestMethod -Uri http://127.0.0.1:17899/health -TimeoutSec 5) | ConvertTo-Json -Compress } catch { Write-Host "health failed: $_" }

Write-Host "==LOG=="
$log = Get-ChildItem $logDir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($log) {
  Write-Host "Log file: $($log.FullName)"
  Get-Content $log.FullName -Tail 60 | Where-Object { $_ -notmatch 'ERROR:|gpu_init|GpuMemoryBuffer' }
} else {
  Write-Host "No log file"
}

Write-Host "==AUDIO DEVICES (after potential VAD install)=="
Get-CimInstance Win32_SoundDevice | Where-Object { $_.Name -match 'Virtual|MMO' } | Select-Object Name,Status | Format-Table -AutoSize | Out-String

Write-Host "==VAD DRIVER STATUS=="
$drv = & pnputil /enum-drivers
($drv -join "`n") -split "Published Name:" | Where-Object { $_ -match 'VirtualAudio|Virtual Audio' } | ForEach-Object { ($_ -split "`n" | Select-Object -First 5) -join "; " }
EOF

$SSH "$PSCMD"
