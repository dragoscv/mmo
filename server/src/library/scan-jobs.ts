/**
 * In-memory scan-job registry.
 *
 * A "scan job" represents one walk of a folder. The web app starts a job
 * via `POST /scan` and then polls `GET /scan/jobs/:id` for progress. Once
 * complete, the web action ingests the produced track records into the
 * companion's library DB through the existing `/library/tracks/ingest`
 * endpoint (preserving the per-user ingest path).
 *
 * Why not WebSocket-pushed progress? Polling at 750–1000 ms is plenty for
 * a UX bar, and survives page refreshes / network blips with zero extra
 * code. The companion remains the source of truth — kill the browser tab,
 * reopen, and progress resumes seamlessly.
 *
 * Jobs that complete successfully are kept for 5 minutes so a refresh
 * can still see "100% — done". Failed jobs are kept for 15 minutes to
 * give the user time to read the error.
 */

import { randomUUID } from "node:crypto";

export interface ScannedTrackPayload {
    filepath: string;
    filename: string;
    artist?: string;
    title?: string;
    album?: string;
    bpm?: number;
    key?: string;
    duration?: number;
    genre?: string;
    format?: string;
    bitrate?: number;
    sampleRate?: number;
    fileSize: number;
    year?: number;
}

/**
 * Payload for a single scanned video file. Carries enough of the ffprobe
 * result to drive grouping (parsed title/year/season/episode), to render
 * the per-file UI badge (resolution, codec), and to upsert into the
 * cloud `videoFiles` row without a second probe at ingest time.
 */
export interface ScannedVideoPayload {
    filepath: string;
    filename: string;
    fileSize: number;
    mtime: number; // ms since epoch
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
    /** Parsed from the basename. `season`/`episode` are null for movies. */
    parsedTitle: string;
    parsedYear: number | null;
    parsedSeason: number | null;
    parsedEpisode: number | null;
    /** Show name when the file lives under a `Show Name/Season 01/` tree.
     *  Falls back to `parsedTitle` for flat layouts. Only meaningful for tv-shows. */
    showHint: string | null;
    /** Standard label: "480p" | "720p" | "1080p" | "1440p" | "2160p" | null. */
    resolutionLabel: string | null;
}

export type ScanJobKind = "audio" | "video";

export type ScanJobStatus = "pending" | "discovering" | "scanning" | "complete" | "error" | "canceled";

export interface ScanJob {
    id: string;
    folder: string;
    /** Which payload shape this job produces. Drives the runner used
     *  on the companion side and the ingest action on the web side. */
    kind: ScanJobKind;
    status: ScanJobStatus;
    /** Total files discovered so far (grows during the discovery phase). */
    discovered: number;
    /** Files for which metadata has been parsed (grows during scanning). */
    scanned: number;
    /** Files that errored during metadata parse (still emitted with a stub). */
    errored: number;
    /** Most recent file being processed — drives the "current file" UI label. */
    currentFile: string | null;
    /** Total target once discovery completes. -1 while still discovering. */
    total: number;
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    /** Filled in once status === "complete" for audio jobs. Cleared after
     *  retrieval to free memory; the web app fetches once then ingests. */
    tracks: ScannedTrackPayload[] | null;
    /** Same as `tracks` but for video jobs. */
    videos: ScannedVideoPayload[] | null;
    /** Origin label for telemetry: manual scan vs watcher event. */
    origin: "manual" | "watcher";
}

const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 15 * 60_000;

const jobs = new Map<string, ScanJob>();

export function createScanJob(
    folder: string,
    origin: "manual" | "watcher" = "manual",
    kind: ScanJobKind = "audio",
): ScanJob {
    const job: ScanJob = {
        id: randomUUID(),
        folder,
        kind,
        status: "pending",
        discovered: 0,
        scanned: 0,
        errored: 0,
        currentFile: null,
        total: -1,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        tracks: null,
        videos: null,
        origin,
    };
    jobs.set(job.id, job);
    return job;
}

export function getScanJob(id: string): ScanJob | undefined {
    return jobs.get(id);
}

/** Return all jobs (active or recently-finished) for one folder. Used by
 *  the web app to recover progress after a refresh. */
export function listScanJobsForFolder(folder: string): ScanJob[] {
    const out: ScanJob[] = [];
    for (const j of jobs.values()) if (j.folder === folder) out.push(j);
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
}

/** Return all currently-active jobs (pending / discovering / scanning). */
export function listActiveScanJobs(): ScanJob[] {
    return Array.from(jobs.values()).filter((j) =>
        j.status === "pending" || j.status === "discovering" || j.status === "scanning",
    );
}

/** Return all jobs (active + finished within TTL). */
export function listAllScanJobs(): ScanJob[] {
    return Array.from(jobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}

/** Mark a job complete and stash its tracks payload for the web app to
 *  pick up on its next poll. */
export function completeScanJob(id: string, tracks: ScannedTrackPayload[]): void {
    const j = jobs.get(id);
    if (!j) return;
    j.status = "complete";
    j.tracks = tracks;
    j.total = tracks.length;
    j.scanned = tracks.length;
    j.finishedAt = Date.now();
    j.currentFile = null;
}

/** Same as `completeScanJob` but for video jobs. */
export function completeVideoScanJob(id: string, videos: ScannedVideoPayload[]): void {
    const j = jobs.get(id);
    if (!j) return;
    j.status = "complete";
    j.videos = videos;
    j.total = videos.length;
    j.scanned = videos.length;
    j.finishedAt = Date.now();
    j.currentFile = null;
}

export function failScanJob(id: string, error: string): void {
    const j = jobs.get(id);
    if (!j) return;
    j.status = "error";
    j.error = error;
    j.finishedAt = Date.now();
}

export function clearJobTracks(id: string): void {
    const j = jobs.get(id);
    if (j) { j.tracks = null; j.videos = null; }
}

/** Periodic GC. Called once a minute from the server bootstrap. */
function gcJobs() {
    const now = Date.now();
    for (const [id, j] of jobs) {
        if (!j.finishedAt) continue;
        const ttl = j.status === "error" ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
        if (now - j.finishedAt > ttl) jobs.delete(id);
    }
}

let gcTimer: NodeJS.Timeout | null = null;
export function startScanJobGc() {
    if (gcTimer) return;
    gcTimer = setInterval(gcJobs, 60_000);
    if (typeof gcTimer.unref === "function") gcTimer.unref();
}
export function stopScanJobGc() {
    if (gcTimer) { clearInterval(gcTimer); gcTimer = null; }
}
