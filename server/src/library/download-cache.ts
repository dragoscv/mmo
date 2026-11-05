/**
 * Offline downloads for iOS (WP16-50, D37): MP4 remux with `-c copy`, produced through the global
 * ffmpeg analysis slot into `<userData>/downloads-cache`, LRU-evicted by size (default cap 20 GB).
 *
 *   - Video is NEVER re-encoded (`-c:v copy`, HEVC tagged `hvc1` so AVPlayer accepts it).
 *   - Audio track `n` is copied when AAC / AC-3 / E-AC-3, else converted with the playback policy
 *     (`audioTranscodeArgs(["eac3"])` = E-AC-3 5.1 640k, which every iPhone decodes).
 *   - Text subtitle tracks become `mov_text`; bitmap tracks (PGS/VobSub) are dropped.
 *   - Android downloads use the original file (`GET /video/file/:fileId`), not this cache.
 *
 * Everything that touches ffmpeg is injectable (`run`, `slot`) so the route logic is testable.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { audioTranscodeArgs } from "./transcode-video";
import { isBitmapSub } from "./video-subs";

export const DEFAULT_CACHE_CAP_BYTES = 20 * 1024 ** 3;
const AUDIO_COPY_MP4 = new Set(["aac", "ac3", "eac3"]);
const TEXT_SUBS_MP4 = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

export interface MediaTracks {
    videoCodec: string | null;
    durationSec: number | null;
    audioTracks: { codec: string | null; channels: number | null }[];
    subtitleTracks: { codec: string | null }[];
}

export type DownloadState = "queued" | "running" | "done" | "failed";

export interface DownloadJob {
    jobId: string;
    fileId: string;
    audio: number;
    state: DownloadState;
    /** 0..1 */
    progress: number;
    error: string | null;
    sizeBytes: number | null;
    createdAt: number;
    finishedAt: number | null;
}

export type RunRemux = (args: string[], onProgressSec: (sec: number) => void) => Promise<{ code: number | null; stderr: string }>;
export type Slot = <T>(fn: () => Promise<T>) => Promise<T>;

export interface DownloadCacheOptions {
    dir: string;
    getCapBytes?: () => number;
    run: RunRemux;
    slot: Slot;
    now?: () => number;
    onReady?: (job: DownloadJob, title: string) => void;
    log?: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}

/** Pure: ffmpeg args for the MP4 remux. */
export function remuxMp4Args(input: string, output: string, audio: number, t: MediaTracks): string[] {
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", input, "-map", "0:v:0", "-c:v", "copy"];
    const v = (t.videoCodec ?? "").toLowerCase();
    if (v === "hevc" || v === "h265") args.push("-tag:v", "hvc1");
    const a = t.audioTracks[audio] ?? t.audioTracks[0];
    if (a) {
        const idx = t.audioTracks[audio] ? audio : 0;
        args.push("-map", `0:a:${idx}`);
        const codec = (a.codec ?? "").toLowerCase();
        if (AUDIO_COPY_MP4.has(codec)) args.push("-c:a", "copy");
        else args.push(...audioTranscodeArgs(["eac3"], a.channels));
    }
    let s = 0;
    t.subtitleTracks.forEach((st, i) => {
        const c = (st.codec ?? "").toLowerCase();
        if (s >= 16 || isBitmapSub(c) || !TEXT_SUBS_MP4.has(c)) return;
        args.push("-map", `0:s:${i}`);
        s++;
    });
    if (s > 0) args.push("-c:s", "mov_text");
    args.push("-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", output);
    return args;
}

/** `out_time_us=` / `out_time_ms=` (both microseconds in ffmpeg) / `out_time=HH:MM:SS.x` → seconds. */
export function parseProgressChunk(chunk: string): number | null {
    let sec: number | null = null;
    for (const line of chunk.split(/\r?\n/)) {
        let m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) { sec = Number(m[1]) / 1e6; continue; }
        m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
        if (m) sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    }
    return sec;
}

export class DownloadCache {
    private readonly jobs = new Map<string, DownloadJob>();
    private readonly byKey = new Map<string, string>();
    private readonly now: () => number;

    constructor(private readonly opts: DownloadCacheOptions) {
        this.now = opts.now ?? Date.now;
        fs.mkdirSync(opts.dir, { recursive: true });
    }

    private capBytes(): number {
        const c = this.opts.getCapBytes?.() ?? DEFAULT_CACHE_CAP_BYTES;
        return Number.isFinite(c) && c > 0 ? c : DEFAULT_CACHE_CAP_BYTES;
    }

    /** Cache key: fileId + audio track + source signature (re-remux when the source changes). */
    keyFor(fileId: string, audio: number, absPath: string): string {
        let sig = "";
        try { const st = fs.statSync(absPath); sig = `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { /* missing */ }
        const h = crypto.createHash("sha1").update(`${absPath}|${sig}`).digest("hex").slice(0, 10);
        return `${fileId.replace(/[^A-Za-z0-9_-]/g, "_")}-a${audio}-${h}`;
    }

    pathFor(key: string): string {
        return path.join(this.opts.dir, `${key}.mp4`);
    }

    /** Finished file for (fileId, audio), touched for LRU; null while not ready. */
    ready(fileId: string, audio: number, absPath: string): string | null {
        const p = this.pathFor(this.keyFor(fileId, audio, absPath));
        if (!fs.existsSync(p)) return null;
        const t = new Date(this.now());
        try { fs.utimesSync(p, t, t); } catch { /* read-only fs */ }
        return p;
    }

    status(fileId: string, audio: number, absPath: string): DownloadJob | null {
        const key = this.keyFor(fileId, audio, absPath);
        const id = this.byKey.get(key);
        const job = id ? this.jobs.get(id) : undefined;
        if (job) return { ...job };
        const p = this.pathFor(key);
        if (fs.existsSync(p)) {
            const st = fs.statSync(p);
            return { jobId: `cached:${key}`, fileId, audio, state: "done", progress: 1, error: null, sizeBytes: st.size, createdAt: st.mtimeMs, finishedAt: st.mtimeMs };
        }
        return null;
    }

    getJob(jobId: string): DownloadJob | null {
        const j = this.jobs.get(jobId);
        return j ? { ...j } : null;
    }

    /** Start (or join) the remux. Idempotent per (fileId, audio, source signature). */
    prepare(fileId: string, audio: number, absPath: string, tracks: () => Promise<MediaTracks>, title = ""): DownloadJob {
        const key = this.keyFor(fileId, audio, absPath);
        const existing = this.status(fileId, audio, absPath);
        if (existing && existing.state !== "failed") return existing;
        const job: DownloadJob = {
            jobId: `dl_${crypto.randomBytes(6).toString("base64url")}`, fileId, audio, state: "queued", progress: 0, error: null,
            sizeBytes: null, createdAt: this.now(), finishedAt: null,
        };
        this.jobs.set(job.jobId, job);
        this.byKey.set(key, job.jobId);
        void this.opts.slot(() => this.runJob(job, key, absPath, tracks, title)).catch((err: unknown) => {
            job.state = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.finishedAt = this.now();
        });
        return { ...job };
    }

    private async runJob(job: DownloadJob, key: string, absPath: string, tracks: () => Promise<MediaTracks>, title: string): Promise<void> {
        job.state = "running";
        const t = await tracks();
        const out = this.pathFor(key);
        const partial = `${out}.partial`;
        const dur = t.durationSec && t.durationSec > 0 ? t.durationSec : 0;
        const r = await this.opts.run(remuxMp4Args(absPath, partial, job.audio, t), (sec) => {
            if (dur > 0) job.progress = Math.max(job.progress, Math.min(0.99, sec / dur));
        });
        if (r.code !== 0 || !fs.existsSync(partial)) {
            await fsp.rm(partial, { force: true }).catch(() => undefined);
            job.state = "failed";
            job.error = (r.stderr || `ffmpeg exited with ${r.code}`).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 500);
            job.finishedAt = this.now();
            this.opts.log?.warn("[downloads] remux failed", { fileId: job.fileId, error: job.error });
            return;
        }
        await fsp.rename(partial, out);
        job.state = "done";
        job.progress = 1;
        job.sizeBytes = fs.statSync(out).size;
        job.finishedAt = this.now();
        this.evict(new Set([out]));
        this.opts.onReady?.({ ...job }, title);
    }

    /** Delete least-recently-used finished files until the cache fits the cap (never `keep`). */
    evict(keep: Set<string> = new Set()): string[] {
        const files = fs.readdirSync(this.opts.dir)
            .filter((n) => n.endsWith(".mp4"))
            .map((n) => {
                const p = path.join(this.opts.dir, n);
                const st = fs.statSync(p);
                return { p, size: st.size, used: Math.max(st.mtimeMs, st.atimeMs) };
            })
            .sort((a, b) => a.used - b.used);
        let total = files.reduce((s, f) => s + f.size, 0);
        const removed: string[] = [];
        for (const f of files) {
            if (total <= this.capBytes()) break;
            if (keep.has(f.p)) continue;
            try { fs.rmSync(f.p, { force: true }); total -= f.size; removed.push(f.p); } catch { /* in use */ }
        }
        return removed;
    }

    usage(): { bytes: number; files: number; capBytes: number } {
        const files = fs.readdirSync(this.opts.dir).filter((n) => n.endsWith(".mp4"));
        const bytes = files.reduce((s, n) => s + fs.statSync(path.join(this.opts.dir, n)).size, 0);
        return { bytes, files: files.length, capBytes: this.capBytes() };
    }
}
