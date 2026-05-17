/**
 * Resolve ffmpeg / ffprobe binary paths.
 *
 * In dev: uses ffmpeg-static + ffprobe-static (npm packages).
 * In packaged build: those packages ship the binaries inside the asar,
 * so we resolve them via `app.asar.unpacked` (electron-builder
 * automatically unpacks them when listed in asarUnpack).
 */

import path from "node:path";
import fs from "node:fs";

function resolveStaticBin(pkg: string, binName: string): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const p = require(pkg) as string | undefined;
        if (p && fs.existsSync(p)) return p;
    } catch { /* fall through */ }
    // Packaged: app.asar.unpacked/node_modules/<pkg>/<bin>
    const unpacked = path.join(
        process.resourcesPath || "",
        "app.asar.unpacked",
        "node_modules",
        pkg,
        binName + (process.platform === "win32" ? ".exe" : ""),
    );
    if (fs.existsSync(unpacked)) return unpacked;
    return binName; // fall back to PATH
}

export const FFMPEG_BIN = resolveStaticBin("ffmpeg-static", "ffmpeg");
export const FFPROBE_BIN = (() => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const probe = require("ffprobe-static") as { path?: string };
        if (probe?.path && fs.existsSync(probe.path)) return probe.path;
    } catch { /* fall through */ }
    return resolveStaticBin("ffprobe-static", "ffprobe");
})();

export type HwAccel = "nvenc" | "qsv" | "videotoolbox" | "vaapi" | "none";

let cachedHwAccel: HwAccel | null = null;

export function detectHwAccel(): HwAccel {
    if (cachedHwAccel) return cachedHwAccel;
    const plat = process.platform;
    if (plat === "darwin") return (cachedHwAccel = "videotoolbox");
    // For Windows/Linux we'd ideally probe ffmpeg -hwaccels — but that's a
    // sync exec we don't want at hot path. Heuristic: prefer NVENC if
    // CUDA env is present; else QSV on Windows; else VAAPI on Linux.
    if (process.env.CUDA_PATH || process.env.NVIDIA_VISIBLE_DEVICES) {
        return (cachedHwAccel = "nvenc");
    }
    if (plat === "win32") return (cachedHwAccel = "qsv");
    if (plat === "linux") return (cachedHwAccel = "vaapi");
    return (cachedHwAccel = "none");
}

export function videoEncoderFor(accel: HwAccel): string {
    switch (accel) {
        case "nvenc": return "h264_nvenc";
        case "qsv": return "h264_qsv";
        case "videotoolbox": return "h264_videotoolbox";
        case "vaapi": return "h264_vaapi";
        default: return "libx264";
    }
}
