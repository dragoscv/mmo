/**
 * On-demand HLS transcode for the video player.
 *
 * Strategy: when the player requests a stream URL, we check whether the
 * source file can direct-play (codec compatible with browser). If yes,
 * we serve it as a static range-supported file. If no, we spin up an
 * ffmpeg process that produces an HLS playlist (fMP4 / TS segments) into
 * a per-session temp dir, and serve segments as they're written.
 *
 * The session is keyed by `<fileId>:<quality>` and torn down after N
 * minutes of inactivity (no segment fetched).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { FFMPEG_BIN, FFPROBE_BIN, detectHwAccel, videoEncoderFor, qualityArgsFor } from "./ffmpeg-paths";
import { sidecarIfExists } from "./pre-remux";

export type VideoQuality = "original" | "1080p" | "720p" | "480p";

/** Pipeline mode chosen per-playback based on probed codecs + client caps.
 *  - `remux`           : `-c:v copy -c:a copy` to fragmented MP4 segments. Almost zero CPU.
 *  - `audio-transcode` : `-c:v copy -c:a aac` (or stereo downmix). ~5% CPU, no GPU.
 *  - `full-transcode`  : full re-encode via NVENC/CPU. Fallback only.
 */
export type TranscodeMode = "remux" | "audio-transcode" | "full-transcode";

interface Ladder { name: VideoQuality; w: number; h: number; vBitrate: string; aBitrate: string }

const LADDER: Record<Exclude<VideoQuality, "original">, Ladder> = {
    "1080p": { name: "1080p", w: 1920, h: 1080, vBitrate: "5000k", aBitrate: "192k" },
    "720p": { name: "720p", w: 1280, h: 720, vBitrate: "2800k", aBitrate: "160k" },
    "480p": { name: "480p", w: 854, h: 480, vBitrate: "1200k", aBitrate: "128k" },
};

interface Session {
    key: string;
    fileId: string;
    dir: string;
    proc: ChildProcess;
    lastTouch: number;
    ready: Promise<void>;
    emitter: EventEmitter;
    /** Source offset (seconds) that this session was launched from. */
    startSec: number;
    mode: TranscodeMode;
    /** Segment extension produced by ffmpeg for this session (`ts` or `m4s`). */
    segExt: "ts" | "m4s";
}

const sessions = new Map<string, Session>();
// When the web app stops requesting segments (paused, tab closed,
// browser crashed, Wi-Fi died) we want the ffmpeg process gone fast so
// it stops holding the source file open and burning GPU. The 3s
// client-side pause beacon handles the cooperative path; this idle
// sweep catches the silent disconnects where no beacon ever arrives.
const SESSION_IDLE_MS = 60 * 1000;
const MAX_CONCURRENT_SESSIONS = 2;

setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
        if (now - s.lastTouch > SESSION_IDLE_MS) destroySession(key);
    }
}, 15_000).unref();

function destroySession(key: string): void {
    const s = sessions.get(key);
    if (!s) return;
    // On Windows, child.kill() only terminates the immediate child and
    // can leave ffmpeg worker processes alive. Use taskkill /F /T for a
    // full tree teardown.
    try {
        if (process.platform === "win32" && s.proc.pid) {
            spawn("taskkill", ["/F", "/T", "/PID", String(s.proc.pid)], { windowsHide: true, stdio: "ignore" });
        } else {
            s.proc.kill("SIGKILL");
        }
    } catch { /* ignore */ }
    sessions.delete(key);
    fsp.rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
}

function evictOldestIfOverCap(): void {
    while (sessions.size >= MAX_CONCURRENT_SESSIONS) {
        let oldestKey: string | null = null;
        let oldestTouch = Infinity;
        for (const [k, s] of sessions) {
            if (s.lastTouch < oldestTouch) { oldestTouch = s.lastTouch; oldestKey = k; }
        }
        if (!oldestKey) break;
        destroySession(oldestKey);
    }
}

export function destroyAllSessions(): void {
    for (const key of [...sessions.keys()]) destroySession(key);
}

async function probeVideoCodec(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
        const args = ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", filePath];
        const child = spawn(FFPROBE_BIN, args, { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (b) => { out += b.toString("utf8"); });
        child.on("error", () => resolve(null));
        child.on("exit", () => resolve(out.trim().toLowerCase() || null));
    });
}

async function probeFirstAudioCodec(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
        const args = ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "default=nw=1:nk=1", filePath];
        const child = spawn(FFPROBE_BIN, args, { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (b) => { out += b.toString("utf8"); });
        child.on("error", () => resolve(null));
        child.on("exit", () => resolve(out.trim().toLowerCase() || null));
    });
}

/** Decide the cheapest playback mode that the given client can handle.
 *  `caps` is the comma-separated list reported by the browser (e.g.
 *  "h264,hevc,aac,ac3,eac3"). When `quality` is anything other than
 *  "original", we always full-transcode (the caller asked us to rescale). */
export function pickTranscodeMode(
    quality: VideoQuality,
    videoCodec: string | null,
    audioCodec: string | null,
    caps: string[],
): TranscodeMode {
    if (quality !== "original") return "full-transcode";
    const v = (videoCodec ?? "").toLowerCase();
    const a = (audioCodec ?? "").toLowerCase();
    // Normalize codec aliases to the names clients report.
    const vKey = v === "avc1" ? "h264" : v === "h265" ? "hevc" : v;
    const aKey = a === "mp4a" ? "aac" : a;
    const cap = new Set(caps.map((c) => c.toLowerCase()));
    const videoOk = cap.has(vKey) && ["h264", "hevc", "vp9", "av1"].includes(vKey);
    const audioOk = cap.has(aKey) && ["aac", "ac3", "eac3", "opus", "mp3"].includes(aKey);
    if (!videoOk) return "full-transcode";
    if (!audioOk) return "audio-transcode";
    return "remux";
}

export function touchSession(key: string): void {
    const s = sessions.get(key);
    if (s) s.lastTouch = Date.now();
}

/** Tear down every active session for the given fileId. Called when
 *  the client pauses playback — no point burning CPU/GPU encoding
 *  segments nobody will fetch. On resume the client triggers a fresh
 *  session from the current position via the same `?start=` mechanism
 *  used for seeks past the buffered range. */
export function destroySessionsForFile(fileId: string): number {
    let n = 0;
    for (const [key, s] of sessions) {
        if (s.fileId === fileId) { destroySession(key); n++; }
    }
    return n;
}

export async function ensureHlsSession(
    fileId: string,
    sourcePath: string,
    quality: VideoQuality,
    startSec: number = 0,
    caps: string[] = [],
    requestedMode?: TranscodeMode,
): Promise<{ key: string; playlistPath: string; segmentDir: string; mode: TranscodeMode; segExt: "ts" | "m4s" }> {
    // If a pre-remuxed sidecar exists, transcode from THAT instead of
    // the (often DTS / TrueHD / TS-muxed) original. The sidecar is
    // already h264/hevc + AAC stereo in a fragment-friendly MP4, so
    // even the "remux" path becomes essentially free.
    const effectiveSource = sidecarIfExists(sourcePath) ?? sourcePath;
    const probedV = await probeVideoCodec(effectiveSource);
    const probedA = await probeFirstAudioCodec(effectiveSource);
    const mode = requestedMode ?? pickTranscodeMode(quality, probedV, probedA, caps);
    const key = `${fileId}:${quality}:${mode}`;
    const existing = sessions.get(key);
    if (existing) {
        if (!fs.existsSync(existing.dir)) {
            destroySession(key);
        } else if (Math.abs(existing.startSec - startSec) > 1) {
            destroySession(key);
        } else {
            existing.lastTouch = Date.now();
            await existing.ready;
            return { key, playlistPath: path.join(existing.dir, "stream.m3u8"), segmentDir: existing.dir, mode: existing.mode, segExt: existing.segExt };
        }
    }

    evictOldestIfOverCap();

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `mmo-hls-${fileId}-${quality}-${mode}-`));
    const playlistPath = path.join(dir, "stream.m3u8");
    const accel = detectHwAccel();
    const encoder = videoEncoderFor(accel);

    // fmp4 segments are required for HEVC/AV1 copy paths and are well
    // supported by hls.js + Chromium for h264 too. mpegts is only used
    // for the legacy full-transcode path (preserves the ADTS-AAC path
    // that historically dodged Chromium's fmp4 AAC config issues).
    const useFmp4 = mode !== "full-transcode";
    const segExt: "ts" | "m4s" = useFmp4 ? "m4s" : "ts";

    const args: string[] = ["-y", "-loglevel", "warning"];
    if (mode === "full-transcode") {
        if (accel === "nvenc") args.push("-hwaccel", "cuda");
        else if (accel === "qsv") args.push("-hwaccel", "qsv");
        else if (accel === "videotoolbox") args.push("-hwaccel", "videotoolbox");
    }
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", effectiveSource);
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-sn");

    if (mode === "remux") {
        args.push("-c:v", "copy");
        // hvc1 brand tag is required for HEVC inside fmp4 played through
        // hls.js + Chromium MSE. Without it the segments parse as raw
        // bitstream and Chromium rejects them.
        if (probedV === "hevc" || probedV === "h265") args.push("-tag:v", "hvc1");
        args.push("-c:a", "copy");
    } else if (mode === "audio-transcode") {
        args.push("-c:v", "copy");
        if (probedV === "hevc" || probedV === "h265") args.push("-tag:v", "hvc1");
        args.push("-af", "aformat=channel_layouts=stereo:sample_rates=48000");
        args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k");
    } else if (quality === "original") {
        const vCodec = probedV;
        const copyable = vCodec === "h264" || vCodec === "avc1" || vCodec === "vp9" || vCodec === "av1";
        if (copyable) {
            args.push("-c:v", "copy");
        } else {
            args.push("-c:v", encoder, ...qualityArgsFor(accel, 22));
            args.push("-vf", "scale=w=1920:h=1080:force_original_aspect_ratio=decrease");
        }
        args.push("-af", "aformat=channel_layouts=stereo:sample_rates=48000");
        args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k");
    } else {
        const l = LADDER[quality];
        args.push("-c:v", encoder, ...qualityArgsFor(accel, 23));
        args.push("-b:v", l.vBitrate, "-maxrate", l.vBitrate, "-bufsize", l.vBitrate);
        args.push("-vf", `scale=w=${l.w}:h=${l.h}:force_original_aspect_ratio=decrease`);
        args.push("-af", "aformat=channel_layouts=stereo:sample_rates=48000");
        args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", l.aBitrate);
    }
    args.push(
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "0",
        "-hls_segment_type", useFmp4 ? "fmp4" : "mpegts",
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", path.join(dir, useFmp4 ? "seg_%05d.m4s" : "seg_%05d.ts"),
        playlistPath,
    );

    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    const emitter = new EventEmitter();
    const logPath = path.join(dir, "ffmpeg.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`[args] ${FFMPEG_BIN} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
    let lastStderr = "";
    proc.stderr?.on("data", (b) => {
        const s = b.toString("utf8");
        lastStderr = (lastStderr + s).slice(-4000);
        logStream.write(s);
        emitter.emit("log", s);
    });

    const ready = new Promise<void>((resolve, reject) => {
        const t = setInterval(() => {
            if (fs.existsSync(playlistPath)) {
                clearInterval(t);
                resolve();
            }
        }, 100);
        proc.on("error", (e) => { clearInterval(t); reject(e); });
        proc.on("exit", (code) => {
            logStream.end();
            if (!fs.existsSync(playlistPath)) {
                clearInterval(t);
                const tail = lastStderr.trim().split("\n").slice(-6).join(" | ");
                reject(new Error(`ffmpeg exited ${code} before producing playlist — ${tail}`));
            }
        });
        setTimeout(() => { clearInterval(t); reject(new Error("ffmpeg startup timeout")); }, 60_000);
    });

    const session: Session = { key, fileId, dir, proc, lastTouch: Date.now(), ready, emitter, startSec, mode, segExt };
    sessions.set(key, session);

    try {
        await ready;
    } catch (e) {
        destroySession(key);
        throw e;
    }

    return { key, playlistPath, segmentDir: dir, mode, segExt };
}

/** Can the browser direct-play this file as-is (no transcode)? */
export function canDirectPlay(container: string | null, vCodec: string | null, aCodec: string | null): boolean {
    if (!container || !vCodec) return false;
    const v = vCodec.toLowerCase();
    const c = container.toLowerCase();
    const a = (aCodec ?? "").toLowerCase();
    const browserVideo = v === "h264" || v === "avc1" || v === "vp9" || v === "av1";
    const browserAudio = ["aac", "mp3", "opus", "vorbis"].includes(a);
    const browserContainer = c.includes("mp4") || c.includes("webm");
    return browserVideo && browserAudio && browserContainer;
}
