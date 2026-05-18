/**
 * Folder scanner that drives a `ScanJob` to completion.
 *
 * Two phases:
 *   1. Discovery — recurse the directory tree counting audio files only.
 *      This sets `total` so the UI can show a determinate progress bar.
 *   2. Metadata parse — for each file, run `music-metadata.parseFile()`
 *      and append a `ScannedTrackPayload`. Updates `scanned` + `currentFile`
 *      after every file, throttled to ~60 ms to keep the polling response
 *      cheap without losing the live "current file" feeling.
 *
 * The runner never throws — all errors are folded into `failScanJob`
 * so the client always observes a terminal state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFile } from "music-metadata";
import {
    completeScanJob,
    failScanJob,
    type ScanJob,
    type ScannedTrackPayload,
} from "./scan-jobs";

export const AUDIO_EXTENSIONS = new Set([
    ".mp3", ".wav", ".flac", ".aiff", ".aif", ".m4a", ".aac", ".ogg", ".opus", ".wma",
]);

async function discover(root: string, job: ScanJob, onUpdate: () => void): Promise<string[]> {
    const files: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXTENSIONS.has(ext)) {
                    files.push(full);
                    job.discovered = files.length;
                    if (files.length % 32 === 0) onUpdate();
                }
            }
        }
    }
    return files;
}

async function parseAll(files: string[], job: ScanJob, onUpdate: () => void): Promise<ScannedTrackPayload[]> {
    const tracks: ScannedTrackPayload[] = [];
    let lastEmit = 0;
    for (let i = 0; i < files.length; i++) {
        const fullPath = files[i];
        const ext = path.extname(fullPath).toLowerCase();
        const filename = path.basename(fullPath);
        job.currentFile = filename;
        try {
            const stat = fs.statSync(fullPath);
            const metadata = await parseFile(fullPath, { duration: true });
            tracks.push({
                filepath: fullPath,
                filename,
                artist: metadata.common.artist,
                title: metadata.common.title || filename.replace(ext, ""),
                album: metadata.common.album,
                bpm: metadata.common.bpm,
                key: metadata.common.key,
                duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
                genre: metadata.common.genre?.[0],
                format: ext.replace(".", "").toUpperCase(),
                bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined,
                sampleRate: metadata.format.sampleRate,
                fileSize: stat.size,
                year: metadata.common.year,
            });
        } catch {
            job.errored++;
            try {
                tracks.push({
                    filepath: fullPath,
                    filename,
                    fileSize: fs.statSync(fullPath).size,
                    format: ext.replace(".", "").toUpperCase(),
                });
            } catch { /* file vanished mid-scan, skip silently */ }
        }
        job.scanned = i + 1;
        const now = Date.now();
        if (now - lastEmit > 60) { onUpdate(); lastEmit = now; }
    }
    return tracks;
}

/** Walk a single file (used by the watcher). Returns one payload, never
 *  throws — falls back to a stub on parse error. */
export async function parseSingleFile(fullPath: string): Promise<ScannedTrackPayload | null> {
    const ext = path.extname(fullPath).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) return null;
    const filename = path.basename(fullPath);
    try {
        const stat = fs.statSync(fullPath);
        const metadata = await parseFile(fullPath, { duration: true });
        return {
            filepath: fullPath,
            filename,
            artist: metadata.common.artist,
            title: metadata.common.title || filename.replace(ext, ""),
            album: metadata.common.album,
            bpm: metadata.common.bpm,
            key: metadata.common.key,
            duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
            genre: metadata.common.genre?.[0],
            format: ext.replace(".", "").toUpperCase(),
            bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate / 1000) : undefined,
            sampleRate: metadata.format.sampleRate,
            fileSize: stat.size,
            year: metadata.common.year,
        };
    } catch {
        try {
            return {
                filepath: fullPath,
                filename,
                fileSize: fs.statSync(fullPath).size,
                format: ext.replace(".", "").toUpperCase(),
            };
        } catch { return null; }
    }
}

/** Drive a previously-created ScanJob to completion. Resolves when the
 *  job is finished, regardless of success or failure. */
export async function runScanJob(
    job: ScanJob,
    onUpdate: () => void = () => { /* noop */ },
): Promise<void> {
    const t0 = Date.now();
    console.log(`[scan] start job=${job.id} root="${job.folder}"`);
    try {
        job.status = "discovering";
        onUpdate();
        const files = await discover(job.folder, job, onUpdate);
        job.total = files.length;
        job.status = "scanning";
        onUpdate();
        const tracks = await parseAll(files, job, onUpdate);
        completeScanJob(job.id, tracks);
        onUpdate();
        console.log(`[scan] complete job=${job.id} files=${files.length} errored=${job.errored} totalMs=${Date.now() - t0}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failScanJob(job.id, msg);
        onUpdate();
        console.error(`[scan] failed job=${job.id} err=${msg}`);
    }
}
