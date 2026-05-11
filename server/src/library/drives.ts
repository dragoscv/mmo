/**
 * Cross-platform connected-drive detection.
 *
 * The companion is the only component in the suite that runs on the
 * user's actual hardware, so this is where drive enumeration belongs.
 * The web app would otherwise see whatever the deployment runtime has
 * mounted (Vercel containers, Cloud Run, etc.) — useless to the user.
 *
 * No new dependencies. Uses platform-specific shell-outs with a Node
 * `fs.statfsSync` fallback so a permission-denied or missing tool
 * still surfaces *something* rather than crashing.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export interface DriveInfo {
    path: string;
    label: string;
    format: string;
    totalSize: number;
    freeSpace: number;
    usedSpace: number;
    /** "fixed" | "removable" | "network" | "unknown" — best-effort. */
    type: "fixed" | "removable" | "network" | "unknown";
}

export function listConnectedDrives(): DriveInfo[] {
    const platform = os.platform();
    try {
        if (platform === "win32") return listWindowsDrives();
        if (platform === "darwin") return listMacDrives();
        if (platform === "linux") return listLinuxDrives();
    } catch {
        // fall through to the bare-fs fallback
    }
    return listFallback();
}

// ── Windows: PowerShell Get-Volume → fall back to drive letter probe ──────

function listWindowsDrives(): DriveInfo[] {
    try {
        const output = execSync(
            "powershell -NoProfile -Command \"Get-Volume | Where-Object { $_.DriveLetter -ne $null -and ($_.DriveType -eq 'Fixed' -or $_.DriveType -eq 'Removable') } | Select-Object DriveLetter, FileSystemLabel, FileSystem, DriveType, Size, SizeRemaining | ConvertTo-Json\"",
            { encoding: "utf-8", timeout: 10_000 },
        );
        const parsed = JSON.parse(output);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        return arr
            .filter((v: Record<string, unknown>) => v.DriveLetter && v.Size)
            .map((v: Record<string, unknown>): DriveInfo => {
                const total = Number(v.Size) || 0;
                const free = Number(v.SizeRemaining) || 0;
                const dt = String(v.DriveType ?? "").toLowerCase();
                return {
                    path: `${v.DriveLetter}:\\`,
                    label: (v.FileSystemLabel as string) || `Drive ${v.DriveLetter}`,
                    format: (v.FileSystem as string) || "Unknown",
                    totalSize: total,
                    freeSpace: free,
                    usedSpace: total - free,
                    type: dt === "removable" ? "removable" : dt === "fixed" ? "fixed" : "unknown",
                };
            });
    } catch {
        return windowsLetterProbe();
    }
}

function windowsLetterProbe(): DriveInfo[] {
    const drives: DriveInfo[] = [];
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
        const drivePath = `${letter}:\\`;
        try {
            if (!fs.existsSync(drivePath)) continue;
            const s = fs.statfsSync(drivePath);
            const total = Number(s.bsize) * Number(s.blocks);
            const free = Number(s.bsize) * Number(s.bavail);
            drives.push({
                path: drivePath,
                label: `Drive ${letter}`,
                format: "Unknown",
                totalSize: total,
                freeSpace: free,
                usedSpace: total - free,
                type: "unknown",
            });
        } catch {
            // drive not accessible — skip silently
        }
    }
    return drives;
}

// ── macOS: enumerate /Volumes/* ───────────────────────────────────────────

function listMacDrives(): DriveInfo[] {
    const drives: DriveInfo[] = [];
    let entries: string[] = [];
    try {
        entries = fs.readdirSync("/Volumes");
    } catch {
        return drives;
    }
    for (const name of entries) {
        const path = `/Volumes/${name}`;
        try {
            const stat = fs.statSync(path);
            if (!stat.isDirectory()) continue;
            const s = fs.statfsSync(path);
            const total = Number(s.bsize) * Number(s.blocks);
            const free = Number(s.bsize) * Number(s.bavail);
            drives.push({
                path,
                label: name,
                format: "Unknown",
                totalSize: total,
                freeSpace: free,
                usedSpace: total - free,
                type: "unknown",
            });
        } catch {
            // skip
        }
    }
    return drives;
}

// ── Linux: /proc/mounts → filter to real mounts ───────────────────────────

const LINUX_REAL_FS = new Set([
    "ext2", "ext3", "ext4", "btrfs", "xfs", "zfs",
    "vfat", "exfat", "ntfs", "ntfs3", "f2fs",
    "fuseblk", "iso9660", "udf",
]);

function listLinuxDrives(): DriveInfo[] {
    const drives: DriveInfo[] = [];
    let mounts: string;
    try {
        mounts = fs.readFileSync("/proc/mounts", "utf-8");
    } catch {
        return drives;
    }
    for (const line of mounts.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split(" ");
        if (parts.length < 3) continue;
        const [, mountPoint, fsType] = parts;
        if (!LINUX_REAL_FS.has(fsType)) continue;
        try {
            const s = fs.statfsSync(mountPoint);
            const total = Number(s.bsize) * Number(s.blocks);
            const free = Number(s.bsize) * Number(s.bavail);
            if (total === 0) continue;
            drives.push({
                path: mountPoint,
                label: mountPoint,
                format: fsType,
                totalSize: total,
                freeSpace: free,
                usedSpace: total - free,
                type: mountPoint.startsWith("/media/") || mountPoint.startsWith("/mnt/")
                    ? "removable"
                    : "fixed",
            });
        } catch {
            // skip
        }
    }
    return drives;
}

// ── Last-resort fallback (any platform) ───────────────────────────────────

function listFallback(): DriveInfo[] {
    const home = os.homedir();
    try {
        const s = fs.statfsSync(home);
        const total = Number(s.bsize) * Number(s.blocks);
        const free = Number(s.bsize) * Number(s.bavail);
        return [{
            path: home,
            label: "Home",
            format: "Unknown",
            totalSize: total,
            freeSpace: free,
            usedSpace: total - free,
            type: "fixed",
        }];
    } catch {
        return [];
    }
}
