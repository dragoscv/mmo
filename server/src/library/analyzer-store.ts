/**
 * SQLite-backed persistence for the analyzer's per-category queues.
 *
 * Why persist:
 * - The companion runs the analyzer over the user's WHOLE library
 *   (8 607 tracks in our reference user's case). At ~5 min/track on
 *   stems that's a ~700-hour batch. A power outage, OS update, or
 *   companion restart used to throw it all away. Now we resume
 *   exactly where we left off.
 * - Splitting per-category means we want the DSP queue to keep
 *   working even if the stems queue is paused (or its GPU is being
 *   used by another app). Each lane stores independently.
 *
 * Schema is intentionally minimal — one row per (track × category)
 * sub-job. The `request_id` groups sub-jobs that came from the same
 * `analyzer.enqueue(track, {dsp,stems,fp})` call so the UI can show
 * "track X is 2/3 categories done".
 *
 * The store re-uses the same SQLite file as the library DB
 * (`getLibrarySqlite()`); a separate file would mean two write
 * locks and zero observable benefit.
 */

import type { Database as SqliteDatabase } from "better-sqlite3";
import { getLibrarySqlite } from "./db";

export type Category = "dsp" | "stems" | "fingerprint" | "metadata";
export const CATEGORIES: readonly Category[] = ["dsp", "stems", "fingerprint", "metadata"] as const;

export type JobState = "queued" | "running" | "done" | "error" | "canceled";

export interface PersistedJob {
    id: string;
    requestId: string;
    category: Category;
    trackId: number;
    path: string;
    /** JSON-serialised AnalyzeOptions (narrowed to the relevant flag). */
    options: string;
    state: JobState;
    progress: number;
    stage: string;
    message: string;
    error: string | null;
    /** Stem model (for stems jobs) or null. */
    stemsModel: string | null;
    enqueuedAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    /** JSON-serialised AnalyzeResult. */
    data: string | null;
}

export class AnalyzerStore {
    private db: SqliteDatabase;
    private stmts!: {
        insert: ReturnType<SqliteDatabase["prepare"]>;
        updateState: ReturnType<SqliteDatabase["prepare"]>;
        updateProgress: ReturnType<SqliteDatabase["prepare"]>;
        finish: ReturnType<SqliteDatabase["prepare"]>;
        deleteOne: ReturnType<SqliteDatabase["prepare"]>;
        clearQueueByCat: ReturnType<SqliteDatabase["prepare"]>;
        clearQueueAll: ReturnType<SqliteDatabase["prepare"]>;
        clearCompletedByFilter: ReturnType<SqliteDatabase["prepare"]>;
        listQueued: ReturnType<SqliteDatabase["prepare"]>;
        listCompleted: ReturnType<SqliteDatabase["prepare"]>;
        rehydrate: ReturnType<SqliteDatabase["prepare"]>;
        countByStateCategory: ReturnType<SqliteDatabase["prepare"]>;
        countFinishedSince: ReturnType<SqliteDatabase["prepare"]>;
    };

    constructor(db?: SqliteDatabase) {
        this.db = db ?? getLibrarySqlite();
        this.bootstrap();
        this.prepare();
    }

    private bootstrap() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS analyzer_jobs (
                id            TEXT PRIMARY KEY,
                request_id    TEXT NOT NULL,
                category      TEXT NOT NULL CHECK(category IN ('dsp','stems','fingerprint')),
                track_id      INTEGER NOT NULL,
                path          TEXT NOT NULL,
                options       TEXT NOT NULL,
                state         TEXT NOT NULL CHECK(state IN ('queued','running','done','error','canceled')),
                progress      REAL NOT NULL DEFAULT 0,
                stage         TEXT NOT NULL DEFAULT 'queued',
                message       TEXT NOT NULL DEFAULT '',
                error         TEXT,
                stems_model   TEXT,
                enqueued_at   INTEGER NOT NULL,
                started_at    INTEGER,
                finished_at   INTEGER,
                data          TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_analyzer_state_cat
                ON analyzer_jobs(state, category, enqueued_at);
            CREATE INDEX IF NOT EXISTS idx_analyzer_request
                ON analyzer_jobs(request_id);
            CREATE INDEX IF NOT EXISTS idx_analyzer_track
                ON analyzer_jobs(track_id, category);
        `);
    }

    private prepare() {
        this.stmts = {
            insert: this.db.prepare(`
                INSERT INTO analyzer_jobs (
                    id, request_id, category, track_id, path, options,
                    state, progress, stage, message, error, stems_model,
                    enqueued_at, started_at, finished_at, data
                ) VALUES (
                    @id, @requestId, @category, @trackId, @path, @options,
                    @state, @progress, @stage, @message, @error, @stemsModel,
                    @enqueuedAt, @startedAt, @finishedAt, @data
                )
            `),
            updateState: this.db.prepare(`
                UPDATE analyzer_jobs
                SET state = @state, started_at = COALESCE(@startedAt, started_at)
                WHERE id = @id
            `),
            updateProgress: this.db.prepare(`
                UPDATE analyzer_jobs
                SET progress = @progress, stage = @stage, message = @message
                WHERE id = @id
            `),
            finish: this.db.prepare(`
                UPDATE analyzer_jobs
                SET state = @state, progress = @progress, stage = @stage,
                    message = @message, error = @error,
                    finished_at = @finishedAt, data = @data
                WHERE id = @id
            `),
            deleteOne: this.db.prepare(`DELETE FROM analyzer_jobs WHERE id = ?`),
            clearQueueByCat: this.db.prepare(
                `DELETE FROM analyzer_jobs WHERE state = 'queued' AND category = ?`,
            ),
            clearQueueAll: this.db.prepare(
                `DELETE FROM analyzer_jobs WHERE state = 'queued'`,
            ),
            clearCompletedByFilter: this.db.prepare(`
                DELETE FROM analyzer_jobs
                WHERE state IN ('done','error','canceled')
                  AND CASE @filter
                          WHEN 'all'     THEN 1
                          WHEN 'errored' THEN (state = 'error' OR state = 'canceled')
                          WHEN 'done'    THEN state = 'done'
                          ELSE 0
                      END
            `),
            listQueued: this.db.prepare(`
                SELECT id, request_id AS requestId, category, track_id AS trackId,
                       path, options, state, progress, stage, message, error,
                       stems_model AS stemsModel,
                       enqueued_at AS enqueuedAt, started_at AS startedAt,
                       finished_at AS finishedAt, data
                FROM analyzer_jobs
                WHERE state IN ('queued','running')
                  AND category = ?
                ORDER BY enqueued_at ASC, id ASC
            `),
            listCompleted: this.db.prepare(`
                SELECT id, request_id AS requestId, category, track_id AS trackId,
                       path, options, state, progress, stage, message, error,
                       stems_model AS stemsModel,
                       enqueued_at AS enqueuedAt, started_at AS startedAt,
                       finished_at AS finishedAt, data
                FROM analyzer_jobs
                WHERE state IN ('done','error','canceled')
                ORDER BY finished_at DESC, id DESC
                LIMIT ?
            `),
            rehydrate: this.db.prepare(`
                SELECT id, request_id AS requestId, category, track_id AS trackId,
                       path, options, state, progress, stage, message, error,
                       stems_model AS stemsModel,
                       enqueued_at AS enqueuedAt, started_at AS startedAt,
                       finished_at AS finishedAt, data
                FROM analyzer_jobs
                WHERE state IN ('queued','running')
                ORDER BY enqueued_at ASC, id ASC
            `),
            countByStateCategory: this.db.prepare(`
                SELECT category, state, COUNT(*) AS n
                FROM analyzer_jobs
                GROUP BY category, state
            `),
            // Authoritative count of jobs that finished AT-OR-AFTER
            // a given timestamp. Used by the UI's batch-progress
            // counter so it doesn't get capped by the in-memory
            // ring buffer (which only holds the last 128 entries).
            countFinishedSince: this.db.prepare(`
                SELECT
                    SUM(CASE WHEN state = 'done'  THEN 1 ELSE 0 END) AS done,
                    SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS errored,
                    COUNT(*) AS total
                FROM analyzer_jobs
                WHERE state IN ('done','error')
                  AND finished_at IS NOT NULL
                  AND finished_at >= ?
            `),
        };
    }

    insert(job: PersistedJob): void {
        this.stmts.insert.run(job as unknown as Record<string, unknown>);
    }

    /** Move a job from queued → running and stamp startedAt. */
    markRunning(id: string, startedAt: number): void {
        this.stmts.updateState.run({ id, state: "running", startedAt });
    }

    /** Cheap progress write; called many times per second so we keep it
     *  to a single UPDATE without any read. */
    updateProgress(id: string, progress: number, stage: string, message: string): void {
        this.stmts.updateProgress.run({ id, progress, stage, message });
    }

    finish(
        id: string,
        state: Extract<JobState, "done" | "error" | "canceled">,
        opts: {
            progress?: number;
            stage?: string;
            message?: string;
            error?: string | null;
            data?: unknown;
            finishedAt?: number;
        } = {},
    ): void {
        this.stmts.finish.run({
            id,
            state,
            progress: opts.progress ?? (state === "done" ? 1 : 0),
            stage: opts.stage ?? state,
            message: opts.message ?? "",
            error: opts.error ?? null,
            finishedAt: opts.finishedAt ?? Date.now(),
            data: opts.data ? JSON.stringify(opts.data) : null,
        });
    }

    deleteOne(id: string): void {
        this.stmts.deleteOne.run(id);
    }

    /** Clear queued (NOT running) for one category, or all categories. */
    clearQueue(category?: Category): number {
        const r = category
            ? this.stmts.clearQueueByCat.run(category)
            : (this.stmts.clearQueueAll as unknown as { run(): { changes: number } }).run();
        return r.changes;
    }

    clearCompleted(filter: "all" | "errored" | "done" = "all"): number {
        const r = this.stmts.clearCompletedByFilter.run({ filter });
        return r.changes;
    }

    /** Queued + running, ordered FIFO. Used by Worker.pump. */
    listQueued(category: Category): PersistedJob[] {
        return this.stmts.listQueued.all(category) as PersistedJob[];
    }

    listCompleted(limit = 64): PersistedJob[] {
        return this.stmts.listCompleted.all(limit) as PersistedJob[];
    }

    /** Cross-category rehydration on startup. */
    rehydrate(): PersistedJob[] {
        return (this.stmts.rehydrate as unknown as { all(): unknown[] }).all() as PersistedJob[];
    }

    /** Aggregate counts for the dashboard. */
    counts(): Array<{ category: Category; state: JobState; n: number }> {
        return (this.stmts.countByStateCategory as unknown as { all(): unknown[] }).all() as Array<{
            category: Category;
            state: JobState;
            n: number;
        }>;
    }

    /** How many jobs finished (done or error) at-or-after `sinceMs`.
     *  Drives the batch-progress UI — the in-memory ring buffer maxes
     *  out at 128 so we can't count from there during a 17 000-job
     *  batch where fingerprint sub-jobs finish in 32 ms each. */
    countFinishedSince(sinceMs: number): { done: number; errored: number; total: number } {
        const row = this.stmts.countFinishedSince.get(sinceMs) as
            { done: number | null; errored: number | null; total: number | null } | undefined;
        return {
            done: row?.done ?? 0,
            errored: row?.errored ?? 0,
            total: row?.total ?? 0,
        };
    }
}

let _store: AnalyzerStore | null = null;
export function getAnalyzerStore(): AnalyzerStore {
    if (!_store) _store = new AnalyzerStore();
    return _store;
}
