/**
 * Shared ffmpeg runner for everything that is NOT live playback.
 *
 * Measured 2026-11-03 on a 4K HDR HEVC film: a full-decode sprite took
 * 11.6 cores, silencedetect without `-vn` 11.5 cores, loudnorm 6.9 cores —
 * and every browsed card or played file started its own process with no
 * global limit. This module enforces:
 *   - one analysis at a time (FIFO queue), so N cards never mean N decodes;
 *   - `-threads 1` style caps are the caller's job, but every process runs at
 *     the lowest OS priority (IDLE on Windows, nice 19 elsewhere), so live
 *     playback and the rest of the machine always win;
 *   - a hard timeout and a full process-tree kill.
 */

import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { FFMPEG_BIN } from "./ffmpeg-paths";

export interface FfmpegResult { code: number | null; stdout: Buffer; stderr: string }

interface QueueItem { run: () => Promise<void> }

const MAX_ANALYSIS_CONCURRENCY = Math.max(1, Number(process.env.MMO_ANALYSIS_CONCURRENCY) || 1);
const queue: QueueItem[] = [];
let active = 0;

function pump(): void {
    while (active < MAX_ANALYSIS_CONCURRENCY && queue.length > 0) {
        const item = queue.shift()!;
        active++;
        void item.run().finally(() => { active--; pump(); });
    }
}

/** Run `fn` inside the global analysis slot (FIFO, concurrency 1 by default). */
export function withAnalysisSlot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        queue.push({ run: () => fn().then(resolve, reject) });
        pump();
    });
}

export function analysisQueueStats(): { active: number; queued: number; concurrency: number } {
    return { active, queued: queue.length, concurrency: MAX_ANALYSIS_CONCURRENCY };
}

/** Small FIFO limiter for short interactive work (card stills: one keyframe,
 *  ~0.5 s each) so it is not stuck behind a long sprite build. */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
    const q: Array<() => void> = [];
    let running = 0;
    const next = () => {
        if (running >= concurrency) return;
        const start = q.shift();
        if (start) { running++; start(); }
    };
    return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
        q.push(() => { fn().then(resolve, reject).finally(() => { running--; next(); }); });
        next();
    });
}

export type ProcPriority = "idle" | "below-normal";

/** Lower an already-spawned process' OS priority. Never throws. */
export function lowerPriority(pid: number | undefined, level: ProcPriority): void {
    if (!pid) return;
    const p = os.constants.priority;
    try {
        os.setPriority(pid, level === "idle" ? p.PRIORITY_LOW : p.PRIORITY_BELOW_NORMAL);
    } catch { /* process already gone or not permitted */ }
}

export function killTree(pid: number | undefined): void {
    if (!pid) return;
    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
        } else {
            process.kill(pid, "SIGKILL");
        }
    } catch { /* ignore */ }
}

/** Spawn ffmpeg at IDLE priority and collect its output. Does NOT take the
 *  analysis slot — wrap in `withAnalysisSlot` for background work. */
export function runFfmpeg(args: string[], opts: { timeoutMs?: number; bin?: string; priority?: ProcPriority } = {}): Promise<FfmpegResult> {
    const bin = opts.bin ?? FFMPEG_BIN;
    return new Promise((resolve) => {
        const child = spawn(bin, args, { windowsHide: true });
        lowerPriority(child.pid, opts.priority ?? "idle");
        const out: Buffer[] = [];
        let stderr = "";
        child.stdout?.on("data", (b: Buffer) => out.push(b));
        child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-64_000); });
        const timer = setTimeout(() => killTree(child.pid), opts.timeoutMs ?? 10 * 60_000);
        timer.unref();
        child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: Buffer.concat(out), stderr }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr }); });
    });
}

let readrateSupport: boolean | null = null;
/** `-readrate_initial_burst` exists since ffmpeg 6.1. Probed once. */
export function supportsReadrateBurst(): boolean {
    if (readrateSupport !== null) return readrateSupport;
    try {
        const r = spawnSync(FFMPEG_BIN, ["-hide_banner", "-h", "long"], { encoding: "utf8", timeout: 5000, windowsHide: true });
        readrateSupport = `${r.stdout ?? ""}${r.stderr ?? ""}`.includes("readrate_initial_burst");
    } catch {
        readrateSupport = false;
    }
    return readrateSupport;
}
