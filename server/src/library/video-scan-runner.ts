/**
 * Video scanner that drives a `ScanJob` (kind="video") to completion.
 *
 * Mirrors `scan-runner.ts` but for movie / TV folders:
 *   1. Discovery — recurse the directory tree counting video files only,
 *      using `VIDEO_EXTS` from `video-scanner.ts`. Sets `total` so the
 *      progress bar is determinate.
 *   2. Probe — for each file run `ffprobe()` plus `parseFilename()`,
 *      derive a resolution label and (for TV) a show-name hint from
 *      the parent-folder layout (`Show Name / Season 01 / file.mkv`).
 *      Updates `scanned` + `currentFile` after every file, throttled
 *      to ~60 ms.
 *
 * Never throws — all errors fold into `failScanJob` so the polling
 * client always sees a terminal state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ffprobe, discoverVideos, parseFilename } from "./video-scanner";
import {
    completeVideoScanJob,
    failScanJob,
    type ScanJob,
    type ScannedVideoPayload,
} from "./scan-jobs";

async function discover(root: string, job: ScanJob, onUpdate: () => void): Promise<{ files: string[]; dirsVisited: number; dirsErrored: number; sampleErrors: Array<{ dir: string; error: string }> }> {
    let lastEmit = 0;
    const result = await discoverVideos(root, {
        concurrency: 16,
        onProgress: (p) => {
            job.discovered = p.files;
            // Surface the current directory so the UI never sits on
            // "0 found" while we crawl deep junk subtrees — the user
            // sees "Reading: D:\Movies\Action\…" tick across.
            job.currentFile = path.basename(p.currentDir) || p.currentDir;
            const now = Date.now();
            if (now - lastEmit > 50) { onUpdate(); lastEmit = now; }
        },
    });
    job.discovered = result.files.length;
    onUpdate();
    return result;
}

/** "1920x1080" → "1080p". Returns null for unknown / tiny / null inputs. */
function resolutionLabel(width: number | null, height: number | null): string | null {
    if (!height || height < 240) return null;
    if (height >= 2000) return "2160p";
    if (height >= 1300) return "1440p";
    if (height >= 1000) return "1080p";
    if (height >= 680) return "720p";
    if (height >= 460) return "480p";
    return `${height}p`;
}

/**
 * Heuristic show-name detector for tv-shows. Given
 *   /media/TV/Breaking Bad/Season 03/Breaking.Bad.S03E07.1080p.mkv
 * returns "Breaking Bad". Falls back to null when the layout is flat
 * (file directly under the scan root with no season folder).
 *
 * The check is simple: walk up the parent chain from the file until we
 * find a folder whose name does NOT look like a season folder, then
 * return its name. Stop when we reach the scan root.
 */
function detectShowHint(filePath: string, scanRoot: string): string | null {
    const rel = path.relative(scanRoot, filePath);
    if (!rel || rel.startsWith("..")) return null;
    const parts = rel.split(/[\\/]/);
    // Drop the filename itself.
    parts.pop();
    if (parts.length === 0) return null;
    // Walk from the file up: skip season-style folders.
    for (let i = parts.length - 1; i >= 0; i--) {
        const name = parts[i];
        if (/^(season[\s._-]*\d+|s\d{1,2}|specials?|extras?|featurettes?)$/i.test(name)) continue;
        return name.replace(/[._]/g, " ").replace(/\s+/g, " ").trim() || null;
    }
    return null;
}

async function probeAll(
    files: string[],
    job: ScanJob,
    scanRoot: string,
    onUpdate: () => void,
): Promise<ScannedVideoPayload[]> {
    const videos: ScannedVideoPayload[] = [];
    let lastEmit = 0;
    for (let i = 0; i < files.length; i++) {
        const fullPath = files[i];
        const filename = path.basename(fullPath);
        job.currentFile = filename;
        const now = Date.now();
        if (now - lastEmit > 60) { onUpdate(); lastEmit = now; }
        const probed = await ffprobe(fullPath);
        const parsed = parseFilename(fullPath);
        // ffprobe failed (file unreadable / not actually a media file)
        // — still emit a stub so the UI shows it as errored rather than
        // silently dropping.
        if (!probed) {
            job.errored++;
            try {
                const stat = fs.statSync(fullPath);
                videos.push({
                    filepath: fullPath,
                    filename,
                    fileSize: stat.size,
                    mtime: stat.mtimeMs,
                    container: null,
                    videoCodec: null,
                    audioCodec: null,
                    width: null,
                    height: null,
                    durationSec: null,
                    bitrateKbps: null,
                    hdr: null,
                    audioTracks: [],
                    subtitleTracks: [],
                    parsedTitle: parsed.title,
                    parsedYear: parsed.year,
                    parsedSeason: parsed.season,
                    parsedEpisode: parsed.episode,
                    showHint: detectShowHint(fullPath, scanRoot),
                    resolutionLabel: null,
                });
            } catch { /* file vanished mid-scan, skip silently */ }
        } else {
            videos.push({
                filepath: fullPath,
                filename,
                fileSize: probed.sizeBytes,
                mtime: probed.mtime.getTime(),
                container: probed.container,
                videoCodec: probed.videoCodec,
                audioCodec: probed.audioCodec,
                width: probed.width,
                height: probed.height,
                durationSec: probed.durationSec,
                bitrateKbps: probed.bitrateKbps,
                hdr: probed.hdr,
                audioTracks: probed.audioTracks,
                subtitleTracks: probed.subtitleTracks,
                parsedTitle: parsed.title,
                parsedYear: parsed.year,
                parsedSeason: parsed.season,
                parsedEpisode: parsed.episode,
                showHint: detectShowHint(fullPath, scanRoot),
                resolutionLabel: resolutionLabel(probed.width, probed.height),
            });
        }
        job.scanned = i + 1;
    }
    return videos;
}

/** Drive a previously-created video ScanJob to completion. */
export async function runVideoScanJob(
    job: ScanJob,
    onUpdate: () => void = () => { /* noop */ },
): Promise<void> {
    const t0 = Date.now();
    console.log(`[video-scan] start job=${job.id} root="${job.folder}"`);
    try {
        // Up-front sanity check — the #1 cause of "0 files found" reports
        // is a stale folder path (drive unplugged, share unmounted). Catch
        // it early and fail the job with a clear message instead of
        // silently returning an empty discovery.
        try {
            const stat = await fs.promises.stat(job.folder);
            if (!stat.isDirectory()) {
                throw new Error(`Path is not a directory: ${job.folder}`);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[video-scan] root unreadable: ${msg}`);
            failScanJob(job.id, `Folder not accessible: ${msg}`);
            onUpdate();
            return;
        }

        job.status = "discovering";
        onUpdate();
        const { files, dirsVisited, dirsErrored, sampleErrors } = await discover(job.folder, job, onUpdate);
        const tDiscover = Date.now() - t0;
        if (files.length === 0) {
            const errSummary = sampleErrors.length > 0
                ? ` First errors: ${sampleErrors.slice(0, 3).map((e) => `${path.basename(e.dir)}: ${e.error}`).join("; ")}`
                : "";
            console.warn(
                `[video-scan] discovered 0 files in ${tDiscover}ms ` +
                `(dirs visited=${dirsVisited}, errored=${dirsErrored}).${errSummary} ` +
                `Check the folder is set to kind=movies/tv-shows and contains files with extensions: ` +
                `mp4 mkv avi mov wmv flv webm m4v mpg mpeg ts m2ts 3gp ogv`,
            );
            if (dirsErrored > 0 && dirsVisited === 0) {
                // Root itself was unreadable — surface a real error so the
                // UI shows it instead of "complete: 0 movies".
                failScanJob(
                    job.id,
                    `Could not read folder contents (${sampleErrors[0]?.error ?? "unknown"}). ` +
                    `If this is an external/network drive, check it's connected and the companion has permission.`,
                );
                onUpdate();
                return;
            }
        } else {
            console.log(
                `[video-scan] discovered ${files.length} video files in ${tDiscover}ms ` +
                `(dirs visited=${dirsVisited}, errored=${dirsErrored}, first: ${path.basename(files[0])})`,
            );
        }
        job.total = files.length;
        job.status = "scanning";
        onUpdate();
        const videos = await probeAll(files, job, job.folder, onUpdate);
        const tTotal = Date.now() - t0;
        console.log(`[video-scan] complete job=${job.id} probed=${videos.length} errored=${job.errored} totalMs=${tTotal}`);
        completeVideoScanJob(job.id, videos);
        onUpdate();
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[video-scan] job=${job.id} crashed: ${msg}`);
        failScanJob(job.id, msg);
        onUpdate();
    }
}
