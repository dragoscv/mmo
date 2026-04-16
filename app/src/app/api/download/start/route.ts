import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { db } from "@/db";
import { downloads, settings } from "@/db/schema";
import { eq } from "drizzle-orm";

// ─── Helpers ─────────────────────────────────────────────────────────────

const DEFAULT_DOWNLOAD_DIR = path.join(process.cwd(), "data", "downloads");

function getDownloadDir(requestedDir?: string): string {
    if (requestedDir && fs.existsSync(requestedDir)) return requestedDir;
    const row = db.select().from(settings).where(eq(settings.key, "download.downloadFolder")).get();
    if (row?.value && fs.existsSync(row.value)) return row.value;
    return DEFAULT_DOWNLOAD_DIR;
}

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface TrackToDownload {
    url: string;
    title?: string;
    artist?: string;
    duration?: number;
    thumbnail?: string;
    index?: number; // position in playlist
}

interface DownloadParams {
    audioOnly: boolean;
    audioQuality: string;
    audioFormat: string;
    format?: string;
    downloadFolder?: string;
    mediaExtractor?: string;
    autoAddToLibrary?: boolean;
}

// ─── Single track download ───────────────────────────────────────────────

function downloadTrack(
    track: TrackToDownload,
    params: DownloadParams,
    downloadDir: string,
    send: (data: Record<string, unknown>) => void,
): Promise<{ file: string; downloadId: number }> {
    return new Promise((resolve, reject) => {
        // Create download history entry
        const dlRecord = db.insert(downloads).values({
            url: track.url,
            title: track.title || null,
            artist: track.artist || null,
            duration: track.duration || null,
            thumbnail: track.thumbnail || null,
            extractor: params.mediaExtractor || null,
            format: params.audioOnly ? (params.audioFormat === "auto" ? "auto" : params.audioFormat || "auto") : (params.format || "best"),
            quality: params.audioQuality || "auto",
            status: "downloading",
        }).run();
        const downloadId = Number(dlRecord.lastInsertRowid);

        const args: string[] = [
            "--no-playlist",
            "--newline",
            "--no-warnings",
            "--embed-metadata",
            "--embed-thumbnail",
            // Ensure source URL is written to comment field for all formats
            "--parse-metadata", "%(webpage_url)s:%(meta_comment)s",
            "-o", path.join(downloadDir, "%(title)s.%(ext)s"),
        ];

        const fmt = params.audioFormat || "auto";
        const quality = params.audioQuality || "auto";
        const isAutoFormat = fmt === "auto";
        const isAutoQuality = quality === "auto";

        if (params.audioOnly) {
            if (isAutoFormat) {
                // Auto format: pick best audio, try preferred formats in order
                // bestaudio prefers the highest quality native stream
                args.push("-f", "bestaudio");
            } else {
                args.push("-x", "--audio-format", fmt);
            }

            if (!isAutoQuality) {
                if (/^\d+$/.test(quality) && Number(quality) > 9) {
                    args.push("--audio-quality", `${quality}K`);
                } else {
                    args.push("--audio-quality", quality);
                }
            } else {
                args.push("--audio-quality", "0");
            }
        } else if (params.format) {
            args.push("-f", params.format);
        } else {
            if (isAutoFormat) {
                args.push("-f", "bestaudio");
            } else {
                args.push("-x", "--audio-format", fmt);
            }
            args.push("--audio-quality", isAutoQuality ? "0" : quality);
        }

        args.push(track.url);

        const proc = spawn("yt-dlp", args, { windowsHide: true });
        let lastFile = "";

        proc.stdout.on("data", (chunk: Buffer) => {
            const lines = chunk.toString().split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                const progressMatch = trimmed.match(
                    /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/
                );
                if (progressMatch) {
                    send({
                        type: "progress",
                        trackIndex: track.index ?? 0,
                        percent: parseFloat(progressMatch[1]),
                        totalSize: progressMatch[2],
                        speed: progressMatch[3],
                        eta: progressMatch[4],
                    });
                    continue;
                }

                const destMatch = trimmed.match(/\[(?:download|Merger|ExtractAudio)\]\s+(?:Destination:\s+)?(.+\.(?:mp3|m4a|opus|wav|flac|ogg|mp4|mkv|webm))/i);
                if (destMatch) {
                    lastFile = destMatch[1];
                    send({ type: "destination", trackIndex: track.index ?? 0, file: lastFile });
                    continue;
                }

                if (trimmed.includes("has already been downloaded")) {
                    const alreadyMatch = trimmed.match(/\[download\]\s+(.+?)\s+has already/);
                    if (alreadyMatch) lastFile = alreadyMatch[1];
                    send({ type: "already_exists", trackIndex: track.index ?? 0, file: lastFile });
                    continue;
                }

                send({ type: "log", trackIndex: track.index ?? 0, message: trimmed });
            }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
            const msg = chunk.toString().trim();
            if (msg) send({ type: "warning", trackIndex: track.index ?? 0, message: msg });
        });

        proc.on("close", (code) => {
            if (code === 0) {
                let finalFile = lastFile;
                if (!finalFile || !fs.existsSync(finalFile)) {
                    try {
                        const files = fs.readdirSync(downloadDir)
                            .map(f => ({ name: f, path: path.join(downloadDir, f), mtime: fs.statSync(path.join(downloadDir, f)).mtime }))
                            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
                        if (files.length > 0) finalFile = files[0].path;
                    } catch { /* ignore */ }
                }
                try {
                    const fileSize = finalFile && fs.existsSync(finalFile) ? fs.statSync(finalFile).size : null;
                    db.update(downloads).set({ status: "complete", filePath: finalFile, fileSize }).where(eq(downloads.id, downloadId)).run();
                } catch { /* ignore */ }
                resolve({ file: finalFile, downloadId });
            } else {
                try {
                    db.update(downloads).set({ status: "error", error: `yt-dlp exited with code ${code}` }).where(eq(downloads.id, downloadId)).run();
                } catch { /* ignore */ }
                reject(new Error(`yt-dlp exited with code ${code}`));
            }
        });

        proc.on("error", (err) => {
            try {
                db.update(downloads).set({ status: "error", error: err.message }).where(eq(downloads.id, downloadId)).run();
            } catch { /* ignore */ }
            reject(new Error(`Failed to run yt-dlp: ${err.message}`));
        });

        // 5 minute timeout per track
        setTimeout(() => {
            proc.kill("SIGTERM");
            reject(new Error("Download timed out after 5 minutes"));
        }, 300_000);
    });
}

// ─── Route Handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Support both single URL and batch (tracks array)
        const tracks: TrackToDownload[] = [];

        if (body.tracks && Array.isArray(body.tracks)) {
            // Batch/playlist mode
            for (let i = 0; i < body.tracks.length; i++) {
                const t = body.tracks[i];
                tracks.push({
                    url: t.url,
                    title: t.title,
                    artist: t.artist || t.uploader,
                    duration: t.duration,
                    thumbnail: t.thumbnail,
                    index: i,
                });
            }
        } else if (body.url) {
            // Single track mode (backward compatible)
            tracks.push({
                url: body.url,
                title: body.mediaTitle,
                artist: body.mediaArtist,
                duration: body.mediaDuration,
                thumbnail: body.mediaThumbnail,
                index: 0,
            });
        }

        if (tracks.length === 0) {
            return new Response(JSON.stringify({ error: "No tracks to download" }), {
                status: 400, headers: { "Content-Type": "application/json" },
            });
        }

        // Validate all URLs
        for (const t of tracks) {
            if (!t.url || typeof t.url !== "string") {
                return new Response(JSON.stringify({ error: `Invalid URL for track: ${t.title || "unknown"}` }), {
                    status: 400, headers: { "Content-Type": "application/json" },
                });
            }
            try { new URL(t.url); } catch {
                return new Response(JSON.stringify({ error: `Invalid URL format: ${t.url}` }), {
                    status: 400, headers: { "Content-Type": "application/json" },
                });
            }
        }

        const params: DownloadParams = {
            audioOnly: body.audioOnly !== false,
            audioQuality: body.audioQuality || "0",
            audioFormat: body.audioFormat || "mp3",
            format: body.format,
            downloadFolder: body.downloadFolder,
            mediaExtractor: body.mediaExtractor,
            autoAddToLibrary: body.autoAddToLibrary || false,
        };

        const parallelDownloads = Math.max(1, Math.min(8, Number(body.parallelDownloads) || 1));

        const downloadDir = getDownloadDir(params.downloadFolder);
        ensureDir(downloadDir);

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const send = (data: Record<string, unknown>) => {
                    try {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                    } catch { /* stream closed */ }
                };

                send({ type: "batch_started", totalTracks: tracks.length, parallelDownloads });

                const results: { trackIndex: number; file: string; downloadId: number; error?: string }[] = [];

                if (tracks.length === 1 || parallelDownloads <= 1) {
                    // Sequential mode (single track or concurrency=1)
                    for (let i = 0; i < tracks.length; i++) {
                        const track = tracks[i];
                        send({
                            type: "track_started",
                            trackIndex: i,
                            totalTracks: tracks.length,
                            title: track.title,
                            url: track.url,
                        });

                        try {
                            const result = await downloadTrack(track, params, downloadDir, send);
                            results.push({ trackIndex: i, file: result.file, downloadId: result.downloadId });
                            send({
                                type: "track_complete",
                                trackIndex: i,
                                totalTracks: tracks.length,
                                file: result.file,
                                downloadId: result.downloadId,
                                title: track.title,
                            });
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : "Unknown error";
                            results.push({ trackIndex: i, file: "", downloadId: 0, error: msg });
                            send({
                                type: "track_error",
                                trackIndex: i,
                                totalTracks: tracks.length,
                                title: track.title,
                                error: msg,
                            });
                        }
                    }
                } else {
                    // Parallel mode — download up to `parallelDownloads` tracks concurrently
                    let nextIndex = 0;
                    const running = new Set<Promise<void>>();

                    const startNext = (): Promise<void> | null => {
                        if (nextIndex >= tracks.length) return null;
                        const i = nextIndex++;
                        const track = tracks[i];

                        send({
                            type: "track_started",
                            trackIndex: i,
                            totalTracks: tracks.length,
                            title: track.title,
                            url: track.url,
                        });

                        const task = (async () => {
                            try {
                                const result = await downloadTrack(track, params, downloadDir, send);
                                results.push({ trackIndex: i, file: result.file, downloadId: result.downloadId });
                                send({
                                    type: "track_complete",
                                    trackIndex: i,
                                    totalTracks: tracks.length,
                                    file: result.file,
                                    downloadId: result.downloadId,
                                    title: track.title,
                                });
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : "Unknown error";
                                results.push({ trackIndex: i, file: "", downloadId: 0, error: msg });
                                send({
                                    type: "track_error",
                                    trackIndex: i,
                                    totalTracks: tracks.length,
                                    title: track.title,
                                    error: msg,
                                });
                            }
                        })();

                        return task;
                    };

                    // Seed the pool
                    for (let j = 0; j < parallelDownloads && j < tracks.length; j++) {
                        const task = startNext()!;
                        const tracked = task.then(() => { running.delete(tracked); });
                        running.add(tracked);
                    }

                    // As each finishes, start the next
                    while (running.size > 0) {
                        await Promise.race(running);
                        // Fill empty slots
                        while (running.size < parallelDownloads) {
                            const task = startNext();
                            if (!task) break;
                            const tracked = task.then(() => { running.delete(tracked); });
                            running.add(tracked);
                        }
                    }
                }

                send({
                    type: "batch_complete",
                    totalTracks: tracks.length,
                    completed: results.filter(r => !r.error).length,
                    failed: results.filter(r => r.error).length,
                    results,
                });

                controller.close();
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return new Response(JSON.stringify({ error: message }), {
            status: 500, headers: { "Content-Type": "application/json" },
        });
    }
}
