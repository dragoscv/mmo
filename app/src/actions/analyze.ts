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
    companionLibrary, companionAnalyzer, getCompanionLink,
    type CompanionTrack, type AnalyzeOptions, type AnalyzerHealth, type AnalyzerStatus,
    type AnalyzerLogEntry, type GpuInfo,
} from "@/lib/companion-library";

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
    const link = await getCompanionLink();
    if (!link) return EMPTY_SCOPE;

    try {
        const stats = await companionLibrary.getStats(link);
        return {
            total: stats.total,
            missingArtwork: stats.health.missingArtwork,
            missingLyrics: 0, // not exposed by /stats yet
            missingGenre: stats.health.missingGenre,
            missingBpm: stats.health.missingBpm,
            missingYear: 0, // not exposed by /stats yet
            missingLabel: 0, // not exposed by /stats yet
            recentlyAnalyzed: 0, // not exposed by /stats yet
        };
    } catch { return EMPTY_SCOPE; }
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
    const link = await getCompanionLink();
    if (!link) {
        return { changes: [], processed: 0, total: 0, currentTrack: "", errors: ["Companion not connected"] };
    }

    // Page math: companion uses 1-based pages.
    const page = Math.floor(offset / batchSize) + 1;

    let pageData;
    try {
        pageData = await companionLibrary.getTracks(link, {
            page, pageSize: batchSize,
            // Oldest-analyzed first so re-runs hit the staler rows.
            sort: "analyzedAt", order: "asc",
        });
    } catch {
        return { changes: [], processed: offset, total: 0, currentTrack: "", errors: ["Failed to fetch tracks"] };
    }

    const batchTracks = pageData.tracks;
    const totalCount = pageData.total;

    const changes: AnalysisChange[] = [];
    const errors: string[] = [];
    let currentTrack = "";

    for (const track of batchTracks) {
        const artist = track.artist || "Unknown";
        const title = track.title || track.filename;
        currentTrack = `${artist} — ${title}`;

        if (!track.artist || !track.title) continue;

        try {
            const metadata = await fetchAllMetadata(
                track.artist, track.title, track.album, track.duration, options,
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
                    changes.push({
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
                changes.push({
                    trackId: track.id, trackArtist: artist, trackTitle: title,
                    field: "lyrics", fieldLabel: "Lyrics",
                    oldValue: track.lyrics ? `${track.lyrics.split("\n").length} lines` : null,
                    newValue: metadata.lyrics, source: metadata.sources.lyrics,
                    checked: !track.lyrics,
                });
            }
            if (metadata.syncedLyrics && metadata.sources.syncedLyrics) {
                changes.push({
                    trackId: track.id, trackArtist: artist, trackTitle: title,
                    field: "syncedLyrics", fieldLabel: "Synced Lyrics",
                    oldValue: track.syncedLyrics ? `${track.syncedLyrics.split("\n").length} lines` : null,
                    newValue: metadata.syncedLyrics, source: metadata.sources.syncedLyrics,
                    checked: !track.syncedLyrics,
                });
            }
            if (metadata.musicbrainzId && metadata.sources.musicbrainzId) compareField("musicbrainzId", metadata.musicbrainzId, metadata.sources.musicbrainzId);
            if (metadata.releaseMbid && metadata.sources.releaseMbid) compareField("releaseMbid", metadata.releaseMbid, metadata.sources.releaseMbid);
        } catch (err) {
            errors.push(`${currentTrack}: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
    }

    return {
        changes,
        processed: offset + batchTracks.length,
        total: totalCount,
        currentTrack,
        errors,
    };
}

interface ChangeToApply {
    trackId: number;
    field: string;
    newValue: string;
}

export async function applyAnalysisChanges(
    changesToApply: ChangeToApply[],
): Promise<{ applied: number; errors: number }> {
    const link = await getCompanionLink();
    if (!link) return { applied: 0, errors: changesToApply.length };

    let applied = 0;
    let errorCount = 0;

    const grouped = new Map<number, ChangeToApply[]>();
    for (const change of changesToApply) {
        const existing = grouped.get(change.trackId) ?? [];
        existing.push(change);
        grouped.set(change.trackId, existing);
    }

    for (const [trackId, trackChanges] of grouped) {
        try {
            const updateObj: Partial<CompanionTrack> = {};
            for (const change of trackChanges) {
                if (change.field === "bpm") {
                    (updateObj as Record<string, unknown>).bpm = parseFloat(change.newValue);
                } else if (change.field === "year") {
                    (updateObj as Record<string, unknown>).year = parseInt(change.newValue, 10);
                } else {
                    (updateObj as Record<string, unknown>)[change.field] = change.newValue;
                }
            }
            (updateObj as Record<string, unknown>).analyzedAt = new Date().toISOString();
            await companionLibrary.updateTrack(link, trackId, updateObj);
            applied += trackChanges.length;
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

export async function getAnalyzerHealth(): Promise<AnalyzerHealth> {
    const link = await getCompanionLink();
    if (!link) return { ok: false, reason: "Companion not connected" };
    try { return await companionAnalyzer.health(link); }
    catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}

export async function startDspAnalysis(
    trackIds: number[],
    options: AnalyzeOptions,
): Promise<{ jobs: Array<{ id: string; trackId: number }>; error?: string }> {
    if (trackIds.length === 0) return { jobs: [] };
    const link = await getCompanionLink();
    if (!link) return { jobs: [], error: "Companion not connected" };
    try { return await companionAnalyzer.start(link, trackIds, options); }
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
    const link = await getCompanionLink();
    if (!link) return { enqueued: 0, skipped: 0, tracksTouched: 0, error: "Companion not connected" };

    let enqueued = 0;
    let skipped = 0;
    let tracksTouched = 0;
    const PAGE = 200;
    let page = 1;
    try {
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
            if (page > 200) break; // 40k safety cap
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
