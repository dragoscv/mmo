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
import { spawnSync } from "node:child_process";

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

/** fpcalc (chromaprint) binary. Not bundled — must be installed by the
 *  user on PATH (or set MMO_FPCALC env). Returns null if not found. */
export const FPCALC_BIN: string | null = (() => {
    const envPath = process.env.MMO_FPCALC;
    if (envPath && fs.existsSync(envPath)) return envPath;
    const binName = process.platform === "win32" ? "fpcalc.exe" : "fpcalc";
    const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const candidate = path.join(dir, binName);
        try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
    }
    return null;
})();

export type HwAccel = "nvenc" | "qsv" | "videotoolbox" | "vaapi" | "none";

let cachedHwAccel: HwAccel | null = null;
let cachedEncoders: string | null = null;

function probeEncoders(): string {
    if (cachedEncoders !== null) return cachedEncoders;
    try {
        const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-encoders"], {
            encoding: "utf8",
            timeout: 5000,
            windowsHide: true,
        });
        cachedEncoders = (r.stdout || "") + (r.stderr || "");
    } catch {
        cachedEncoders = "";
    }
    return cachedEncoders;
}

export function detectHwAccel(): HwAccel {
    if (cachedHwAccel) return cachedHwAccel;
    const plat = process.platform;
    // Allow override via env.
    const forced = (process.env.MMO_HWACCEL || "").toLowerCase() as HwAccel | "";
    if (forced && ["nvenc", "qsv", "videotoolbox", "vaapi", "none"].includes(forced)) {
        return (cachedHwAccel = forced as HwAccel);
    }
    if (plat === "darwin") return (cachedHwAccel = "videotoolbox");

    // Probe ffmpeg once at first call to see which hardware encoders
    // were compiled in. Heuristic preference: NVENC > QSV > VAAPI.
    const enc = probeEncoders();
    if (enc.includes("h264_nvenc")) return (cachedHwAccel = "nvenc");
    if (plat === "win32" && enc.includes("h264_qsv")) return (cachedHwAccel = "qsv");
    if (plat === "linux" && enc.includes("h264_vaapi")) return (cachedHwAccel = "vaapi");
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

/** Encoder-specific quality / preset args. nvenc, qsv and videotoolbox
 *  don't accept `-crf` — pass the right knob for each. Returns a flat
 *  argv slice ready to splice into the ffmpeg command line. */
export function qualityArgsFor(accel: HwAccel, quality: number = 22): string[] {
    switch (accel) {
        case "nvenc":
            // p1 = fastest, p7 = best quality. p4 is the sweet spot for
            // live transcode. `-rc vbr -cq N` mirrors x264 `-crf N` semantics.
            return ["-preset", "p4", "-tune", "hq", "-rc", "vbr", "-cq", String(quality), "-b:v", "0"];
        case "qsv":
            return ["-preset", "fast", "-global_quality", String(quality), "-look_ahead", "0"];
        case "videotoolbox":
            // videotoolbox uses a 0-100 quality scale (higher = better).
            // Map x264 CRF 22 → ~65.
            return ["-q:v", "65"];
        case "vaapi":
            return ["-qp", String(quality)];
        default:
            return ["-preset", "veryfast", "-crf", String(quality)];
    }
}
