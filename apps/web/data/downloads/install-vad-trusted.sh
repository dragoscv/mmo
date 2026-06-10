#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Continue'
$drv = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion\resources\virtual-audio\windows'
$sys = Join-Path $drv 'VirtualAudioDriver.sys'
$cat = Join-Path $drv 'VirtualAudioDriver.cat'
$inf = Join-Path $drv 'VirtualAudioDriver.inf'

Write-Host "==EXTRACT CERT FROM .sys=="
$cert = (Get-AuthenticodeSignature $sys).SignerCertificate
$cert | Format-List Subject,Issuer,Thumbprint,NotAfter
$cerPath = "$env:TEMP\vad-publisher.cer"
[IO.File]::WriteAllBytes($cerPath, $cert.Export('Cert'))
Write-Host "wrote $cerPath ($((Get-Item $cerPath).Length) bytes)"

Write-Host "==IMPORT TO TrustedPublisher (LocalMachine)=="
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Format-Table Subject,Thumbprint -AutoSize
Write-Host "==IMPORT TO Root (LocalMachine)=="
Import-Certificate -FilePath $cerPath -CertStoreLocation Cert:\LocalMachine\Root | Format-Table Subject,Thumbprint -AutoSize

Write-Host "==RETRY pnputil=="
& pnputil.exe /add-driver $inf /install 2>&1
Write-Host "exitcode=$LASTEXITCODE"

Write-Host "==DRIVERS AFTER=="
pnputil /enum-drivers 2>&1 | Select-String -Pattern 'VirtualAudio|Published Name|Driver package provider|Class Name' -Context 0,1 | Select-Object -First 40

Write-Host "==SOUND DEVICES=="
Get-CimInstance Win32_SoundDevice | Select-Object Name,Status,Manufacturer,DeviceID | Format-Table -AutoSize -Wrap

Write-Host "==PNP DEVICES (Audio)=="
Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Select-Object Status,FriendlyName,InstanceId | Format-Table -AutoSize -Wrap
EOF

$SSH "$PSCMD"
