#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 -p 2222 dragos@172.23.192.1"

read -r -d '' PSCMD <<'EOF'
$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class Pnp
{
    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVINFO_DATA
    {
        public int cbSize;
        public Guid ClassGuid;
        public int DevInst;
        public IntPtr Reserved;
    }

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid ClassGuid, IntPtr hwndParent);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiCreateDeviceInfo(
        IntPtr DeviceInfoSet,
        string DeviceName,
        ref Guid ClassGuid,
        string DeviceDescription,
        IntPtr hwndParent,
        int CreationFlags,
        ref SP_DEVINFO_DATA DeviceInfoData);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiSetDeviceRegistryProperty(
        IntPtr DeviceInfoSet,
        ref SP_DEVINFO_DATA DeviceInfoData,
        int Property,
        byte[] PropertyBuffer,
        int PropertyBufferSize);

    [DllImport("setupapi.dll", SetLastError = true)]
    public static extern bool SetupDiCallClassInstaller(
        int InstallFunction,
        IntPtr DeviceInfoSet,
        ref SP_DEVINFO_DATA DeviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    public static extern bool SetupDiDestroyDeviceInfoList(IntPtr DeviceInfoSet);

    [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool UpdateDriverForPlugAndPlayDevices(
        IntPtr hwndParent,
        string HardwareId,
        string FullInfPath,
        int InstallFlags,
        out bool bRebootRequired);
}
'@

Add-Type -TypeDefinition $src -Language CSharp

$mediaGuid = [Guid]'4d36e96c-e325-11ce-bfc1-08002be10318'
$DICD_GENERATE_ID = 1
$DIF_REGISTERDEVICE = 0x19
$SPDRP_HARDWAREID = 1
$INSTALLFLAG_FORCE = 1

Write-Host "==CREATE DEVICE INFO LIST=="
$devInfoSet = [Pnp]::SetupDiCreateDeviceInfoList([ref]$mediaGuid, [IntPtr]::Zero)
if ($devInfoSet -eq -1 -or $devInfoSet -eq [IntPtr]::Zero) { throw "SetupDiCreateDeviceInfoList failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$devData = New-Object Pnp+SP_DEVINFO_DATA
$devData.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($devData)

Write-Host "==CREATE DEVICE INFO=="
$ok = [Pnp]::SetupDiCreateDeviceInfo($devInfoSet, "MEDIA", [ref]$mediaGuid, $null, [IntPtr]::Zero, $DICD_GENERATE_ID, [ref]$devData)
if (-not $ok) { throw "SetupDiCreateDeviceInfo failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

Write-Host "==SET HARDWARE ID=="
$hwid = "ROOT\VirtualAudioDriver`0`0"
$bytes = [System.Text.Encoding]::Unicode.GetBytes($hwid)
$ok = [Pnp]::SetupDiSetDeviceRegistryProperty($devInfoSet, [ref]$devData, $SPDRP_HARDWAREID, $bytes, $bytes.Length)
if (-not $ok) { throw "SetupDiSetDeviceRegistryProperty failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

Write-Host "==REGISTER DEVICE=="
$ok = [Pnp]::SetupDiCallClassInstaller($DIF_REGISTERDEVICE, $devInfoSet, [ref]$devData)
if (-not $ok) { throw "SetupDiCallClassInstaller failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[Pnp]::SetupDiDestroyDeviceInfoList($devInfoSet) | Out-Null

Write-Host "==UPDATE DRIVER (bind .inf to new device)=="
$inf = 'C:\Users\dragos\AppData\Local\Programs\mmo-companion\resources\virtual-audio\windows\VirtualAudioDriver.inf'
$reboot = $false
$ok = [Pnp]::UpdateDriverForPlugAndPlayDevices([IntPtr]::Zero, 'ROOT\VirtualAudioDriver', $inf, $INSTALLFLAG_FORCE, [ref]$reboot)
if (-not $ok) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "UpdateDriverForPlugAndPlayDevices failed: $err"
} else {
    Write-Host "UpdateDriverForPlugAndPlayDevices OK, rebootRequired=$reboot"
}

Write-Host ""
Write-Host "==MEDIA DEVICES=="
Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Format-Table Status,FriendlyName,InstanceId -AutoSize -Wrap
Write-Host "==Win32_SoundDevice=="
Get-CimInstance Win32_SoundDevice | Format-Table Name,Status,Manufacturer -AutoSize -Wrap
Write-Host "==Audio Endpoints (MMDevice via WMI)=="
Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Virtual|MTT' } | Format-Table Status,FriendlyName,InstanceId -AutoSize -Wrap
EOF

$SSH "$PSCMD"
