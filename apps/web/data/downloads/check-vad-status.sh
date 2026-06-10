#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
Write-Host "==DEVICE PROPERTIES (Problem code)=="
$dev = Get-PnpDevice -InstanceId 'ROOT\MEDIA\0000'
$dev | Format-List FriendlyName,Status,Class
$problemProps = @('DEVPKEY_Device_ProblemCode','DEVPKEY_Device_ProblemStatus','DEVPKEY_Device_DriverVersion','DEVPKEY_Device_DriverProvider')
foreach ($p in $problemProps) {
  $v = Get-PnpDeviceProperty -InstanceId 'ROOT\MEDIA\0000' -KeyName $p -ErrorAction SilentlyContinue
  if ($v) { Write-Host "$p = $($v.Data)" }
}

Write-Host ""
Write-Host "==AUDIO SERVICES=="
Get-Service Audiosrv,AudioEndpointBuilder,MMCSS -ErrorAction SilentlyContinue | Format-Table Name,Status,StartType -AutoSize

Write-Host "==START AUDIO SERVICES IF NEEDED=="
Set-Service Audiosrv -StartupType Automatic -ErrorAction SilentlyContinue
Set-Service AudioEndpointBuilder -StartupType Automatic -ErrorAction SilentlyContinue
Start-Service AudioEndpointBuilder -ErrorAction SilentlyContinue
Start-Service Audiosrv -ErrorAction SilentlyContinue
Get-Service Audiosrv,AudioEndpointBuilder | Format-Table Name,Status -AutoSize

Write-Host "==RESCAN DEVICE=="
Disable-PnpDevice -InstanceId 'ROOT\MEDIA\0000' -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep 2
Enable-PnpDevice -InstanceId 'ROOT\MEDIA\0000' -Confirm:$false -ErrorAction SilentlyContinue
Start-Sleep 3
Get-PnpDevice -InstanceId 'ROOT\MEDIA\0000' | Format-List FriendlyName,Status

Write-Host ""
Write-Host "==FINAL STATE=="
Get-PnpDevice -Class MEDIA | Format-Table Status,FriendlyName,InstanceId -AutoSize -Wrap
Get-CimInstance Win32_SoundDevice | Format-Table Name,Status,Manufacturer -AutoSize -Wrap

Write-Host "==MMDEVICE ENDPOINTS (audio render/capture)=="
$shell = New-Object -ComObject MMDeviceAPI.MMDeviceEnumerator -ErrorAction SilentlyContinue
# fallback via [audio]:: not available; use registry
Write-Host "From registry MMDevices:"
$base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
foreach ($b in $base) {
  Write-Host "--- $b ---"
  Get-ChildItem $b -ErrorAction SilentlyContinue | ForEach-Object {
    $name = (Get-ItemProperty (Join-Path $_.PSPath 'Properties') -Name '{a45c254e-df1c-4efd-8020-67d146a850e0},2' -ErrorAction SilentlyContinue).'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $devState = (Get-ItemProperty $_.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
    Write-Host ("  state={0}  name={1}" -f $devState, $name)
  }
}
EOF

$SSH "$PSCMD"
