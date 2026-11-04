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
import { lowerPriority, killTree, supportsReadrateBurst } from "./ffmpeg-jobs";
import { getSettings } from "../store";

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
/** Last start offset per session key, kept after teardown so a segment
 *  request for an idle-killed session restarts at the right place instead
 *  of at 0 (which used to kill every resumed session). */
const lastStartByKey = new Map<string, number>();
const lastCapsByKey = new Map<string, string[]>();
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
    // Full tree teardown (child.kill() can leave workers alive on Windows).
    killTree(s.proc.pid);
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

export interface StreamCodecs { video: string | null; audio: string | null; audioChannels: number | null }

/** One ffprobe per (path, mtime, size), cached. It used to run twice on
 *  EVERY playlist and segment request (~600 ms each, measured). */
const codecCache = new Map<string, { sig: string; codecs: StreamCodecs }>();

export async function probeStreamCodecs(filePath: string): Promise<StreamCodecs> {
    let sig = "";
    try { const st = fs.statSync(filePath); sig = `${st.size}:${st.mtimeMs}`; } catch { /* missing */ }
    const hit = codecCache.get(filePath);
    if (hit && hit.sig === sig) return hit.codecs;
    const codecs = await new Promise<StreamCodecs>((resolve) => {
        const args = ["-v", "error", "-show_entries", "stream=codec_type,codec_name,channels", "-of", "json", filePath];
        const child = spawn(FFPROBE_BIN, args, { windowsHide: true });
        let out = "";
        child.stdout?.on("data", (b) => { out += b.toString("utf8"); });
        child.on("error", () => resolve({ video: null, audio: null, audioChannels: null }));
        child.on("exit", () => {
            try {
                const j = JSON.parse(out) as { streams?: Array<{ codec_type?: string; codec_name?: string; channels?: number }> };
                const v = j.streams?.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
                const a = j.streams?.find((s) => s.codec_type === "audio");
                resolve({ video: v?.codec_name?.toLowerCase() ?? null, audio: a?.codec_name?.toLowerCase() ?? null, audioChannels: a?.channels ?? null });
            } catch {
                resolve({ video: null, audio: null, audioChannels: null });
            }
        });
    });
    if (codecs.video) codecCache.set(filePath, { sig, codecs });
    return codecs;
}

const VIDEO_COPY_OK = ["h264", "hevc", "vp9", "av1"];
const AUDIO_COPY_OK = ["aac", "ac3", "eac3", "opus", "mp3", "flac"];

/** Decide the cheapest playback mode that the given client can handle.
 *  `caps` is the comma-separated list reported by the client (e.g.
 *  "h264,hevc,aac,ac3,eac3"). The video stream is NEVER re-encoded unless
 *  the owner enabled `allowVideoTranscode` (default off): quality is always
 *  the original, and a lower quality request is treated as "original". */
export function pickTranscodeMode(
    quality: VideoQuality,
    videoCodec: string | null,
    audioCodec: string | null,
    caps: string[],
    allowVideoTranscode = false,
): TranscodeMode {
    if (quality !== "original" && allowVideoTranscode) return "full-transcode";
    const v = (videoCodec ?? "").toLowerCase();
    const a = (audioCodec ?? "").toLowerCase();
    // Normalize codec aliases to the names clients report.
    const vKey = v === "avc1" ? "h264" : v === "h265" ? "hevc" : v;
    const aKey = a === "mp4a" ? "aac" : a;
    const cap = new Set(caps.map((c) => c.toLowerCase()));
    // No caps reported (unknown client): copy the video, keep only AAC/MP3 audio
    // as-is — every player decodes those; anything else is converted.
    const videoOk = VIDEO_COPY_OK.includes(vKey) && (cap.size === 0 || cap.has(vKey));
    const audioOk = !aKey || (cap.size === 0 ? ["aac", "mp3"].includes(aKey) : (AUDIO_COPY_OK.includes(aKey) && cap.has(aKey)));
    if (!videoOk && allowVideoTranscode) return "full-transcode";
    if (!audioOk) return "audio-transcode";
    return "remux";
}

/** Best audio the client takes when the source audio must be converted:
 *  E-AC3 5.1 640k (Dolby Digital Plus, every Samsung/Android TV + soundbar),
 *  then AC3 5.1 640k, then AAC (stereo when the client is a plain browser). */
export function audioTranscodeArgs(caps: string[], sourceChannels: number | null): string[] {
    const cap = new Set(caps.map((c) => c.toLowerCase()));
    const ch = Math.max(1, Math.min(6, sourceChannels ?? 6));
    if (cap.has("eac3")) return ["-c:a", "eac3", "-ac", String(ch), "-ar", "48000", "-b:a", ch > 2 ? "640k" : "256k"];
    if (cap.has("ac3")) return ["-c:a", "ac3", "-ac", String(ch), "-ar", "48000", "-b:a", ch > 2 ? "640k" : "256k"];
    return ["-af", "aformat=channel_layouts=stereo:sample_rates=48000", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "256k"];
}

export function touchSession(key: string): void {
    const s = sessions.get(key);
    if (s) s.lastTouch = Date.now();
}

/** Segment-route lookup: the live session for `key`, or a restart at the
 *  offset it was last started from (never a silent restart at 0). */
export async function sessionForSegment(
    fileId: string,
    sourcePath: string,
    key: string,
): Promise<{ segmentDir: string } | null> {
    const s = sessions.get(key);
    if (s && fs.existsSync(s.dir)) {
        s.lastTouch = Date.now();
        return { segmentDir: s.dir };
    }
    const m = key.match(/^[^:]+:(original|1080p|720p|480p):(remux|audio-transcode|full-transcode)$/);
    if (!m) return null;
    const startSec = lastStartByKey.get(key) ?? 0;
    const sess = await ensureHlsSession(fileId, sourcePath, m[1] as VideoQuality, startSec, lastCapsByKey.get(key) ?? [], m[2] as TranscodeMode);
    return { segmentDir: sess.segmentDir };
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
    const probed = await probeStreamCodecs(effectiveSource);
    const probedV = probed.video;
    const allowVideoTranscode = getSettings().allowVideoTranscode;
    let mode = requestedMode ?? pickTranscodeMode(quality, probedV, probed.audio, caps, allowVideoTranscode);
    // An explicit `?mode=full-transcode` is refused while video transcoding is off.
    if (mode === "full-transcode" && !allowVideoTranscode) {
        mode = pickTranscodeMode("original", probedV, probed.audio, caps, false);
    }
    if (!allowVideoTranscode) quality = "original";
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
    lastStartByKey.set(key, startSec);
    lastCapsByKey.set(key, caps);

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
    } else {
        // Copy paths: pace the read at 2x realtime after a 60 s burst. Without
        // this ffmpeg copied the whole film to %TEMP% at ~100 MB/s (3 GB per
        // 30 s measured); paced it is ~5 MB/s and ~0.03 cores. Seeking past
        // the produced range restarts the session at `?start=`.
        args.push("-readrate", "2");
        if (supportsReadrateBurst()) args.push("-readrate_initial_burst", "60");
    }
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", effectiveSource);
    args.push("-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_chapters", "-1");

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
        args.push("-threads", "2", ...audioTranscodeArgs(caps, probed.audioChannels));
    } else if (quality === "original") {
        const vCodec = probedV;
        const copyable = vCodec === "h264" || vCodec === "avc1" || vCodec === "vp9" || vCodec === "av1";
        if (copyable) {
            args.push("-c:v", "copy");
        } else {
            args.push("-c:v", encoder, ...qualityArgsFor(accel, 22));
            // format=yuv420p: h264 encoders reject 10-bit (p010) input — the
            // reason every 4K HDR full transcode died in under a second.
            args.push("-vf", "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,format=yuv420p");
        }
        args.push("-af", "aformat=channel_layouts=stereo:sample_rates=48000");
        args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k");
    } else {
        const l = LADDER[quality];
        args.push("-c:v", encoder, ...qualityArgsFor(accel, 23));
        args.push("-b:v", l.vBitrate, "-maxrate", l.vBitrate, "-bufsize", l.vBitrate);
        args.push("-vf", `scale=w=${l.w}:h=${l.h}:force_original_aspect_ratio=decrease,format=yuv420p`);
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

    // cwd = session dir: ffmpeg writes the fMP4 `init.mp4` relative to its
    // working directory, not next to the segments. Without this every session
    // wrote (and overwrote) `<server cwd>/init.mp4` and the init route 404'd.
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true, cwd: dir });
    // Live playback beats everything else on the box except the desktop.
    lowerPriority(proc.pid, "below-normal");
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
