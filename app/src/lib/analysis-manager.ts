import { db } from "@/db";
import { analysisJobs, analysisChanges, tracks, scanLogs } from "@/db/schema";
import type { Track } from "@/db/schema";
import { eq, count, isNull, or, and, sql, lt } from "drizzle-orm";
import { fetchAllMetadata } from "@/lib/metadata-services";

// ─── Types ───────────────────────────────────────────────────────────────────

export type JobStatus = "idle" | "running" | "paused" | "completed" | "stopped";

export interface AnalysisOptions {
    metadata: boolean;
    artwork: boolean;
    lyrics: boolean;
    bpmKey: boolean;
    stems: boolean;
    skipAnalyzedDays: number | null;
    workers: number;
}

export interface AnalysisState {
    status: JobStatus;
    jobId: number | null;
    progress: number;
    total: number;
    currentTrack: string;
    changesCount: number;
    errorsCount: number;
    errors: string[];
}

export interface AnalysisEvent {
    type: "init" | "status" | "progress" | "error";
    [key: string]: unknown;
}

type Subscriber = (event: AnalysisEvent) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const BATCH_SIZE = 5;

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

// ─── Quick Mode Filter ──────────────────────────────────────────────────────

const QUICK_MODE_WHERE = or(
    isNull(tracks.artworkUrl),
    sql`${tracks.artworkUrl} = ''`,
    isNull(tracks.lyrics),
    isNull(tracks.genre),
    sql`${tracks.genre} = ''`,
    or(isNull(tracks.bpm), sql`${tracks.bpm} = 0`),
    isNull(tracks.year),
    isNull(tracks.label),
    sql`${tracks.label} = ''`
);

// ─── Analysis Manager (Singleton) ───────────────────────────────────────────

class AnalysisManager {
    private subscribers = new Set<Subscriber>();
    private _status: JobStatus = "idle";
    private _jobId: number | null = null;
    private _progress = 0;
    private _total = 0;
    private _currentTrack = "";
    private _changesCount = 0;
    private _errorsCount = 0;
    private _errors: string[] = [];
    private pauseResolve: (() => void) | null = null;
    private abortFlag = false;

    constructor() {
        this.recoverState();
    }

    /** Mark interrupted jobs from previous process as stopped */
    private recoverState() {
        try {
            const activeJobs = db
                .select()
                .from(analysisJobs)
                .where(
                    or(
                        eq(analysisJobs.status, "running"),
                        eq(analysisJobs.status, "paused")
                    )
                )
                .all();

            for (const job of activeJobs) {
                db.update(analysisJobs)
                    .set({ status: "stopped", updatedAt: new Date().toISOString() })
                    .where(eq(analysisJobs.id, job.id))
                    .run();
            }
        } catch {
            // Tables may not exist on first run
        }
    }

    // ─── SSE Subscription ────────────────────────────────────────────────

    subscribe(fn: Subscriber): () => void {
        this.subscribers.add(fn);

        // Send current state immediately on subscribe
        if (this._status !== "idle") {
            fn({
                type: "init",
                ...this.getStatus(),
            });
        }

        return () => {
            this.subscribers.delete(fn);
        };
    }

    private emit(event: AnalysisEvent) {
        for (const fn of this.subscribers) {
            try {
                fn(event);
            } catch {
                this.subscribers.delete(fn);
            }
        }
    }

    // ─── Status ──────────────────────────────────────────────────────────

    getStatus(): AnalysisState {
        return {
            status: this._status,
            jobId: this._jobId,
            progress: this._progress,
            total: this._total,
            currentTrack: this._currentTrack,
            changesCount: this._changesCount,
            errorsCount: this._errorsCount,
            errors: this._errors.slice(-20),
        };
    }

    // ─── Start Analysis ──────────────────────────────────────────────────

    async start(
        mode: "quick" | "full",
        options: AnalysisOptions
    ): Promise<{ jobId: number }> {
        if (this._status === "running" || this._status === "paused") {
            throw new Error("Analysis already in progress");
        }

        // Reset state
        this._progress = 0;
        this._total = 0;
        this._currentTrack = "";
        this._changesCount = 0;
        this._errorsCount = 0;
        this._errors = [];
        this.abortFlag = false;
        this.pauseResolve = null;

        try {
            // Create job in DB
            const result = db
                .insert(analysisJobs)
                .values({
                    status: "running",
                    mode,
                    options: JSON.stringify(options),
                })
                .run();

            const jobId = Number(result.lastInsertRowid);
            this._jobId = jobId;
            this._status = "running";

            const workers = Math.max(1, Math.min(options.workers || 1, 5));
            console.log(`[Analysis] Started job ${jobId}, mode=${mode}, workers=${workers}`);

            // Clean up old job changes (keep only current)
            db.delete(analysisChanges)
                .where(sql`${analysisChanges.jobId} != ${jobId}`)
                .run();

            // Log to recent activity
            db.insert(scanLogs)
                .values({
                    action: "analysis_started",
                    filepath: "",
                    details: `Analysis started — ${mode} mode, ${workers} worker${workers > 1 ? "s" : ""}`,
                })
                .run();

            this.emit({
                type: "status",
                ...this.getStatus(),
            });

            // Start processing in background (fire-and-forget)
            this.processAnalysis(mode, options).catch((err) => {
                console.error("[Analysis] Processing failed:", err);
                this._status = "stopped";
                if (this._jobId) {
                    db.update(analysisJobs)
                        .set({
                            status: "stopped",
                            updatedAt: new Date().toISOString(),
                        })
                        .where(eq(analysisJobs.id, this._jobId))
                        .run();
                }
                this.emit({ type: "status", ...this.getStatus() });
            });

            return { jobId };
        } catch (err) {
            // Reset on failure so we don't get stuck in "running"
            console.error("[Analysis] Start failed:", err);
            this._status = "idle";
            this._jobId = null;
            throw err;
        }
    }

    // ─── Background Processing ───────────────────────────────────────────

    private async processAnalysis(
        mode: "quick" | "full",
        options: AnalysisOptions
    ) {
        const workers = Math.max(1, Math.min(options.workers || 1, 5));

        // Build WHERE conditions
        const conditions = [];
        if (mode === "quick") {
            conditions.push(QUICK_MODE_WHERE);
        }
        if (options.skipAnalyzedDays != null && options.skipAnalyzedDays > 0) {
            const cutoff = new Date(
                Date.now() - options.skipAnalyzedDays * 24 * 60 * 60 * 1000
            ).toISOString();
            conditions.push(
                or(isNull(tracks.analyzedAt), lt(tracks.analyzedAt, cutoff))
            );
        }

        const whereClause =
            conditions.length > 0 ? and(...conditions) : undefined;

        // Count total tracks
        if (whereClause) {
            const [result] = db
                .select({ value: count() })
                .from(tracks)
                .where(whereClause)
                .all();
            this._total = result.value;
        } else {
            const [result] = db.select({ value: count() }).from(tracks).all();
            this._total = result.value;
        }

        console.log(`[Analysis] Total tracks to process: ${this._total}, workers: ${workers}`);

        this.emitProgress();

        // If no tracks match the filter, complete immediately
        if (this._total === 0) {
            this._status = "completed";
            this.updateJobInDb();
            this.emit({ type: "status", ...this.getStatus() });
            return;
        }

        let offset = 0;
        const batchSize = Math.max(BATCH_SIZE, workers);

        while (!this.abortFlag) {
            // Wait if paused
            if (this._status === "paused") {
                await new Promise<void>((resolve) => {
                    this.pauseResolve = resolve;
                });
                if (this.abortFlag) break;
            }

            // Fetch batch
            const batchTracks = whereClause
                ? db
                    .select()
                    .from(tracks)
                    .where(whereClause)
                    .limit(batchSize)
                    .offset(offset)
                    .all()
                : db
                    .select()
                    .from(tracks)
                    .limit(batchSize)
                    .offset(offset)
                    .all();

            if (batchTracks.length === 0) break;

            // Process tracks with parallel workers
            if (workers <= 1) {
                // Sequential processing (original behavior)
                for (const track of batchTracks) {
                    if (this.abortFlag) break;
                    if (this._status === "paused") {
                        await new Promise<void>((resolve) => {
                            this.pauseResolve = resolve;
                        });
                        if (this.abortFlag) break;
                    }
                    await this.processTrack(track, mode, options);
                }
            } else {
                // Parallel worker pool
                let idx = 0;
                const runWorker = async () => {
                    while (idx < batchTracks.length) {
                        if (this.abortFlag) break;
                        if (this._status === "paused") {
                            await new Promise<void>((resolve) => {
                                this.pauseResolve = resolve;
                            });
                            if (this.abortFlag) break;
                        }
                        const trackIdx = idx++;
                        if (trackIdx >= batchTracks.length) break;
                        await this.processTrack(
                            batchTracks[trackIdx],
                            mode,
                            options
                        );
                    }
                };
                await Promise.all(
                    Array.from({ length: workers }, () => runWorker())
                );
            }

            this._progress = offset + batchTracks.length;

            // Update job in DB
            this.updateJobInDb();

            // Emit progress to SSE subscribers
            this.emitProgress();

            offset += batchSize;
            if (this._progress >= this._total) break;
        }

        // Final status
        if (this.abortFlag) {
            this._status = "stopped";
        } else {
            this._status = "completed";
        }

        // Log completion to recent activity
        db.insert(scanLogs)
            .values({
                action: "analysis_completed",
                filepath: "",
                details: `Analysis ${this.abortFlag ? "stopped" : "completed"} — ${this._changesCount} changes found, ${this._progress}/${this._total} tracks`,
            })
            .run();

        this.updateJobInDb();
        this.emit({ type: "status", ...this.getStatus() });
    }

    // ─── Process Single Track ────────────────────────────────────────────

    private async processTrack(
        track: Track,
        mode: "quick" | "full",
        options: AnalysisOptions
    ) {
        const artist = track.artist || "Unknown";
        const title = track.title || track.filename;
        this._currentTrack = `${artist} — ${title}`;

        if (!track.artist || !track.title) return;

        try {
            const metadata = await fetchAllMetadata(
                track.artist,
                track.title,
                track.album,
                track.duration,
                options
            );

            const batchChanges: Array<{
                jobId: number;
                trackId: number;
                trackArtist: string;
                trackTitle: string;
                field: string;
                fieldLabel: string;
                oldValue: string | null;
                newValue: string;
                source: string;
                checked: boolean;
            }> = [];

            const compareField = (
                field: keyof Track & string,
                newVal: string | number | null | undefined,
                source: string
            ) => {
                if (newVal == null || newVal === "") return;
                const newStr = String(newVal);
                const oldVal = track[field];
                const oldStr =
                    oldVal != null ? String(oldVal) : null;
                const isEmpty =
                    oldStr == null ||
                    oldStr === "" ||
                    oldStr === "0" ||
                    oldStr === "null";

                if (
                    isEmpty ||
                    (oldStr !== newStr && mode === "full")
                ) {
                    batchChanges.push({
                        jobId: this._jobId!,
                        trackId: track.id,
                        trackArtist: artist,
                        trackTitle: title,
                        field,
                        fieldLabel: FIELD_LABELS[field] || field,
                        oldValue: isEmpty ? null : oldStr,
                        newValue: newStr,
                        source,
                        checked: isEmpty,
                    });
                }
            };

            // Compare all metadata fields
            if (metadata.genre && metadata.sources.genre)
                compareField("genre", metadata.genre, metadata.sources.genre);
            if (metadata.album && metadata.sources.album)
                compareField("album", metadata.album, metadata.sources.album);
            if (metadata.year && metadata.sources.year)
                compareField("year", metadata.year, metadata.sources.year);
            if (metadata.label && metadata.sources.label)
                compareField("label", metadata.label, metadata.sources.label);
            if (metadata.bpm && metadata.sources.bpm)
                compareField("bpm", metadata.bpm, metadata.sources.bpm);
            if (metadata.isrc && metadata.sources.isrc)
                compareField("isrc", metadata.isrc, metadata.sources.isrc);
            if (metadata.artworkUrl && metadata.sources.artworkUrl)
                compareField(
                    "artworkUrl",
                    metadata.artworkUrl,
                    metadata.sources.artworkUrl
                );
            if (metadata.musicbrainzId && metadata.sources.musicbrainzId)
                compareField(
                    "musicbrainzId",
                    metadata.musicbrainzId,
                    metadata.sources.musicbrainzId
                );
            if (metadata.releaseMbid && metadata.sources.releaseMbid)
                compareField(
                    "releaseMbid",
                    metadata.releaseMbid,
                    metadata.sources.releaseMbid
                );

            // Lyrics (special handling - store full text)
            if (metadata.lyrics && metadata.sources.lyrics) {
                batchChanges.push({
                    jobId: this._jobId!,
                    trackId: track.id,
                    trackArtist: artist,
                    trackTitle: title,
                    field: "lyrics",
                    fieldLabel: "Lyrics",
                    oldValue: track.lyrics
                        ? `${track.lyrics.split("\n").length} lines`
                        : null,
                    newValue: metadata.lyrics,
                    source: metadata.sources.lyrics,
                    checked: !track.lyrics,
                });
            }
            if (metadata.syncedLyrics && metadata.sources.syncedLyrics) {
                batchChanges.push({
                    jobId: this._jobId!,
                    trackId: track.id,
                    trackArtist: artist,
                    trackTitle: title,
                    field: "syncedLyrics",
                    fieldLabel: "Synced Lyrics",
                    oldValue: track.syncedLyrics
                        ? `${track.syncedLyrics.split("\n").length} lines`
                        : null,
                    newValue: metadata.syncedLyrics,
                    source: metadata.sources.syncedLyrics,
                    checked: !track.syncedLyrics,
                });
            }

            // Persist changes to DB
            if (batchChanges.length > 0) {
                db.insert(analysisChanges).values(batchChanges).run();
                this._changesCount += batchChanges.length;
            }
            // Mark track as analyzed regardless of changes found
            db.update(tracks)
                .set({ analyzedAt: new Date().toISOString() })
                .where(eq(tracks.id, track.id))
                .run();

            // Queue for stems separation if enabled and not already processed
            if (options.stems && track.stemsStatus !== "ready") {
                db.update(tracks)
                    .set({ stemsStatus: "pending" })
                    .where(eq(tracks.id, track.id))
                    .run();
            }
        } catch (err) {
            const errMsg = `${this._currentTrack}: ${err instanceof Error ? err.message : "Unknown error"}`;
            this._errors.push(errMsg);
            this._errorsCount++;
        }
    }

    private emitProgress() {
        this.emit({
            type: "progress",
            ...this.getStatus(),
        });
    }

    private updateJobInDb() {
        if (!this._jobId) return;
        db.update(analysisJobs)
            .set({
                status: this._status,
                progress: this._progress,
                total: this._total,
                currentTrack: this._currentTrack,
                changesCount: this._changesCount,
                errorsCount: this._errorsCount,
                errors: JSON.stringify(this._errors.slice(-50)),
                updatedAt: new Date().toISOString(),
            })
            .where(eq(analysisJobs.id, this._jobId))
            .run();
    }

    // ─── Controls ────────────────────────────────────────────────────────

    pause() {
        if (this._status !== "running") return;
        this._status = "paused";
        this.updateJobInDb();
        this.emit({ type: "status", ...this.getStatus() });
    }

    resume() {
        if (this._status !== "paused") return;
        this._status = "running";
        this.updateJobInDb();
        this.pauseResolve?.();
        this.pauseResolve = null;
        this.emit({ type: "status", ...this.getStatus() });
    }

    stop() {
        if (this._status !== "running" && this._status !== "paused") return;
        this.abortFlag = true;
        // Unblock if paused
        if (this.pauseResolve) {
            this.pauseResolve();
            this.pauseResolve = null;
        }
    }

    reset() {
        if (this._status === "running" || this._status === "paused") {
            this.stop();
        }
        this._status = "idle";
        this._jobId = null;
        this._progress = 0;
        this._total = 0;
        this._currentTrack = "";
        this._changesCount = 0;
        this._errorsCount = 0;
        this._errors = [];
        this.emit({ type: "status", ...this.getStatus() });
    }
}

// ─── Singleton (HMR-safe) ───────────────────────────────────────────────────

const globalForAnalysis = globalThis as unknown as {
    analysisManager: AnalysisManager;
};

export const analysisManager =
    globalForAnalysis.analysisManager ?? new AnalysisManager();

if (process.env.NODE_ENV !== "production") {
    globalForAnalysis.analysisManager = analysisManager;
}
