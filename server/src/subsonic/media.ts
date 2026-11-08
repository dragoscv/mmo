/**
 * stream / download / getCoverArt / getLyricsBySongId.
 *
 * `stream` mirrors `/library/tracks/:id/audio` (range support, direct
 * file). `format` in {mp3, opus, aac, flac} transcodes through ffmpeg
 * (see `pickStreamFormat`); `raw`, absent or the file's own suffix plays
 * the file directly. `maxBitRate` is accepted but ignored.
 * `timeOffset` (OpenSubsonic transcodeOffset) spawns ffmpeg `-ss` when a
 * binary is resolvable, otherwise falls back to a plain stream.
 */

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type express from "express";
import { lazyEsm } from "../lib/esm-import";

// music-metadata 11 is ESM-only; this build is CommonJS (see lib/esm-import).
const loadMusicMetadata = lazyEsm<typeof import("music-metadata")>("music-metadata");
import { FFMPEG_BIN } from "../library/ffmpeg-paths";
import { log } from "../lib/logger";
import { mimeOf, type TrackRow } from "./browse";
import type { Body } from "./response";

// ─── ffmpeg availability (probed once, lazily) ───────────────────────────────

let _ffmpegOk: boolean | null = null;
export function ffmpegAvailable(): boolean {
    if (_ffmpegOk !== null) return _ffmpegOk;
    try {
        const r = spawnSync(FFMPEG_BIN, ["-version"], { timeout: 4000, stdio: "ignore" });
        _ffmpegOk = r.status === 0;
    } catch { _ffmpegOk = false; }
    return _ffmpegOk;
}

// ─── stream / download ───────────────────────────────────────────────────────

export type StreamFormat = "mp3" | "opus" | "aac" | "flac";

const TRANSCODE: Record<StreamFormat, { args: string[]; mime: string }> = {
    mp3: { args: ["-c:a", "libmp3lame", "-b:a", "256k", "-f", "mp3"], mime: "audio/mpeg" },
    opus: { args: ["-c:a", "libopus", "-b:a", "160k", "-f", "ogg"], mime: "audio/ogg" },
    aac: { args: ["-c:a", "aac", "-b:a", "256k", "-f", "adts"], mime: "audio/aac" },
    flac: { args: ["-c:a", "flac", "-f", "flac"], mime: "audio/flac" },
};

/**
 * Decide how `stream` serves a track for a Subsonic `format` param.
 * Returns a transcode target, or `"raw"` for the direct file (absent,
 * `raw`, unknown, or the same as the file's own suffix).
 */
export function pickStreamFormat(param: string | null | undefined, fileSuffix: string): StreamFormat | "raw" {
    const f = (param ?? "").trim().toLowerCase();
    if (!f || f === "raw") return "raw";
    if (!(f in TRANSCODE)) return "raw";
    if (f === fileSuffix.trim().toLowerCase()) return "raw";
    return f as StreamFormat;
}

function setDurationHeader(res: express.Response, row: TrackRow, offsetSec = 0): void {
    if (row.duration && row.duration > 0) {
        const d = Math.max(0, row.duration - offsetSec);
        res.setHeader("X-Content-Duration", d.toFixed(2));
    }
}

export function sendFile(req: express.Request, res: express.Response, row: TrackRow, asAttachment: boolean): void {
    if (!row.filepath || !existsSync(row.filepath)) { res.status(404).end(); return; }
    const stat = statSync(row.filepath);
    res.setHeader("Content-Type", mimeOf(row));
    setDurationHeader(res, row);
    res.setHeader("Accept-Ranges", "bytes");
    if (asAttachment) {
        const safe = row.filename.replace(/["\r\n]/g, "_");
        res.setHeader("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
    }
    const range = req.headers.range;
    if (range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (m) {
            const start = parseInt(m[1]!, 10);
            const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
            if (start >= stat.size || start > end) {
                res.status(416).setHeader("Content-Range", `bytes */${stat.size}`);
                res.end();
                return;
            }
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
            res.setHeader("Content-Length", String(end - start + 1));
            createReadStream(row.filepath, { start, end }).pipe(res);
            return;
        }
    }
    res.setHeader("Content-Length", String(stat.size));
    createReadStream(row.filepath).pipe(res);
}

/** ffmpeg argument list for a transcode (exported for tests). */
export function transcodeArgs(filepath: string, offsetSec: number, format: StreamFormat): string[] {
    const args = ["-hide_banner", "-loglevel", "error"];
    if (offsetSec > 0) args.push("-ss", String(offsetSec));
    args.push("-i", filepath, "-vn", "-map_metadata", "-1", ...TRANSCODE[format].args, "pipe:1");
    return args;
}

/** Seek (optional) + transcode via ffmpeg. Returns false if ffmpeg is not usable so the caller can fall back. */
export function streamTranscoded(res: express.Response, row: TrackRow, offsetSec: number, format: StreamFormat): boolean {
    if (!ffmpegAvailable() || !row.filepath || !existsSync(row.filepath)) return false;
    const offset = Math.max(0, offsetSec);
    const child = spawn(FFMPEG_BIN, transcodeArgs(row.filepath, offset, format), { stdio: ["ignore", "pipe", "pipe"] });
    res.status(200);
    res.setHeader("Content-Type", TRANSCODE[format].mime);
    res.setHeader("Accept-Ranges", "none");
    setDurationHeader(res, row, offset);
    child.stdout.pipe(res);
    let err = "";
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { log.warn("[subsonic] ffmpeg spawn failed", { error: e.message }); if (!res.headersSent) res.status(500); res.end(); });
    child.on("close", (code) => { if (code !== 0 && code !== null) log.warn("[subsonic] ffmpeg exit", { code, err: err.slice(0, 300) }); });
    res.on("close", () => { if (child.exitCode === null) child.kill("SIGKILL"); });
    return true;
}

// ─── cover art ───────────────────────────────────────────────────────────────

interface Picture { format: string; data: Uint8Array }

async function readEmbeddedPicture(filepath: string): Promise<Picture | null> {
    try {
        const { parseFile, selectCover } = await loadMusicMetadata();
        const meta = await parseFile(filepath, { skipCovers: false, duration: false });
        const pic = selectCover(meta.common.picture);
        return pic ? { format: pic.format, data: pic.data } : null;
    } catch {
        return null;
    }
}

/** Folder art next to the track (`cover.jpg`, `folder.png`, …), the common layout when tracks carry no embedded picture. */
const FOLDER_ART = ["cover", "folder", "front", "album"].flatMap((n) => [`${n}.jpg`, `${n}.jpeg`, `${n}.png`, `${n}.webp`]);
const MAX_FOLDER_ART = 15 * 1024 * 1024;

export function findFolderArt(trackPath: string, exists: (p: string) => boolean = existsSync): string | null {
    const dir = path.dirname(trackPath);
    for (const name of FOLDER_ART) {
        for (const n of [name, name[0]!.toUpperCase() + name.slice(1)]) {
            const p = path.join(dir, n);
            if (exists(p)) return p;
        }
    }
    return null;
}

function readFolderArt(trackPath: string): Picture | null {
    const p = findFolderArt(trackPath);
    if (!p) return null;
    try {
        if (statSync(p).size > MAX_FOLDER_ART) return null;
        const ext = path.extname(p).toLowerCase();
        const format = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        return { format, data: readFileSync(p) };
    } catch {
        return null;
    }
}

/** Sends the embedded picture of the first track that has one, else folder art
 *  (`cover.jpg` …) beside it. `size` is accepted but ignored: `sharp` is not a
 *  dependency of this package, and ADR-0005 forbids adding image deps for this surface. */
export async function sendCoverArt(res: express.Response, candidates: TrackRow[]): Promise<boolean> {
    const rows = candidates.slice(0, 5).filter((r) => r.filepath && existsSync(r.filepath));
    let pic: Picture | null = null;
    for (const row of rows) {
        pic = await readEmbeddedPicture(row.filepath!);
        if (pic) break;
    }
    for (const row of rows) {
        if (pic) break;
        pic = readFolderArt(row.filepath!);
    }
    if (pic) {
        res.status(200);
        res.setHeader("Content-Type", pic.format || "image/jpeg");
        res.setHeader("Content-Length", String(pic.data.byteLength));
        res.setHeader("Cache-Control", "public, max-age=86400");
        res.end(Buffer.from(pic.data));
        return true;
    }
    return false;
}

// ─── lyrics ──────────────────────────────────────────────────────────────────

/** Parse LRC ("[mm:ss.xx] text") into `{start, value}` lines. Returns null if nothing parsed. */
export function parseLrc(text: string): Array<{ start: number; value: string }> | null {
    const out: Array<{ start: number; value: string }> = [];
    for (const raw of text.split(/\r?\n/)) {
        const m = /^((?:\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/.exec(raw.trim());
        if (!m) continue;
        const value = m[2]!.trim();
        for (const ts of m[1]!.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)) {
            const min = Number(ts[1]); const sec = Number(ts[2]);
            const fracRaw = ts[3] ?? "0";
            const frac = Number(fracRaw) / Math.pow(10, fracRaw.length);
            out.push({ start: Math.round((min * 60 + sec + frac) * 1000), value });
        }
    }
    if (out.length === 0) return null;
    out.sort((a, b) => a.start - b.start);
    return out;
}

export function lyricsBody(row: TrackRow): Body {
    const list: Body[] = [];
    const base = { displayArtist: row.artist ?? undefined, displayTitle: row.title ?? row.filename, lang: "xxx", offset: 0 };
    if (row.synced_lyrics) {
        const lines = parseLrc(row.synced_lyrics);
        if (lines) list.push({ ...base, synced: true, line: lines });
    }
    if (row.lyrics) {
        const lines = row.lyrics.split(/\r?\n/).map((l) => ({ value: l }));
        list.push({ ...base, synced: false, line: lines });
    }
    return { lyricsList: { structuredLyrics: list } };
}
