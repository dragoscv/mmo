/**
 * Video file scanner + ffprobe metadata extraction.
 *
 * Walks configured root folders, finds video files by extension, runs
 * ffprobe to read container/codec/streams, then upserts into the
 * companion's local SQLite mirror and emits sync events to push the
 * metadata up to cloud Postgres.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FFPROBE_BIN } from "./ffmpeg-paths";

const VIDEO_EXTS = new Set([
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm",
    ".m4v", ".mpg", ".mpeg", ".ts", ".m2ts", ".3gp", ".ogv",
]);

export interface ProbedVideo {
    path: string;
    sizeBytes: number;
    mtime: Date;
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    bitrateKbps: number | null;
    hdr: "sdr" | "hdr10" | "hlg" | "dolby" | null;
    audioTracks: Array<{ index: number; codec: string; channels: number; lang: string | null; title: string | null }>;
    subtitleTracks: Array<{ index: number; codec: string; lang: string | null; title: string | null; forced: boolean }>;
}

export async function* walkVideos(root: string): AsyncGenerator<string> {
    let entries: import("node:fs").Dirent[];
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const full = path.join(root, e.name);
        if (e.isDirectory()) {
            yield* walkVideos(full);
        } else if (e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
            yield full;
        }
    }
}

export function ffprobe(filePath: string): Promise<ProbedVideo | null> {
    return new Promise(async (resolve) => {
        let stat: import("node:fs").Stats;
        try {
            stat = await fs.stat(filePath);
        } catch {
            resolve(null);
            return;
        }
        const args = [
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            filePath,
        ];
        const child = spawn(FFPROBE_BIN, args, { windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
        child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }
            try {
                const data = JSON.parse(stdout) as {
                    format?: { format_name?: string; duration?: string; bit_rate?: string };
                    streams?: Array<Record<string, unknown>>;
                };
                const v = (data.streams ?? []).find((s) => s.codec_type === "video") as Record<string, unknown> | undefined;
                const a = (data.streams ?? []).filter((s) => s.codec_type === "audio") as Array<Record<string, unknown>>;
                const subs = (data.streams ?? []).filter((s) => s.codec_type === "subtitle") as Array<Record<string, unknown>>;
                const transfer = (v?.color_transfer as string | undefined)?.toLowerCase() ?? "";
                let hdr: ProbedVideo["hdr"] = "sdr";
                if (transfer.includes("smpte2084")) hdr = "hdr10";
                else if (transfer.includes("arib-std-b67")) hdr = "hlg";
                resolve({
                    path: filePath,
                    sizeBytes: stat.size,
                    mtime: stat.mtime,
                    container: data.format?.format_name ?? null,
                    videoCodec: (v?.codec_name as string | null) ?? null,
                    audioCodec: (a[0]?.codec_name as string | null) ?? null,
                    width: (v?.width as number | null) ?? null,
                    height: (v?.height as number | null) ?? null,
                    durationSec: data.format?.duration ? parseFloat(data.format.duration) : null,
                    bitrateKbps: data.format?.bit_rate ? Math.round(parseInt(data.format.bit_rate, 10) / 1000) : null,
                    hdr,
                    audioTracks: a.map((s, i) => ({
                        index: (s.index as number) ?? i,
                        codec: (s.codec_name as string) ?? "unknown",
                        channels: (s.channels as number) ?? 2,
                        lang: ((s.tags as Record<string, string> | undefined)?.language) ?? null,
                        title: ((s.tags as Record<string, string> | undefined)?.title) ?? null,
                    })),
                    subtitleTracks: subs.map((s, i) => ({
                        index: (s.index as number) ?? i,
                        codec: (s.codec_name as string) ?? "subrip",
                        lang: ((s.tags as Record<string, string> | undefined)?.language) ?? null,
                        title: ((s.tags as Record<string, string> | undefined)?.title) ?? null,
                        forced: ((s.disposition as Record<string, number> | undefined)?.forced ?? 0) === 1,
                    })),
                });
            } catch {
                resolve(null);
            }
        });
    });
}

/** Parse a filename into a best-guess title + year. Looks for `(2023)` or `.2023.`. */
export function parseFilename(file: string): { title: string; year: number | null; season: number | null; episode: number | null } {
    const base = path.basename(file, path.extname(file));
    const seMatch = base.match(/[sS](\d{1,2})[\s._-]?[eE](\d{1,3})/);
    const yearMatch = base.match(/[(\s._-](19\d{2}|20\d{2})[)\s._-]/);
    let title = base
        .replace(/[sS]\d{1,2}[\s._-]?[eE]\d{1,3}.*$/, "")
        .replace(/[(\s._-](19\d{2}|20\d{2})[)\s._-].*/, "")
        .replace(/\b(1080p|720p|480p|2160p|4k|hdr|web-?dl|bluray|brrip|webrip|x264|x265|h264|h265|hevc|aac|ac3|dts|atmos|repack|proper|remux)\b.*$/i, "")
        .replace(/[._]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return {
        title: title || base,
        year: yearMatch ? parseInt(yearMatch[1], 10) : null,
        season: seMatch ? parseInt(seMatch[1], 10) : null,
        episode: seMatch ? parseInt(seMatch[2], 10) : null,
    };
}
