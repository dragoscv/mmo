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
import { FFMPEG_BIN, detectHwAccel, videoEncoderFor } from "./ffmpeg-paths";

export type VideoQuality = "original" | "1080p" | "720p" | "480p";

interface Ladder { name: VideoQuality; w: number; h: number; vBitrate: string; aBitrate: string }

const LADDER: Record<Exclude<VideoQuality, "original">, Ladder> = {
    "1080p": { name: "1080p", w: 1920, h: 1080, vBitrate: "5000k", aBitrate: "192k" },
    "720p": { name: "720p", w: 1280, h: 720, vBitrate: "2800k", aBitrate: "160k" },
    "480p": { name: "480p", w: 854, h: 480, vBitrate: "1200k", aBitrate: "128k" },
};

interface Session {
    key: string;
    dir: string;
    proc: ChildProcess;
    lastTouch: number;
    ready: Promise<void>;
    emitter: EventEmitter;
}

const sessions = new Map<string, Session>();
const SESSION_IDLE_MS = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
        if (now - s.lastTouch > SESSION_IDLE_MS) destroySession(key);
    }
}, 60_000).unref();

function destroySession(key: string): void {
    const s = sessions.get(key);
    if (!s) return;
    try { s.proc.kill("SIGKILL"); } catch { /* ignore */ }
    sessions.delete(key);
    fsp.rm(s.dir, { recursive: true, force: true }).catch(() => undefined);
}

export function destroyAllSessions(): void {
    for (const key of [...sessions.keys()]) destroySession(key);
}

export function touchSession(key: string): void {
    const s = sessions.get(key);
    if (s) s.lastTouch = Date.now();
}

export async function ensureHlsSession(
    fileId: string,
    sourcePath: string,
    quality: VideoQuality,
    startSec: number = 0,
): Promise<{ key: string; playlistPath: string; segmentDir: string }> {
    const key = `${fileId}:${quality}:${Math.floor(startSec)}`;
    const existing = sessions.get(key);
    if (existing) {
        existing.lastTouch = Date.now();
        await existing.ready;
        return { key, playlistPath: path.join(existing.dir, "stream.m3u8"), segmentDir: existing.dir };
    }

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `mmo-hls-${fileId}-${quality}-`));
    const playlistPath = path.join(dir, "stream.m3u8");
    const accel = detectHwAccel();
    const encoder = videoEncoderFor(accel);

    const args: string[] = ["-y", "-loglevel", "warning"];
    if (startSec > 0) args.push("-ss", String(startSec));
    args.push("-i", sourcePath);

    if (quality === "original") {
        args.push("-c", "copy");
    } else {
        const l = LADDER[quality];
        args.push("-c:v", encoder, "-preset", accel === "none" ? "veryfast" : "fast");
        args.push("-b:v", l.vBitrate, "-maxrate", l.vBitrate, "-bufsize", l.vBitrate);
        args.push("-vf", `scale=w=${l.w}:h=${l.h}:force_original_aspect_ratio=decrease`);
        args.push("-c:a", "aac", "-b:a", l.aBitrate, "-ac", "2");
    }
    args.push(
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "0",
        "-hls_segment_type", "fmp4",
        "-hls_flags", "independent_segments+delete_segments",
        "-hls_segment_filename", path.join(dir, "seg_%05d.m4s"),
        playlistPath,
    );

    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    const emitter = new EventEmitter();
    proc.stderr?.on("data", (b) => emitter.emit("log", b.toString("utf8")));

    const ready = new Promise<void>((resolve, reject) => {
        const t = setInterval(() => {
            if (fs.existsSync(playlistPath)) {
                clearInterval(t);
                resolve();
            }
        }, 100);
        proc.on("error", (e) => { clearInterval(t); reject(e); });
        proc.on("exit", (code) => {
            if (!fs.existsSync(playlistPath)) {
                clearInterval(t);
                reject(new Error(`ffmpeg exited ${code} before producing playlist`));
            }
        });
        setTimeout(() => { clearInterval(t); reject(new Error("ffmpeg startup timeout")); }, 30_000);
    });

    const session: Session = { key, dir, proc, lastTouch: Date.now(), ready, emitter };
    sessions.set(key, session);

    try {
        await ready;
    } catch (e) {
        destroySession(key);
        throw e;
    }

    return { key, playlistPath, segmentDir: dir };
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
