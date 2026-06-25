"use server";

/**
 * Bulk metadata analysis. Tracks live on the companion now, so:
 *  - `getAnalysisScope` derives counts from the companion's /stats endpoint.
 *  - `analyzeTrackBatch` pages tracks (oldest analyzedAt first) and runs
 *    the same metadata-services pipeline locally.
 *  - `applyAnalysisChanges` sends one PATCH per track to the companion.
 *
 * The companion API doesn't expose a "tracks missing X OR Y OR Z"
 * filter; instead we sort by analyzedAt asc and let `compareField`
 * gate which fields actually produce changes.
 */

import { fetchAllMetadata } from "@/lib/metadata-services";
import {
    companionLibrary, companionAnalyzer, getCompanionLink, getAllCompanionLinks,
    type CompanionTrack, type AnalyzeOptions, type AnalyzerHealth, type AnalyzerStatus,
    type AnalyzerLogEntry, type GpuInfo,
} from "@/lib/companion-library";
import { getAnalysisScopeFromCloud, getTracksFromCloud, applyTrackFieldsToCloud } from "@/lib/cloud-library";
import { markTracksAnalyzed } from "@/lib/cloud-library";

export interface AnalysisChange {
    trackId: number;
    trackArtist: string;
    trackTitle: string;
    field: string;
    fieldLabel: string;
    oldValue: string | null;
    newValue: string;
    source: string;
    checked: boolean;
}

export interface AnalysisBatchResult {
    changes: AnalysisChange[];
    processed: number;
    total: number;
    currentTrack: string;
    errors: string[];
    /** IDs of every track read in this batch (for marking analyzed). */
    processedTrackIds?: number[];
}

export interface AnalysisScope {
    total: number;
    missingArtwork: number;
    missingLyrics: number;
    missingGenre: number;
    missingBpm: number;
    missingYear: number;
    missingLabel: number;
    recentlyAnalyzed: number;
}

const FIELD_LABELS: Record<string, string> = {
    artworkUrl: "Artwork",
    genre: "Genre",
    album: "Album",
    year: "Year",
    label: "Label",
    bpm: "BPM",
    isrc: "ISRC",
    lyrics: "Lyrics",
    syncedLyrics: "Synced Lyrics",
    musicbrainzId: "MusicBrainz ID",
    releaseMbid: "Release MBID",
};

const EMPTY_SCOPE: AnalysisScope = {
    total: 0, missingArtwork: 0, missingLyrics: 0, missingGenre: 0,
    missingBpm: 0, missingYear: 0, missingLabel: 0, recentlyAnalyzed: 0,
};

export async function getAnalysisScope(): Promise<AnalysisScope> {
    // Cloud Postgres is the source of truth for the library, so derive the
    // scope (incl. lyrics/year/label/recentlyAnalyzed which /stats never
    // exposed) directly from it — works even when no companion is reachable.
    try {
        return await getAnalysisScopeFromCloud();
    } catch {
        return EMPTY_SCOPE;
    }
}

// Caps to keep this server action surface from amplifying load against
// the companion (one POST = N companion calls) or our outbound metadata
// providers (MusicBrainz / iTunes throttle by source IP — a runaway
// batch here gets the whole web app banned for everyone).
const MAX_BATCH_SIZE = 100;
const MAX_CHANGES_PER_APPLY = 5000;
const MAX_DSP_TRACKS = 5000;

/**
 * True when the track is still missing at least one field the selected
 * options would populate. Lets the batch loop skip the expensive external
 * lookup (≈1.1s each) for already-complete rows in quick mode.
 */
function trackNeedsAnalysis(
    track: CompanionTrack,
    options: { metadata: boolean; artwork: boolean; lyrics: boolean; bpmKey: boolean },
): boolean {
    const blank = (v: unknown) =>
        v == null || v === "" || v === 0 || v === "0" || v === "null";
    if (options.artwork && blank(track.artworkUrl)) return true;
    if (options.bpmKey && blank(track.bpm)) return true;
    if (options.lyrics && blank(track.lyrics) && blank(track.syncedLyrics)) return true;
    if (options.metadata) {
        if (blank(track.genre)) return true;
        if (blank(track.album)) return true;
        if (blank(track.year)) return true;
        if (blank(track.label)) return true;
        if (blank(track.isrc)) return true;
    }
    return false;
}

export async function analyzeTrackBatch(
    offset: number,
    batchSize: number,
    mode: "quick" | "full",
    options: {
        metadata: boolean;
        artwork: boolean;
        lyrics: boolean;
        bpmKey: boolean;
    },
): Promise<AnalysisBatchResult> {
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeBatchSize = Number.isInteger(batchSize) && batchSize > 0
        ? Math.min(batchSize, MAX_BATCH_SIZE) : 25;

    // Page math: 1-based pages.
    const page = Math.floor(safeOffset / safeBatchSize) + 1;

    // Read tracks from cloud Postgres (source of truth). Works even when no
    // companion is reachable from the server, and reflects the full synced
    // library. Oldest-analyzed first so re-runs hit the staler rows.
    let pageData;
    try {
        pageData = await getTracksFromCloud({
            page, pageSize: safeBatchSize,
            sort: "analyzedAt", order: "asc",
        });
    } catch {
        return { changes: [], processed: safeOffset, total: 0, currentTrack: "", errors: ["Failed to fetch tracks"] };
    }

    const batchTracks = pageData.tracks;
    const totalCount = pageData.total;

    const changes: AnalysisChange[] = [];
    const errors: string[] = [];
    let currentTrack = "";

    // Per-track processor. Returns the changes it found (or an error). The
    // MusicBrainz client enforces a global 1.1s throttle internally, so
    // running these concurrently is safe — it overlaps the independent
    // iTunes / Deezer / LRCLIB / CoverArtArchive waits and lets skipped
    // tracks fly through, which is the main speed win.
    const processTrack = async (track: CompanionTrack): Promise<{ changes: AnalysisChange[]; error?: string }> => {
        const artist = track.artist || "Unknown";
        const title = track.title || track.filename;
        const label = `${artist} — ${title}`;
        currentTrack = label;

        if (!track.artist || !track.title) return { changes: [] };

        // Fast path: skip tracks that already have everything the selected
        // options would fill (no external call → no throttle wait).
        if (mode === "quick" && !trackNeedsAnalysis(track, options)) {
            return { changes: [] };
        }

        const local: AnalysisChange[] = [];
        try {
            const metadata = await fetchAllMetadata(
                track.artist, track.title, track.album, track.duration,
                // In quick mode, let the fast parallel providers (iTunes/Deezer)
                // satisfy the common fields and skip MusicBrainz's 1.1s throttle
                // when they do. Full mode always consults MusicBrainz.
                { ...options, fastSkipMusicBrainz: mode === "quick" },
            );

            const compareField = (
                field: keyof CompanionTrack & string,
                newVal: string | number | null | undefined,
                source: string,
            ) => {
                if (newVal == null || newVal === "") return;
                const newStr = String(newVal);
                const oldVal = (track as unknown as Record<string, unknown>)[field];
                const oldStr = oldVal != null ? String(oldVal) : null;
                const isEmpty =
                    oldStr == null || oldStr === "" || oldStr === "0" || oldStr === "null";
                if (isEmpty || (oldStr !== newStr && mode === "full")) {
                    local.push({
                        trackId: track.id,
                        trackArtist: artist, trackTitle: title,
                        field, fieldLabel: FIELD_LABELS[field] || field,
                        oldValue: isEmpty ? null : oldStr,
                        newValue: newStr,
                        source, checked: isEmpty,
                    });
                }
            };

            if (metadata.genre && metadata.sources.genre) compareField("genre", metadata.genre, metadata.sources.genre);
            if (metadata.album && metadata.sources.album) compareField("album", metadata.album, metadata.sources.album);
            if (metadata.year && metadata.sources.year) compareField("year", metadata.year, metadata.sources.year);
            if (metadata.label && metadata.sources.label) compareField("label", metadata.label, metadata.sources.label);
            if (metadata.bpm && metadata.sources.bpm) compareField("bpm", metadata.bpm, metadata.sources.bpm);
            if (metadata.isrc && metadata.sources.isrc) compareField("isrc", metadata.isrc, metadata.sources.isrc);
            if (metadata.artworkUrl && metadata.sources.artworkUrl) compareField("artworkUrl", metadata.artworkUrl, metadata.sources.artworkUrl);

            if (metadata.lyrics && metadata.sources.lyrics) {
                local.push({
                    trackId: track.id, trackArtist: artist, trackTitle: title,
                    field: "lyrics", fieldLabel: "Lyrics",
                    oldValue: track.lyrics ? `${track.lyrics.split("\n").length} lines` : null,
                    newValue: metadata.lyrics, source: metadata.sources.lyrics,
                    checked: !track.lyrics,
                });
            }
            if (metadata.syncedLyrics && metadata.sources.syncedLyrics) {
                local.push({
                    trackId: track.id, trackArtist: artist, trackTitle: title,
                    field: "syncedLyrics", fieldLabel: "Synced Lyrics",
                    oldValue: track.syncedLyrics ? `${track.syncedLyrics.split("\n").length} lines` : null,
                    newValue: metadata.syncedLyrics, source: metadata.sources.syncedLyrics,
                    checked: !track.syncedLyrics,
                });
            }
            if (metadata.musicbrainzId && metadata.sources.musicbrainzId) compareField("musicbrainzId", metadata.musicbrainzId, metadata.sources.musicbrainzId);
            if (metadata.releaseMbid && metadata.sources.releaseMbid) compareField("releaseMbid", metadata.releaseMbid, metadata.sources.releaseMbid);
            return { changes: local };
        } catch (err) {
            return { changes: [], error: `${label}: ${err instanceof Error ? err.message : "Unknown error"}` };
        }
    };

    // Bounded concurrency: process up to CONCURRENCY tracks at once.
    const CONCURRENCY = 8;
    for (let i = 0; i < batchTracks.length; i += CONCURRENCY) {
        const slice = batchTracks.slice(i, i + CONCURRENCY);
        const results = await Promise.all(slice.map(processTrack));
        for (const r of results) {
            changes.push(...r.changes);
            if (r.error) errors.push(r.error);
        }
    }

    return {
        changes,
        processed: safeOffset + batchTracks.length,
        total: totalCount,
        currentTrack,
        errors,
        processedTrackIds: batchTracks.map((t) => t.id),
    };
}

interface ChangeToApply {
    trackId: number;
    field: string;
    newValue: string;
}

/** Mark a set of tracks as analyzed (stamp analyzedAt) without changing any
 *  fields. Lets the metadata analyzer record "I processed these" so a re-run
 *  resumes from the unprocessed tail — used for tracks that yielded no
 *  changes. Returns how many rows were stamped. */
export async function markBatchAnalyzed(trackIds: number[]): Promise<{ marked: number }> {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return { marked: 0 };
    const safe = trackIds.filter((n) => Number.isInteger(n)).slice(0, MAX_CHANGES_PER_APPLY);
    const marked = await markTracksAnalyzed(safe);
    return { marked };
}

export async function applyAnalysisChanges(
    changesToApply: ChangeToApply[],
): Promise<{ applied: number; errors: number }> {
    if (!Array.isArray(changesToApply)) return { applied: 0, errors: 0 };
    // Cap so a runaway client can't loop us through 100k companion PATCHes.
    // Real "apply all" UI flows are O(few hundred); 5000 is a generous bound.
    const safe = changesToApply.slice(0, MAX_CHANGES_PER_APPLY);

    let applied = 0;
    let errorCount = 0;

    const grouped = new Map<number, ChangeToApply[]>();
    for (const change of safe) {
        if (!change || !Number.isInteger(change.trackId) || change.trackId <= 0) continue;
        if (typeof change.field !== "string" || change.field.length === 0 || change.field.length > 64) continue;
        if (typeof change.newValue !== "string" || change.newValue.length > 8192) continue;
        const existing = grouped.get(change.trackId) ?? [];
        existing.push(change);
        grouped.set(change.trackId, existing);
    }

    // Write directly to cloud Postgres (source of truth). The `trackId` is the
    // UI id (companionTrackId when set, else the cloud serial id), so match on
    // either. The companion picks these up on its next sync pull. This works
    // regardless of whether a companion is reachable server-side.
    for (const [trackId, trackChanges] of grouped) {
        try {
            const ok = await applyTrackFieldsToCloud(trackId, trackChanges);
            if (ok) applied += trackChanges.length;
            else errorCount += trackChanges.length;
        } catch {
            errorCount += trackChanges.length;
        }
    }

    return { applied, errors: errorCount };
}

// ─── DSP / source-separation pipeline (companion-side analyzer) ─────────────
//
// The metadata pipeline above only enriches *textual* fields from
// external APIs. The new analyzer pipeline runs actual signal-processing
// on the audio file — Essentia for BPM/key/loudness/beats/chords, and
// state-of-the-art transformer models (BS-Roformer / Mel-Roformer) for
// real source separation. It runs in a Python sidecar managed by the
// companion (see server/python/analyze.py + server/src/library/analyzer.ts).
//
// These actions are thin proxies — the actual queue + persistence lives
// on the companion so jobs survive web-app refreshes.

// Cloudflare/tunnel + transport hiccups that mean "couldn't reach the
// companion right now" rather than "analyzer is offline / deps missing".
// 530/520-526 are Cloudflare origin errors; 502/503/504 are gateway/timeouts.
const TRANSIENT_STATUS = /\((5(?:3\d|2\d|0[234]))\)/; // 502,503,504,520-539
function isTransientCompanionError(msg: string): boolean {
    return TRANSIENT_STATUS.test(msg) || /timed out|timeout|fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(msg);
}

export async function getAnalyzerHealth(): Promise<AnalyzerHealth> {
    const link = await getCompanionLink();
    if (!link) return { ok: false, reason: "Companion not connected" };
    // The per-device Cloudflare tunnel occasionally drops/reconnects, which
    // surfaces as a 530. Retry a couple of times before giving up so a blip
    // doesn't masquerade as "analyzer offline — pip install …".
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await companionAnalyzer.health(link);
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
            if (!isTransientCompanionError(lastErr)) break;
            if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
    }
    const transient = isTransientCompanionError(lastErr);
    return {
        ok: false,
        transient,
        reason: transient
            ? "Couldn't reach the companion (connection dropped). It may be reconnecting — try again in a moment."
            : lastErr,
    };
}

export async function startDspAnalysis(
    trackIds: number[],
    options: AnalyzeOptions,
): Promise<{ jobs: Array<{ id: string; trackId: number }>; error?: string }> {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return { jobs: [] };
    // Bound the array. The companion enqueues one job per id and the
    // analyzer Python sidecar is single-process — a 1M-id push would
    // monopolise the queue for hours.
    const safeIds = trackIds
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, MAX_DSP_TRACKS);
    if (safeIds.length === 0) return { jobs: [] };
    const link = await getCompanionLink();
    if (!link) return { jobs: [], error: "Companion not connected" };
    try { return await companionAnalyzer.start(link, safeIds, options); }
    catch (e) { return { jobs: [], error: e instanceof Error ? e.message : String(e) }; }
}

export async function getAnalyzerStatus(sinceMs?: number): Promise<AnalyzerStatus | { error: string }> {
    const link = await getCompanionLink();
    if (!link) return { error: "Companion not connected" };
    try { return await companionAnalyzer.status(link, sinceMs); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export async function cancelAnalyzerJob(jobId: string): Promise<{ canceled: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { canceled: false, error: "Companion not connected" };
    try { return await companionAnalyzer.cancel(link, jobId); }
    catch (e) { return { canceled: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function retryAnalyzerJob(jobId: string): Promise<{ jobId?: string; trackId?: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.retry(link, jobId);
        return { jobId: r.job.id, trackId: r.job.trackId };
    }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export async function clearAnalyzerQueue(category: "dsp" | "stems" | "fingerprint" | "all" = "all"): Promise<{ removed: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { removed: 0, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.clearQueue(link, category);
        return { removed: r.removed };
    }
    catch (e) { return { removed: 0, error: e instanceof Error ? e.message : String(e) }; }
}

/** Pause one analyzer lane (or all). The currently-running sub-job
 *  in that lane finishes; new work is held until {@link resumeAnalyzerLane}. */
export async function pauseAnalyzerLane(category: "dsp" | "stems" | "fingerprint" | "all" = "all"): Promise<{ paused: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { paused: false, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.pauseLane(link, category);
        return { paused: r.paused };
    }
    catch (e) { return { paused: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function resumeAnalyzerLane(category: "dsp" | "stems" | "fingerprint" | "all" = "all"): Promise<{ paused: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { paused: true, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.resumeLane(link, category);
        return { paused: r.paused };
    }
    catch (e) { return { paused: true, error: e instanceof Error ? e.message : String(e) }; }
}

export async function removeCompletedJob(jobId: string): Promise<{ removed: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { removed: false, error: "Companion not connected" };
    try { return await companionAnalyzer.removeCompleted(link, jobId); }
    catch (e) { return { removed: false, error: e instanceof Error ? e.message : String(e) }; }
}

export async function clearCompletedJobs(
    filter: "all" | "errored" | "done" = "all",
): Promise<{ removed: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { removed: 0, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.clearCompleted(link, filter);
        return { removed: r.removed };
    }
    catch (e) { return { removed: 0, error: e instanceof Error ? e.message : String(e) }; }
}

export async function retryFailedJobs(): Promise<{ enqueued: number; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { enqueued: 0, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.retryFailed(link);
        return { enqueued: r.enqueued };
    }
    catch (e) { return { enqueued: 0, error: e instanceof Error ? e.message : String(e) }; }
}

/** Install GPU acceleration packages into the companion's python.
 *  Long-running (can take minutes for torch+CUDA wheels). */
export async function installGpuSupport(
    target: "onnx" | "torch" | "all" = "onnx",
): Promise<{ installed?: string; gpu?: GpuInfo; log?: string; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.installGpu(link, target);
        return { installed: r.installed, gpu: r.gpu, log: r.log };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

/** Restart the python sidecar (e.g. after manually pip-installing deps). */
export async function restartAnalyzerSidecar(
    force = false,
): Promise<{ ok: boolean; health?: AnalyzerHealth; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { ok: false, error: "Companion not connected" };
    try {
        const r = await companionAnalyzer.restartSidecar(link, force);
        return { ok: r.ok, health: r.health };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

/** Read append-only analyzer log entries.
 *
 *  Pass `since` = the last `seq` you've seen (or 0 to start fresh).
 *  Returns at most `limit` entries with `seq > since`. Use this to
 *  drive a live console on the Analysis page without hammering the
 *  companion with full snapshots. */
export async function getAnalyzerLogs(
    since = 0,
    limit = 500,
): Promise<{ logs: AnalyzerLogEntry[]; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { logs: [], error: "Companion not connected" };
    try { return await companionAnalyzer.logs(link, since, limit); }
    catch (e) { return { logs: [], error: e instanceof Error ? e.message : String(e) }; }
}

/** Page through the entire library and dispatch DSP/stems jobs for
 *  every track. Returns the count of enqueued jobs. Use sparingly —
 *  on a 10k library with stems enabled this is ~10–30 hours of
 *  CPU separation work. The caller should warn before invoking. */
export async function startBulkDspAnalysis(
    options: AnalyzeOptions,
    filter: "all" | "missing-dsp" | "missing-stems" = "missing-dsp",
    forceReanalyze = false,
): Promise<{ enqueued: number; skipped: number; tracksTouched: number; error?: string }> {
    // Multi-companion: enqueue across EVERY online companion so a user with
    // several machines analyzes all their libraries, not just the auto-picked
    // one. Falls back to the single best link if the aggregate is empty.
    const links = await getAllCompanionLinks();
    const targets = links.filter((l) => l.online);
    if (targets.length === 0) {
        const single = await getCompanionLink();
        if (!single) return { enqueued: 0, skipped: 0, tracksTouched: 0, error: "Companion not connected" };
        targets.push({ ...single, name: "companion", online: true, lastSeenAt: new Date() });
    }

    let enqueued = 0;
    let skipped = 0;
    let tracksTouched = 0;
    const PAGE = 200;
    try {
      for (const link of targets) {
        let page = 1;
        while (true) {
            const res = await companionLibrary.getTracks(link, { page, pageSize: PAGE });
            if (!res.tracks.length) break;
            // First narrow by the scope filter (track-level include/exclude).
            const candidates = res.tracks.filter((t) => {
                if (filter === "all") return true;
                if (filter === "missing-dsp") return !t.dspAnalyzedAt;
                if (filter === "missing-stems") return t.stemsStatus !== "ready";
                return true;
            });

            // Then for each candidate, narrow the REQUESTED options to
            // only the categories that are actually missing for THAT
            // track. With three independent worker lanes, a track that
            // has DSP done but missing stems should only enqueue the
            // stems sub-job — re-doing DSP would waste ~30s of CPU.
            // Force-reanalyze bypasses the per-category skip.
            const buckets = new Map<string, number[]>();
            for (const t of candidates) {
                const wantDsp = !!options.dsp && (forceReanalyze || !t.dspAnalyzedAt);
                const wantStems = !!options.stems && (forceReanalyze || t.stemsStatus !== "ready");
                const wantFp = !!options.fingerprint && (forceReanalyze || !t.acoustidFingerprint);
                if (!wantDsp && !wantStems && !wantFp) {
                    skipped++;
                    continue;
                }
                tracksTouched++;
                // Bucket by options-shape so we make one bulk-start
                // call per distinct narrowed-options combination.
                const key = `${wantDsp ? "d" : ""}${wantStems ? "s" : ""}${wantFp ? "f" : ""}`;
                const arr = buckets.get(key);
                if (arr) arr.push(t.id);
                else buckets.set(key, [t.id]);
            }

            for (const [key, ids] of buckets.entries()) {
                if (!ids.length) continue;
                const narrowed: AnalyzeOptions = {
                    dsp: key.includes("d"),
                    stems: key.includes("s"),
                    fingerprint: key.includes("f"),
                    stemsModel: options.stemsModel,
                };
                const r = await companionAnalyzer.start(link, ids, narrowed);
                enqueued += r.jobs.length;
            }

            if (res.tracks.length < PAGE) break;
            page++;
            if (page > 200) break; // 40k safety cap per device
        }
      }
        return { enqueued, skipped, tracksTouched };
    } catch (e) {
        return { enqueued, skipped, tracksTouched, error: e instanceof Error ? e.message : String(e) };
    }
}

/** Returns the per-stem URLs and auth headers the browser needs to
 *  stream the four stem WAVs directly from the companion. Returns
 *  `available: false` (with no URLs) if the track has no real stems
 *  yet — the caller should fall back to the band-pass `separateStems`. */
export async function getCompanionStemsAccess(trackId: number): Promise<
    | { available: true; headers: Record<string, string>; urls: Record<"vocals" | "drums" | "bass" | "other", string> }
    | { available: false; reason: string }
> {
    const link = await getCompanionLink();
    if (!link) return { available: false, reason: "Companion not connected" };

    // Cheap availability probe — the companion's track row tells us
    // whether at least one stem WAV actually exists on disk.
    let track: CompanionTrack | null = null;
    try { track = await companionLibrary.getTrackById(link, trackId); } catch { /* fall through */ }
    if (!track || track.stemsStatus !== "ready") {
        return { available: false, reason: track?.stemsError || "Stems not generated yet" };
    }

    const base = `${link.apiUrl}/library/stems/${trackId}`;
    return {
        available: true,
        headers: { "X-Device-Token": link.token, "X-User-Id": link.userId },
        urls: {
            vocals: `${base}/vocals.wav`,
            drums: `${base}/drums.wav`,
            bass: `${base}/bass.wav`,
            other: `${base}/other.wav`,
        },
    };
}
