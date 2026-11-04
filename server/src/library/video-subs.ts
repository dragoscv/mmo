/**
 * Embedded subtitles → WebVTT, ONE ffmpeg pass per file, cached on disk.
 *
 * Before: `/video/subs/:fileId/:track` spawned one ffmpeg per track, each
 * reading the whole source (a 20 GB 4K MKV with 11 tracks = 11 full reads in
 * parallel; measured 367 MB/s per process). Subtitle packets are interleaved
 * through the whole file, so one read is unavoidable — but extracting every
 * text track in that same read costs the same as extracting one (measured).
 *
 * Bitmap tracks (PGS/VobSub/DVB) cannot become WebVTT and are skipped.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { platform } from "../platform";
import { runFfmpeg } from "./ffmpeg-jobs";

const BITMAP_CODECS = new Set(["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "dvb_subtitle", "dvbsub", "xsub"]);

export interface SubTrackInfo { codec: string }

const inflight = new Map<string, Promise<boolean>>();

function cacheDir(fileId: string): string {
    return path.join(platform.getPath("userData"), "subs-cache", fileId);
}

function sig(absPath: string): string {
    try { const st = fs.statSync(absPath); return `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { return ""; }
}

export function isBitmapSub(codec: string | null | undefined): boolean {
    return BITMAP_CODECS.has((codec ?? "").toLowerCase());
}

/** Path of the cached VTT for subtitle ordinal `track`, extracting all text
 *  tracks in one pass on first use. `null` = bitmap / failed. */
export async function subtitleVttPath(fileId: string, absPath: string, track: number, tracks: SubTrackInfo[]): Promise<string | null> {
    const dir = cacheDir(fileId);
    const want = path.join(dir, `${track}.vtt`);
    const stamp = path.join(dir, "source.sig");
    const current = sig(absPath);
    const fresh = fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === current;
    if (fresh) return fs.existsSync(want) ? want : null;
    if (tracks[track] && isBitmapSub(tracks[track].codec)) return null;

    let job = inflight.get(fileId);
    if (!job) {
        job = extractAll(dir, absPath, tracks, current).finally(() => inflight.delete(fileId));
        inflight.set(fileId, job);
    }
    await job;
    return fs.existsSync(want) ? want : null;
}

async function extractAll(dir: string, absPath: string, tracks: SubTrackInfo[], current: string): Promise<boolean> {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    // Unknown track list (old registry entry): try up to 64 ordinals with `?`.
    const ordinals = tracks.length > 0
        ? tracks.map((t, i) => ({ i, ok: !isBitmapSub(t.codec) })).filter((t) => t.ok).map((t) => t.i)
        : [];
    if (tracks.length > 0 && ordinals.length === 0) {
        await fsp.writeFile(path.join(dir, "source.sig"), current, "utf8");
        return true;
    }
    const args = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", absPath];
    for (const i of ordinals) {
        args.push("-map", `0:s:${i}`, "-c:s", "webvtt", "-f", "webvtt", path.join(dir, `${i}.vtt.partial`));
    }
    // Interactive request (a viewer is waiting) → below-normal, not idle.
    const r = await runFfmpeg(args, { priority: "below-normal", timeoutMs: 15 * 60_000 });
    for (const i of ordinals) {
        const p = path.join(dir, `${i}.vtt.partial`);
        if (fs.existsSync(p)) await fsp.rename(p, path.join(dir, `${i}.vtt`)).catch(() => undefined);
    }
    if (r.code === 0) await fsp.writeFile(path.join(dir, "source.sig"), current, "utf8");
    return r.code === 0;
}
