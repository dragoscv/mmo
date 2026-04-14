import { execSync } from "node:child_process";
import fs from "node:fs";

export interface DriveInfo {
  path: string;
  label: string;
  format: string;
  totalSize: number;
  freeSpace: number;
  usedSpace: number;
}

export function getConnectedDrives(): DriveInfo[] {
  try {
    // Use PowerShell to get drive info on Windows
    const output = execSync(
      'powershell -Command "Get-Volume | Where-Object { $_.DriveLetter -ne $null -and $_.DriveType -eq \'Fixed\' -or $_.DriveType -eq \'Removable\' } | Select-Object DriveLetter, FileSystemLabel, FileSystem, Size, SizeRemaining | ConvertTo-Json"',
      { encoding: "utf-8", timeout: 10000 }
    );

    const volumes = JSON.parse(output);
    const volumeArray = Array.isArray(volumes) ? volumes : [volumes];

    return volumeArray
      .filter((v: Record<string, unknown>) => v.DriveLetter && v.Size)
      .map((v: Record<string, unknown>) => ({
        path: `${v.DriveLetter}:\\`,
        label: (v.FileSystemLabel as string) || `Drive ${v.DriveLetter}`,
        format: (v.FileSystem as string) || "Unknown",
        totalSize: v.Size as number,
        freeSpace: v.SizeRemaining as number,
        usedSpace: (v.Size as number) - (v.SizeRemaining as number),
      }));
  } catch {
    // Fallback: check common drive letters
    return getConnectedDrivesFallback();
  }
}

function getConnectedDrivesFallback(): DriveInfo[] {
  const drives: DriveInfo[] = [];
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZ";

  for (const letter of letters) {
    const drivePath = `${letter}:\\`;
    try {
      if (fs.existsSync(drivePath)) {
        const stats = fs.statfsSync(drivePath);
        drives.push({
          path: drivePath,
          label: `Drive ${letter}`,
          format: "Unknown",
          totalSize: Number(stats.bsize) * Number(stats.blocks),
          freeSpace: Number(stats.bsize) * Number(stats.bavail),
          usedSpace:
            Number(stats.bsize) *
            (Number(stats.blocks) - Number(stats.bavail)),
        });
      }
    } catch {
      // Drive not accessible
    }
  }

  return drives;
}
