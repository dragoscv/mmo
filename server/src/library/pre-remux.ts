/**
 * Background pre-remux job — produces a sidecar `<basename>.mmo.mp4`
 * next to each source video. The sidecar has the same video stream
 * (copied, never re-encoded) inside a fragment-friendly MP4 container
 * with `+faststart`, plus an AAC stereo audio track. Subsequent
 * playback can then realtime-remux from the sidecar with near-zero
 * CPU instead of from the original (often DTS / EAC3 / 7.1 / TS / MKV)
 * source.
 *
 * Single-flight: one ffmpeg at a time so pre-remux never competes with
 * live playback for the GPU / disk bandwidth. Queue order is FIFO.
 *
 * Status is purely in-memory; we don't persist progress to the SQLite
 * store. A killed companion just loses the queue (sidecars that
 * finished remain on disk and are discovered on demand). That's fine
 * \u2014 the operation is idempotent: re-enqueuing skips files whose
 * sidecar already exists with non-zero size.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { FFMPEG_BIN } from "./ffmpeg-paths";

export type PreRemuxStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface PreRemuxJob {
    fileId: string;
    sourcePath: string;
    sidecarPath: string;
    status: PreRemuxStatus;
    /** 0..1 progress, only meaningful while `status === "running"`. */
    progress: number;
    /** Source duration in seconds; needed to derive progress. */
    durationSec: number | null;
    error: string | null;
    enqueuedAt: number;
    startedAt: number | null;
    finishedAt: number | null;
}

const jobs = new Map<string, PreRemuxJob>();
let activeProc: ChildProcess | null = null;
let activeFileId: string | null = null;
const bus = new EventEmitter();

export function preRemuxBus(): EventEmitter {
    return bus;
}

/** Sidecar path: same directory, original basename suffixed with
 *  `.mmo.mp4`. Doesn't clobber the source. */
export function sidecarPathFor(sourcePath: string): string {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    return path.join(dir, `${base}.mmo.mp4`);
}

/** Returns the sidecar path when one exists with non-zero size, else null. */
export function sidecarIfExists(sourcePath: string): string | null {
    const p = sidecarPathFor(sourcePath);
    try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size > 0) return p;
    } catch { /* ignore */ }
    return null;
}

export function getPreRemuxJob(fileId: string): PreRemuxJob | null {
    return jobs.get(fileId) ?? null;
}

export function listPreRemuxJobs(): PreRemuxJob[] {
    return [...jobs.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
}

export function cancelPreRemux(fileId: string): boolean {
    const job = jobs.get(fileId);
    if (!job) return false;
    if (job.status === "running" && activeFileId === fileId && activeProc) {
        try {
            if (process.platform === "win32" && activeProc.pid) {
                spawn("taskkill", ["/F", "/T", "/PID", String(activeProc.pid)], { windowsHide: true, stdio: "ignore" });
            } else {
                activeProc.kill("SIGKILL");
            }
        } catch { /* ignore */ }
    }
    jobs.delete(fileId);
    bus.emit("change", { fileId, removed: true });
    return true;
}

/** Adds the file to the queue. Returns the (possibly already-existing) job.
 *  Idempotent: if the sidecar already exists, returns a terminal `skipped` job
 *  and never spawns ffmpeg. */
export function enqueuePreRemux(
    fileId: string,
    sourcePath: string,
    durationSec: number | null = null,
): PreRemuxJob {
    const sidecarPath = sidecarPathFor(sourcePath);
    if (sidecarIfExists(sourcePath)) {
        const skipped: PreRemuxJob = {
            fileId, sourcePath, sidecarPath,
            status: "skipped",
            progress: 1,
            durationSec,
            error: null,
            enqueuedAt: Date.now(),
            startedAt: null,
            finishedAt: Date.now(),
        };
        jobs.set(fileId, skipped);
        bus.emit("change", skipped);
        return skipped;
    }
    const existing = jobs.get(fileId);
    if (existing && (existing.status === "queued" || existing.status === "running")) {
        return existing;
    }
    const job: PreRemuxJob = {
        fileId, sourcePath, sidecarPath,
        status: "queued",
        progress: 0,
        durationSec,
        error: null,
        enqueuedAt: Date.now(),
        startedAt: null,
        finishedAt: null,
    };
    jobs.set(fileId, job);
    bus.emit("change", job);
    void pumpQueue();
    return job;
}

let pumping = false;
async function pumpQueue(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
        while (true) {
            const next = pickNextQueued();
            if (!next) break;
            await runOne(next);
        }
    } finally {
        pumping = false;
    }
}

function pickNextQueued(): PreRemuxJob | null {
    let best: PreRemuxJob | null = null;
    for (const j of jobs.values()) {
        if (j.status !== "queued") continue;
        if (!best || j.enqueuedAt < best.enqueuedAt) best = j;
    }
    return best;
}

async function runOne(job: PreRemuxJob): Promise<void> {
    // Final guard: file might have appeared in the meantime (manual
    // ffmpeg run, multi-instance companion, etc).
    if (sidecarIfExists(job.sourcePath)) {
        job.status = "skipped";
        job.progress = 1;
        job.finishedAt = Date.now();
        bus.emit("change", job);
        return;
    }
    if (!fs.existsSync(job.sourcePath)) {
        job.status = "failed";
        job.error = "source file missing";
        job.finishedAt = Date.now();
        bus.emit("change", job);
        return;
    }

    job.status = "running";
    job.startedAt = Date.now();
    job.progress = 0;
    bus.emit("change", job);

    // Write to a temp path first, then rename on success so a crashed
    // ffmpeg never leaves a half-written sidecar that the playback
    // layer would happily pick up.
    const tmpOut = `${job.sidecarPath}.partial`;
    try { await fsp.unlink(tmpOut); } catch { /* not present */ }

    const args = [
        "-y",
        "-loglevel", "warning",
        "-i", job.sourcePath,
        // Map first video + first audio. Subs are dropped \u2014 they're
        // surfaced separately via `/video/subs/:fileId/:track`.
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-sn",
        // Video stays as-is. Add `hvc1` tag when source is HEVC so the
        // resulting MP4 plays via Chromium MSE without re-tagging.
        "-c:v", "copy",
        "-tag:v", "hvc1",
        // Audio: AAC stereo. Universally supported and a 6-channel
        // EAC3 source that Edge could decode in remux mode but Chrome
        // couldn't is the most common case we care about.
        "-af", "aformat=channel_layouts=stereo:sample_rates=48000",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k",
        // Plain MP4 (NOT fragmented) with `+faststart` so the moov
        // atom is rewritten to the front of the file after the second
        // pass. This gives browsers a complete sample index up-front,
        // which is what HTTP range-based direct play needs for instant
        // seek to any position. Fragmented MP4 (`+empty_moov`) would
        // force the browser to walk fragments sequentially to find a
        // keyframe and adds ~10s startup latency on large 4K files.
        // The HLS path doesn't care — ffmpeg re-segments from this
        // sidecar regardless of its container layout.
        "-movflags", "+faststart",
        "-f", "mp4",
        // ffmpeg progress on stdout in key=value pairs (one per line).
        "-progress", "pipe:1",
        "-nostats",
        tmpOut,
    ];

    activeFileId = job.fileId;
    activeProc = spawn(FFMPEG_BIN, args, { windowsHide: true });

    let lastStderr = "";
    activeProc.stderr?.on("data", (b) => {
        lastStderr = (lastStderr + b.toString("utf8")).slice(-4000);
    });

    activeProc.stdout?.on("data", (b) => {
        // `out_time_ms=<microseconds>` despite the name (ffmpeg quirk).
        const text = b.toString("utf8");
        const m = text.match(/out_time_ms=(\d+)/g);
        if (!m || !job.durationSec || job.durationSec <= 0) return;
        const last = m[m.length - 1];
        const microsStr = last.split("=")[1];
        const seconds = parseInt(microsStr, 10) / 1_000_000;
        const next = Math.max(0, Math.min(1, seconds / job.durationSec));
        // Throttle bus emissions to every ~1%.
        if (next - job.progress >= 0.01) {
            job.progress = next;
            bus.emit("change", job);
        }
    });

    const exitCode: number | null = await new Promise((resolve) => {
        activeProc!.on("error", () => resolve(-1));
        activeProc!.on("exit", (code) => resolve(code));
    });
    const wasActive = activeFileId === job.fileId;
    activeProc = null;
    activeFileId = null;

    // If the job was cancelled (removed from `jobs`) mid-run, don't
    // resurrect the entry; just clean up the partial.
    if (!jobs.has(job.fileId)) {
        try { await fsp.unlink(tmpOut); } catch { /* ignore */ }
        return;
    }

    if (exitCode === 0 && wasActive && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
        try {
            await fsp.rename(tmpOut, job.sidecarPath);
            job.status = "done";
            job.progress = 1;
            job.finishedAt = Date.now();
            bus.emit("change", job);
            return;
        } catch (e) {
            job.status = "failed";
            job.error = `rename failed: ${(e as Error).message}`;
            job.finishedAt = Date.now();
            bus.emit("change", job);
            try { await fsp.unlink(tmpOut); } catch { /* ignore */ }
            return;
        }
    }

    job.status = "failed";
    job.error = lastStderr.trim().split("\n").slice(-4).join(" | ") || `ffmpeg exited ${exitCode}`;
    job.finishedAt = Date.now();
    bus.emit("change", job);
    try { await fsp.unlink(tmpOut); } catch { /* ignore */ }
}
