/**
 * Background analysis manager — single-flight orchestrator.
 *
 * This is the engine the modal's "Start Analysis" button drives when
 * the user picks the textual / metadata categories (Metadata, Artwork,
 * Lyrics, BPM-web). It pages through the companion's tracks, calls
 * `analyzeTrackBatch` to fetch external metadata (MusicBrainz, iTunes,
 * Deezer, CoverArtArchive, LRCLIB), accumulates a change set in memory,
 * and emits live status snapshots over SSE.
 *
 * Why in-memory instead of SQLite? The original SQLite-backed pipeline
 * (analysis_jobs / analysis_changes tables) moved with the library to
 * the companion. Re-implementing those tables on the web side would
 * just duplicate the companion's persistence. For the textual pipeline
 * the user-facing flow is "Run → Review → Apply or Cancel" within a
 * single modal session, so in-memory state is enough — when the user
 * closes the modal without applying, the changes are intentionally
 * discarded.
 *
 * Concurrency model:
 *  - One in-flight job at a time (singleton).
 *  - The job loop walks `analyzeTrackBatch` page-by-page until processed
 *    >= total, OR a stop is requested, OR an unrecoverable error.
 *  - Pause flips a boolean checked between batches (the in-flight batch
 *    is allowed to finish to avoid wasting MusicBrainz rate-limit budget).
 *  - HMR safety: the singleton is hung off `globalThis` so Next.js dev
 *    hot-reload doesn't spawn a second concurrent manager.
 */

import { analyzeTrackBatch, applyAnalysisChanges, type AnalysisChange as RawChange } from "@/actions/analyze";
import { getCompanionLink, companionLibrary } from "@/lib/companion-library";

export type JobStatus = "idle" | "running" | "paused" | "completed" | "stopped";

/** Wire-format change object: same as RawChange + stable per-job id +
 *  the jobId it belongs to. The modal toggles `checked` per-id and
 *  posts the checked ids back to /api/analysis/apply. */
export interface ManagedChange extends RawChange {
    id: number;
    jobId: number;
    /** Pretty preview of the new value (e.g. "12 lines" for lyrics) so
     *  the review UI doesn't dump 4 KB of synced lyrics into a row. */
    newValueDisplay: string;
}

export interface JobStatusSnapshot {
    status: JobStatus;
    jobId: number | null;
    mode: "quick" | "full" | null;
    progress: number;
    total: number;
    currentTrack: string | null;
    changesCount: number;
    errorsCount: number;
    errors: string[];
}

interface StartOptions {
    metadata: boolean;
    artwork: boolean;
    lyrics: boolean;
    bpmKey: boolean;
    /** Companion-side flags — accepted here so the modal call signature
     *  is uniform. The DSP/stems/fingerprint queues are kicked
     *  separately by the modal via `startBulkDspAnalysis` and don't
     *  flow through this manager. */
    stems?: boolean;
    dsp?: boolean;
    fingerprint?: boolean;
    skipAnalyzedDays: number | null;
    workers: number;
}

type Subscriber = (event: JobStatusSnapshot) => void;

const BATCH_SIZE = 5; // small enough that the UI sees progress within ~5s even on cold MusicBrainz cache.

class AnalysisManager {
    private snapshot: JobStatusSnapshot = {
        status: "idle",
        jobId: null,
        mode: null,
        progress: 0,
        total: 0,
        currentTrack: null,
        changesCount: 0,
        errorsCount: 0,
        errors: [],
    };
    private changes: ManagedChange[] = [];
    private subscribers = new Set<Subscriber>();
    private nextChangeId = 1;
    private nextJobId = 1;
    private pauseRequested = false;
    private stopRequested = false;
    /** Currently running job promise — kept so re-entry into start()
     *  while a job is still alive can refuse cleanly. */
    private currentRun: Promise<void> | null = null;

    getStatus(): JobStatusSnapshot {
        return { ...this.snapshot, errors: [...this.snapshot.errors] };
    }

    /** Return changes belonging to the supplied jobId (or all when
     *  jobId is null). The modal currently asks for the active job. */
    getChanges(jobId: number | null): ManagedChange[] {
        if (jobId == null) return [...this.changes];
        return this.changes.filter((c) => c.jobId === jobId);
    }

    subscribe(fn: Subscriber): () => void {
        this.subscribers.add(fn);
        return () => { this.subscribers.delete(fn); };
    }

    async start(
        mode: "quick" | "full",
        options: StartOptions,
    ): Promise<{ success: boolean; jobId?: number; error?: string }> {
        if (this.snapshot.status === "running" || this.snapshot.status === "paused") {
            return { success: false, error: "An analysis job is already running" };
        }
        // If the user only ticked DSP/stems/fingerprint (companion-side
        // categories) and no textual options, this manager has nothing
        // to do — the modal kicks the companion lanes separately. Return
        // success so the modal flow continues; status stays idle so the
        // UI doesn't sit waiting on us.
        if (!options.metadata && !options.artwork && !options.lyrics && !options.bpmKey) {
            return { success: true };
        }

        const jobId = this.nextJobId++;
        // Reset job-scoped state.
        this.changes = [];
        this.nextChangeId = 1;
        this.pauseRequested = false;
        this.stopRequested = false;
        this.snapshot = {
            status: "running",
            jobId,
            mode,
            progress: 0,
            total: 0,
            currentTrack: null,
            changesCount: 0,
            errorsCount: 0,
            errors: [],
        };
        this.emit();

        // Fire-and-forget the loop. We track it on `this.currentRun`
        // so a future "join on shutdown" can await it cleanly.
        this.currentRun = this.runJob(jobId, mode, options).catch((err) => {
            this.snapshot = {
                ...this.snapshot,
                status: "stopped",
                errors: [
                    ...this.snapshot.errors,
                    `Fatal: ${err instanceof Error ? err.message : String(err)}`,
                ],
                errorsCount: this.snapshot.errorsCount + 1,
            };
            this.emit();
        }).finally(() => {
            this.currentRun = null;
        });

        return { success: true, jobId };
    }

    pause(): void {
        if (this.snapshot.status !== "running") return;
        this.pauseRequested = true;
        this.snapshot = { ...this.snapshot, status: "paused" };
        this.emit();
    }

    resume(): void {
        if (this.snapshot.status !== "paused") return;
        this.pauseRequested = false;
        this.snapshot = { ...this.snapshot, status: "running" };
        this.emit();
    }

    stop(): void {
        if (this.snapshot.status === "idle" || this.snapshot.status === "completed") return;
        this.stopRequested = true;
        this.pauseRequested = false; // unblock the wait loop
        this.snapshot = { ...this.snapshot, status: "stopped" };
        this.emit();
    }

    reset(): void {
        // Allowed even when running — caller is committing to discard.
        this.stopRequested = true;
        this.pauseRequested = false;
        this.snapshot = {
            status: "idle",
            jobId: null,
            mode: null,
            progress: 0,
            total: 0,
            currentTrack: null,
            changesCount: 0,
            errorsCount: 0,
            errors: [],
        };
        this.changes = [];
        this.emit();
    }

    /** Apply selected changes by id. Routes through the existing
     *  `applyAnalysisChanges` server action so the companion PATCH
     *  semantics stay in one place. */
    async apply(changeIds: number[]): Promise<{ applied: number; errors: number }> {
        const idSet = new Set(changeIds);
        const toApply = this.changes
            .filter((c) => idSet.has(c.id))
            .map((c) => ({ trackId: c.trackId, field: c.field, newValue: c.newValue }));
        if (toApply.length === 0) return { applied: 0, errors: 0 };
        const result = await applyAnalysisChanges(toApply);
        // Drop applied changes so a second apply call can't re-send them.
        if (result.applied > 0) {
            this.changes = this.changes.filter((c) => !idSet.has(c.id));
        }
        return result;
    }

    // ─── Internals ───────────────────────────────────────────────────

    private emit(): void {
        const snap = this.getStatus();
        for (const fn of this.subscribers) {
            try { fn(snap); } catch { /* subscriber threw — drop quietly */ }
        }
    }

    private async waitWhilePaused(): Promise<void> {
        // Cheap polling — pause is a manual UI action, no perf concern.
        while (this.pauseRequested && !this.stopRequested) {
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    private async runJob(
        jobId: number,
        mode: "quick" | "full",
        options: StartOptions,
    ): Promise<void> {
        // Pre-flight: get the total track count immediately so the
        // modal shows "0 of 8607" instead of "0 of 0" while the first
        // batch (25-30s of MusicBrainz calls) is still in flight.
        try {
            const link = await getCompanionLink();
            if (link) {
                const head = await companionLibrary.getTracks(link, { page: 1, pageSize: 1 });
                this.snapshot = { ...this.snapshot, total: head.total };
                this.emit();
            }
        } catch {
            // Pre-flight failure is non-fatal — the first batch will
            // populate `total` anyway. Just means the UI sits at
            // "0 of 0" for ~30s longer.
        }

        let offset = 0;
        let total = this.snapshot.total || Number.MAX_SAFE_INTEGER;
        let lastProcessed = -1;

        while (offset < total) {
            await this.waitWhilePaused();
            if (this.stopRequested) break;

            // Heartbeat: tell the UI we're starting a new batch so the
            // "Analyzing" label refreshes even before the slow batch
            // returns. Without this the modal looks frozen for ~30s
            // between batches on first run.
            this.snapshot = {
                ...this.snapshot,
                currentTrack: this.snapshot.currentTrack ||
                    `Scanning tracks ${offset + 1}–${Math.min(offset + BATCH_SIZE, total)}…`,
            };
            this.emit();

            const result = await analyzeTrackBatch(offset, BATCH_SIZE, mode, {
                metadata: options.metadata,
                artwork: options.artwork,
                lyrics: options.lyrics,
                bpmKey: options.bpmKey,
            });

            // Companion offline / network down before any progress:
            // surface and stop — retrying the same batch would just
            // spam the same failure into the UI.
            if (result.errors.length > 0 && result.processed === 0) {
                this.snapshot = {
                    ...this.snapshot,
                    status: "stopped",
                    errors: [...this.snapshot.errors, ...result.errors],
                    errorsCount: this.snapshot.errorsCount + result.errors.length,
                };
                this.emit();
                return;
            }

            total = result.total || total;

            // Assign per-change ids so the modal can toggle/apply by id.
            for (const c of result.changes) {
                this.changes.push({
                    ...c,
                    id: this.nextChangeId++,
                    jobId,
                    newValueDisplay: previewValue(c.field, c.newValue),
                });
            }

            // Defensive: page failed to advance. Bail rather than loop.
            if (result.processed === lastProcessed) break;
            lastProcessed = result.processed;
            offset = result.processed;

            this.snapshot = {
                ...this.snapshot,
                progress: offset,
                total,
                currentTrack: result.currentTrack || this.snapshot.currentTrack,
                changesCount: this.changes.length,
                errorsCount: this.snapshot.errorsCount + result.errors.length,
                errors: [
                    ...this.snapshot.errors,
                    ...result.errors,
                ].slice(-50), // cap so a flaky network doesn't blow memory
            };
            this.emit();

            if (result.processed >= total) break;
        }

        // Honor explicit stop (don't flip to "completed").
        if (this.stopRequested) {
            this.snapshot = { ...this.snapshot, status: "stopped" };
            this.emit();
            return;
        }
        this.snapshot = { ...this.snapshot, status: "completed" };
        this.emit();
    }
}

/** Truncate big text fields for the review UI; pass numbers / short
 *  strings through unchanged. */
function previewValue(field: string, value: string): string {
    if (field === "lyrics" || field === "syncedLyrics") {
        const lines = value.split("\n").length;
        return `${lines} line${lines === 1 ? "" : "s"}`;
    }
    if (value.length > 80) return value.slice(0, 77) + "…";
    return value;
}

// HMR-safe singleton: hang off globalThis so Next.js dev reload doesn't
// spawn a second manager (which would race for the SSE subscribers).
const GLOBAL_KEY = Symbol.for("mmo.analysis-manager");
type GlobalWithManager = typeof globalThis & {
    [k: symbol]: AnalysisManager | undefined;
};
const g = globalThis as GlobalWithManager;
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new AnalysisManager();
export const analysisManager: AnalysisManager = g[GLOBAL_KEY] as AnalysisManager;
