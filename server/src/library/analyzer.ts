/**
 * Audio analysis orchestrator (companion side) — multi-worker edition.
 *
 * v2 architecture (companion 0.9+):
 * - Three independent worker lanes — one per category — each with its
 *   own python sidecar, FIFO queue, pause flag, and stall watchdog:
 *
 *       ┌───────────┐  ┌───────────┐  ┌────────────────┐
 *       │  DSP      │  │  Stems    │  │  Fingerprint   │
 *       │  ~30 s/tr │  │  ~5 m/tr  │  │  ~3 s/tr       │
 *       │  CPU+RAM  │  │  GPU+VRAM │  │  CPU (chroma)  │
 *       └───────────┘  └───────────┘  └────────────────┘
 *
 *   The categories use disjoint resources so they can run truly
 *   concurrently. For an 8 607-track library the DSP queue and the
 *   fingerprint queue both finish in ~7-72 hours while the stems
 *   queue is still going (which is hard-capped by GPU throughput).
 *
 * - SQLite-backed persistence (analyzer_jobs table). Every enqueue,
 *   state transition, and completion writes through to disk so a
 *   companion crash, OS restart, or power loss resumes exactly
 *   where it left off.
 *
 * - Per-category pause / resume. Pausing stops pulling new work but
 *   the currently-running sub-job continues to completion (killing
 *   it would just waste partial work).
 *
 * - Public API is backwards-compatible:
 *     analyzer.enqueue(trackId, path, {dsp, stems, fingerprint})
 *   now SPLITS the request into 1-3 sub-jobs sharing a `requestId`
 *   and routes each to its lane. The returned AnalyzeJob is the
 *   first sub-job (so existing code that polls .id keeps working).
 *
 * Failure modes:
 *   • Python missing → `health()` returns `{ ok: false, reason }`,
 *     and `enqueue()` rejects with a clean error.
 *   • Sidecar crashes → only that lane's current job dies; other
 *     lanes keep working. Next enqueue spawns a fresh sidecar for
 *     that lane.
 *   • Stall watchdog (3 min default) is per-lane.
 */

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, createReadStream, writeFileSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
    AnalyzerStore, getAnalyzerStore,
    type Category, CATEGORIES,
    type JobState, type PersistedJob,
} from "./analyzer-store";
import { getLibraryDb, getLibrarySqlite } from "./db";
import { tracks } from "./schema";
import { fetchAllMetadata } from "./metadata-services";

export type { Category };

// ─── Types ───────────────────────────────────────────────────────────

export interface AnalyzeOptions {
    dsp?: boolean;
    fingerprint?: boolean;
    stems?: boolean;
    /** Override the default stems model (`htdemucs_ft`). */
    stemsModel?: string;
    /** Web-metadata lane: fetch genre/album/year/label/ISRC/artwork/lyrics/
     *  BPM from MusicBrainz/iTunes/Deezer/CoverArtArchive/LRCLIB (in-process,
     *  no python). */
    metadata?: boolean;
    /** Sub-flags for the metadata lane (default: all true when metadata set). */
    metaFields?: { tags?: boolean; artwork?: boolean; lyrics?: boolean; bpm?: boolean };
}

export interface AnalyzeJob {
    id: string;
    /** Groups sub-jobs from the same enqueue() call (track + multi-cat options). */
    requestId: string;
    /** Which lane owns this sub-job. */
    category: Category;
    trackId: number;
    path: string;
    options: AnalyzeOptions;
    enqueuedAt: number;
    startedAt?: number;
    finishedAt?: number;
    progress: number;
    /** "queued" | "dsp" | "fp" | "stems" | "done" | "error" | "canceled" */
    stage: string;
    message: string;
    state: JobState;
    data?: AnalyzeResult;
    error?: string;
}

export interface AnalyzeResult {
    bpm?: number;
    bpmConfidence?: number;
    keyMusical?: string;
    keyConfidence?: number;
    keyCamelot?: string;
    energy?: number;
    loudnessLufs?: number;
    loudnessTruePeakDbfs?: number;
    loudnessRangeLu?: number;
    beats?: number[];
    downbeats?: number[];
    chordProgression?: Array<{ start: number; end: number; chord: string }>;
    acoustidFingerprint?: string;
    fingerprintDurationSec?: number;
    stems?: { vocals?: string; drums?: string; bass?: string; other?: string; instrumental?: string };
    stemsModel?: string;
    /** Hex-encoded Int16 interleaved [min0,max0,min1,max1,…] overview
     *  peaks. Persisted to a sidecar `.peaks` file, NOT a SQLite column.
     *  Resolution: 2000 pairs per track (≈ 2px each at 4K width). */
    waveformPeaksHex?: string;
    waveformPeaksCount?: number;
    // ── Web-metadata lane fields ────────────────────────────────────
    genre?: string;
    album?: string;
    year?: number;
    label?: string;
    isrc?: string;
    artworkUrl?: string;
    lyrics?: string;
    syncedLyrics?: string;
    musicbrainzId?: string;
    releaseMbid?: string;
    /** Set when the metadata lane ran (even if it found nothing) so the
     *  per-category completion stamp lands. */
    metadataChecked?: boolean;
    [k: `_${string}_error`]: string | undefined;
}

export interface GpuInfo {
    hasNvidia: boolean;
    gpuName: string | null;
    cudaRuntime: string | null;
    onnxPackage: string | null;
    onnxProviders: string[];
    onnxGpuActive: boolean;
    torchCuda: boolean;
    recommendation: "ready" | "install_onnx_gpu" | "install_cuda_runtime" | "no_gpu";
}

export interface HealthReport {
    ok: boolean;
    pythonPath?: string;
    pythonVersion?: string;
    pythonExecutable?: string;
    available?: Record<string, boolean>;
    gpu?: GpuInfo;
    reason?: string;
}

export interface AnalyzerLogEntry {
    seq: number;
    ts: number;
    level: "info" | "warn" | "error" | "debug";
    message: string;
    jobId?: string;
}

/** Snapshot for a single lane. */
export interface LaneStatus {
    category: Category;
    paused: boolean;
    current: AnalyzeJob | null;
    queue: Array<Pick<AnalyzeJob, "id" | "trackId" | "enqueuedAt" | "stage">>;
    /** queue.length, exposed separately so paginated UIs don't have to count. */
    queueDepth: number;
}

// ─── IO helpers ─────────────────────────────────────────────────────

function resolvePython(): string {
    // Highest priority: explicit override. Then the managed venv (provisioned
    // by python-env.ts — guaranteed 3.12 with all wheels). Fall back to system
    // python only when the venv hasn't been created yet.
    if (process.env.MMO_PYTHON) return process.env.MMO_PYTHON;
    try {
        // Lazy require to avoid a cycle at module load.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { venvPython, venvReady } = require("./python-env") as typeof import("./python-env");
        if (venvReady()) return venvPython();
    } catch { /* python-env unavailable (non-electron context) */ }
    return process.platform === "win32" ? "python" : "python3";
}

function resolveScript(): string {
    const candidates = [
        path.join(process.resourcesPath ?? "", "python", "analyze.py"),
        path.join(__dirname, "..", "..", "python", "analyze.py"),
        path.join(process.cwd(), "python", "analyze.py"),
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
    return candidates[candidates.length - 1];
}

function persistedToJob(p: PersistedJob): AnalyzeJob {
    return {
        id: p.id,
        requestId: p.requestId,
        category: p.category,
        trackId: p.trackId,
        path: p.path,
        options: JSON.parse(p.options) as AnalyzeOptions,
        enqueuedAt: p.enqueuedAt,
        startedAt: p.startedAt ?? undefined,
        finishedAt: p.finishedAt ?? undefined,
        progress: p.progress,
        stage: p.stage,
        message: p.message,
        state: p.state,
        data: p.data ? (JSON.parse(p.data) as AnalyzeResult) : undefined,
        error: p.error ?? undefined,
    };
}

// ─── Worker (one per category) ──────────────────────────────────────

/**
 * Owns a single python sidecar dedicated to one category. Lifecycle:
 *
 *   pump() → if idle and not paused, dequeue next job
 *           → ensureProcess() (lazy spawn)
 *           → write {kind:"analyze", options:{<category>:true}}
 *           → handleLine() consumes progress/result events
 *           → on result: persist, emit, pump() again
 *
 * The python sidecar already supports per-category options
 * (`{dsp:true}` runs only DSP, `{stems:true}` runs only stems, etc),
 * so each lane sets exactly one flag. The sidecar caches the heavy
 * model (e.g. htdemucs_ft) across jobs in the same process, so
 * lane-pinning is also a hot-cache win.
 */
class Worker extends EventEmitter {
    readonly category: Category;
    private proc: ChildProcessWithoutNullStreams | null = null;
    private spawning = false;
    private buffer = "";
    private readyPromise: Promise<void> | null = null;
    private readyResolve: (() => void) | null = null;
    private current: AnalyzeJob | null = null;
    private queueMem: AnalyzeJob[] = [];
    paused = false;
    private killReason: string | null = null;
    private lastProgressAt = 0;
    private stallTimer: NodeJS.Timeout | null = null;

    constructor(
        category: Category,
        private store: AnalyzerStore,
        private parent: Analyzer,
    ) {
        super();
        this.category = category;
    }

    // Hot-load existing queued/running jobs from sqlite. Running jobs
    // get demoted back to queued so they re-execute (we don't know if
    // they completed before the crash).
    rehydrate(jobs: AnalyzeJob[]) {
        for (const j of jobs) {
            if (j.state === "running") {
                // Demote: a job marked "running" in sqlite means we
                // crashed mid-job. Reset state, wipe progress, and
                // re-insert as queued so it runs from scratch.
                this.store.deleteOne(j.id);
                j.state = "queued";
                j.startedAt = undefined;
                j.progress = 0;
                j.stage = "queued";
                j.message = "Re-queued after restart";
                this.store.insert({
                    id: j.id, requestId: j.requestId, category: j.category,
                    trackId: j.trackId, path: j.path,
                    options: JSON.stringify(j.options),
                    state: "queued", progress: 0, stage: "queued",
                    message: "Re-queued after restart", error: null,
                    stemsModel: j.options.stemsModel ?? null,
                    enqueuedAt: j.enqueuedAt,
                    startedAt: null, finishedAt: null, data: null,
                });
            }
            this.queueMem.push(j);
        }
        if (this.queueMem.length > 0) {
            this.parent.pushLog("info",
                `[${this.category}] Rehydrated ${this.queueMem.length} job(s) from disk`);
        }
    }

    queueDepth(): number { return this.queueMem.length; }
    currentJob(): AnalyzeJob | null { return this.current; }

    queueSnapshot() {
        return this.queueMem.slice(0, 200).map((j) => ({
            id: j.id, trackId: j.trackId, enqueuedAt: j.enqueuedAt, stage: j.stage,
        }));
    }

    enqueue(job: AnalyzeJob) {
        this.queueMem.push(job);
        Promise.resolve().then(() => this.pump());
    }

    pause() {
        if (this.paused) return;
        this.paused = true;
        this.parent.pushLog("warn",
            `[${this.category}] Lane paused (queue ${this.queueMem.length} job${this.queueMem.length === 1 ? "" : "s"} held)`);
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this.parent.pushLog("info",
            `[${this.category}] Lane resumed (${this.queueMem.length} queued)`);
        Promise.resolve().then(() => this.pump());
    }

    cancel(id: string): boolean {
        const idx = this.queueMem.findIndex((j) => j.id === id);
        if (idx >= 0) {
            const removed = this.queueMem[idx];
            this.queueMem.splice(idx, 1);
            this.store.finish(id, "canceled", {
                stage: "canceled", message: "Cancelled by user",
                error: "user cancel",
            });
            this.parent.pushLog("info",
                `[${this.category}] Removed queued track ${removed.trackId}`, id);
            return true;
        }
        if (this.current?.id === id && this.proc) {
            this.killReason = `user cancel (track ${this.current.trackId})`;
            this.parent.pushLog("warn",
                `[${this.category}] Cancelled in-flight track ${this.current.trackId}`, id);
            try { this.proc.kill(); } catch { /* ignore */ }
            return true;
        }
        return false;
    }

    /** Drop everything queued in this lane. */
    clearQueue(): number {
        const n = this.queueMem.length;
        if (n === 0) return 0;
        const ids = this.queueMem.map((j) => j.id);
        for (const id of ids) {
            this.store.finish(id, "canceled", {
                stage: "canceled", message: "Queue cleared",
                error: "queue cleared",
            });
        }
        this.queueMem.length = 0;
        this.parent.pushLog("warn",
            `[${this.category}] Queue cleared (${n} job${n === 1 ? "" : "s"})`);
        return n;
    }

    /** Forcibly kill the lane's sidecar (used by Analyzer.shutdown
     *  and Analyzer.restartSidecar). */
    kill(reason: string) {
        if (this.proc) {
            this.killReason = reason;
            try { this.proc.stdin.write(JSON.stringify({ kind: "shutdown" }) + "\n"); } catch { /* ignore */ }
            try { this.proc.kill(); } catch { /* ignore */ }
        }
        this.proc = null;
    }

    private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
        if (this.proc && !this.proc.killed) return this.proc;
        if (this.spawning && this.readyPromise) {
            await this.readyPromise;
            if (this.proc) return this.proc;
        }
        this.spawning = true;
        const python = resolvePython();
        const script = resolveScript();
        if (!existsSync(script)) {
            this.spawning = false;
            throw new Error(`analyzer script not found: ${script}`);
        }
        this.readyPromise = new Promise((res) => { this.readyResolve = res; });
        this.proc = spawn(python, [script], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
                PYTHONIOENCODING: "utf-8",
                MMO_LANE: this.category,  // python can use this for log tagging
            },
            detached: false,
        });

        this.proc.on("error", (err) => {
            this.parent.pushLog("error",
                `[${this.category}] spawn error: ${err.message}`, this.current?.id);
            this.failCurrent(`spawn failed: ${err.message}`);
            this.proc = null;
            this.spawning = false;
        });

        this.proc.on("exit", (code, sig) => {
            const wasRunning = !!this.current;
            const stage = this.current?.stage;
            const trackId = this.current?.trackId;
            const reason = this.killReason ?? "unknown";
            const detail = wasRunning
                ? `[${this.category}] sidecar exited code=${code} sig=${sig} (track ${trackId} @ ${stage}, reason: ${reason})`
                : `[${this.category}] sidecar exited code=${code} sig=${sig} (idle, reason: ${reason})`;
            this.parent.pushLog(wasRunning ? "error" : "warn", detail, this.current?.id);
            this.failCurrent(`python exited (${code ?? sig}) — ${reason}`);
            this.proc = null;
            this.spawning = false;
            this.killReason = null;
        });

        this.proc.stdout.on("data", (chunk: Buffer) => {
            this.buffer += chunk.toString("utf8");
            let nl: number;
            while ((nl = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, nl).trim();
                this.buffer = this.buffer.slice(nl + 1);
                if (line) this.handleLine(line);
            }
        });

        this.proc.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();
            if (!text) return;
            for (const line of text.split(/\r?\n/)) {
                if (!line) continue;
                const lower = line.toLowerCase();
                const level: AnalyzerLogEntry["level"] =
                    lower.includes("error") || lower.includes("traceback")
                        ? "error"
                        : lower.includes("warn")
                            ? "warn"
                            : "debug";
                this.parent.pushLog(level, `[${this.category}:py] ${line}`, this.current?.id);
            }
        });

        await this.readyPromise;
        this.spawning = false;
        return this.proc;
    }

    private handleLine(line: string) {
        let msg: { kind?: string; id?: string; pid?: number; pct?: number; stage?: string; msg?: string; ok?: boolean; data?: AnalyzeResult; error?: string };
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.kind === "ready") {
            this.readyResolve?.();
            this.parent.pushLog("info",
                `[${this.category}] Sidecar ready (pid ${msg.pid ?? "?"})`);
            return;
        }
        if (msg.kind === "progress") {
            const job = this.current;
            if (!job || job.id !== msg.id) return;
            this.lastProgressAt = Date.now();
            job.progress = typeof msg.pct === "number" ? msg.pct : job.progress;
            job.stage = msg.stage ?? job.stage;
            job.message = msg.msg ?? job.message;
            this.store.updateProgress(job.id, job.progress, job.stage, job.message);
            this.parent.pushLog("info",
                `[${this.category}] ${Math.round((job.progress ?? 0) * 100)}% — ${job.message}`,
                job.id);
            this.parent.emit("progress", job);
            return;
        }
        if (msg.kind === "result") {
            const job = this.current;
            if (!job || job.id !== msg.id) return;
            job.finishedAt = Date.now();
            if (msg.ok) {
                job.data = msg.data;
                job.stage = "done";
                job.progress = 1;
                job.message = "Complete";
                job.state = "done";
                this.store.finish(job.id, "done", {
                    progress: 1, stage: "done", message: "Complete",
                    data: job.data, finishedAt: job.finishedAt,
                });
                const elapsed = job.startedAt ? ((job.finishedAt - job.startedAt) / 1000).toFixed(1) : "?";
                this.parent.pushLog("info",
                    `[${this.category}] Track ${job.trackId} done in ${elapsed}s`, job.id);
                this.parent.recordCompleted(job);
                this.parent.emit("complete", job);
            } else {
                job.error = msg.error ?? "unknown error";
                job.stage = "error";
                job.state = "error";
                job.message = job.error || "error";
                this.store.finish(job.id, "error", {
                    progress: job.progress, stage: "error",
                    message: job.message, error: job.error,
                    finishedAt: job.finishedAt,
                });
                this.parent.pushLog("error",
                    `[${this.category}] Track ${job.trackId} failed: ${job.error}`, job.id);
                this.parent.recordCompleted(job);
                this.parent.emit("error", job);
            }
            this.current = null;
            this.stopStallWatchdog();
            this.pump();
            return;
        }
    }

    private failCurrent(reason: string) {
        const job = this.current;
        if (!job) return;
        job.error = reason;
        job.stage = "error";
        job.state = "error";
        job.finishedAt = Date.now();
        job.message = reason;
        this.store.finish(job.id, "error", {
            progress: job.progress, stage: "error", message: reason,
            error: reason, finishedAt: job.finishedAt,
        });
        this.parent.pushLog("error",
            `[${this.category}] Track ${job.trackId} aborted: ${reason}`, job.id);
        this.parent.recordCompleted(job);
        this.parent.emit("error", job);
        this.current = null;
        this.stopStallWatchdog();
    }

    private pump() {
        if (this.current) return;
        if (this.paused) return;
        const next = this.queueMem.shift();
        if (!next) return;
        this.current = next;
        next.startedAt = Date.now();
        next.state = "running";
        next.stage = this.category === "fingerprint" ? "fp" : this.category;
        next.message = "Starting…";
        this.store.markRunning(next.id, next.startedAt);
        this.lastProgressAt = Date.now();
        this.startStallWatchdog();
        this.parent.pushLog("info",
            `[${this.category}] Starting track ${next.trackId} — ${path.basename(next.path)}`,
            next.id);
        this.parent.emit("progress", next);
        // ── In-process metadata lane (no python sidecar) ────────────
        if (this.category === "metadata") {
            this.runMetadataJob(next)
                .catch((e) => this.failCurrent(`metadata failed: ${e instanceof Error ? e.message : String(e)}`));
            return;
        }
        const cmd = {
            id: next.id,
            kind: "analyze",
            path: next.path,
            trackId: next.trackId,
            outDir: this.parent.stemsDirFor(next.trackId),
            options: next.options,
        };
        this.ensureProcess()
            .then((proc) => proc.stdin.write(JSON.stringify(cmd) + "\n"))
            .catch((e) => this.failCurrent(`enqueue failed: ${e instanceof Error ? e.message : String(e)}`));
    }

    /**
     * Metadata lane runner — fetches genre/album/year/label/ISRC/artwork/
     * lyrics/BPM from the free web services (MusicBrainz/iTunes/Deezer/
     * CoverArtArchive/LRCLIB) and finishes the job in-process. Mirrors the
     * python lanes' progress/result lifecycle so all the store, persistence
     * and status plumbing is reused unchanged. Only fills EMPTY fields
     * (never overwrites existing tags); always stamps completion so the
     * track is marked analyzed even when nothing was found.
     */
    private async runMetadataJob(job: AnalyzeJob): Promise<void> {
        const emit = (pct: number, message: string) => {
            if (this.current?.id !== job.id) return;
            job.progress = pct;
            job.stage = "metadata";
            job.message = message;
            this.lastProgressAt = Date.now();
            this.store.updateProgress(job.id, pct, "metadata", message);
            this.parent.emit("progress", job);
        };
        emit(0.05, "Reading track…");

        // Look up the track row for artist/title/album + which fields are empty.
        const db = getLibraryDb();
        const [row] = await db.select().from(tracks).where(eq(tracks.id, job.trackId)).limit(1);
        if (!row) { this.failCurrent("track not found"); return; }

        const mf = job.options.metaFields ?? { tags: true, artwork: true, lyrics: true, bpm: true };
        emit(0.15, "Querying MusicBrainz, iTunes, Deezer, LRCLIB…");

        let meta: Awaited<ReturnType<typeof fetchAllMetadata>>;
        try {
            meta = await fetchAllMetadata(
                row.artist ?? "", row.title ?? row.filename ?? "", row.album ?? null,
                row.duration ?? null,
                { metadata: !!mf.tags, artwork: !!mf.artwork, lyrics: !!mf.lyrics, bpmKey: !!mf.bpm },
            );
        } catch (e) {
            this.failCurrent(`lookup failed: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }

        emit(0.85, "Saving…");
        // Only fill EMPTY fields. Build an AnalyzeResult so persistResult writes it.
        const data: AnalyzeResult = { metadataChecked: true };
        const empty = (v: unknown) => v == null || v === "";
        if (mf.tags) {
            if (empty(row.genre) && meta.genre) data.genre = meta.genre;
            if (empty(row.album) && meta.album) data.album = meta.album;
            if (empty(row.year) && meta.year) data.year = meta.year;
            if (empty(row.label) && meta.label) data.label = meta.label;
            if (empty(row.isrc) && meta.isrc) data.isrc = meta.isrc;
            if (empty(row.musicbrainzId) && meta.musicbrainzId) data.musicbrainzId = meta.musicbrainzId;
            if (empty(row.releaseMbid) && meta.releaseMbid) data.releaseMbid = meta.releaseMbid;
        }
        if (mf.artwork && empty(row.artworkUrl) && meta.artworkUrl) data.artworkUrl = meta.artworkUrl;
        if (mf.lyrics) {
            if (empty(row.lyrics) && meta.lyrics) data.lyrics = meta.lyrics;
            if (empty(row.syncedLyrics) && meta.syncedLyrics) data.syncedLyrics = meta.syncedLyrics;
        }
        if (mf.bpm && empty(row.bpm) && meta.bpm) data.bpm = meta.bpm;

        job.finishedAt = Date.now();
        job.data = data;
        job.stage = "done";
        job.progress = 1;
        job.message = "Complete";
        job.state = "done";
        this.store.finish(job.id, "done", {
            progress: 1, stage: "done", message: "Complete",
            data, finishedAt: job.finishedAt,
        });
        const elapsed = job.startedAt ? ((job.finishedAt - job.startedAt) / 1000).toFixed(1) : "?";
        this.parent.pushLog("info", `[metadata] Track ${job.trackId} done in ${elapsed}s`, job.id);
        this.parent.recordCompleted(job);
        this.parent.emit("complete", job);
        this.current = null;
        this.stopStallWatchdog();
        this.pump();
    }

    private startStallWatchdog() {
        this.stopStallWatchdog();
        this.stallTimer = setInterval(() => {
            const job = this.current;
            if (!job) { this.stopStallWatchdog(); return; }
            const idleMs = Date.now() - this.lastProgressAt;
            if (idleMs < Analyzer.STALL_THRESHOLD_MS) return;
            const reason = `stalled ${Math.round(idleMs / 1000)}s without progress (last stage: ${job.stage})`;
            this.killReason = `watchdog: ${reason}`;
            this.parent.pushLog("error",
                `[${this.category}] Watchdog killing sidecar — track ${job.trackId} ${reason}`,
                job.id);
            try { this.proc?.kill(); } catch { /* ignore */ }
        }, Analyzer.STALL_CHECK_MS);
    }

    private stopStallWatchdog() {
        if (this.stallTimer) {
            clearInterval(this.stallTimer);
            this.stallTimer = null;
        }
    }
}

// ─── Analyzer (orchestrates all lanes) ──────────────────────────────

class Analyzer extends EventEmitter {
    static readonly STALL_THRESHOLD_MS = 3 * 60_000;
    static readonly STALL_CHECK_MS = 15_000;
    private static readonly LOG_BUFFER_MAX = 1000;
    private static readonly COMPLETED_RING_MAX = 128;

    private store: AnalyzerStore;
    private workers!: Record<Category, Worker>;
    /** Cross-lane recently-completed ring buffer. Persisted in sqlite,
     *  this is just the in-memory hot copy for the status endpoint. */
    private completed: AnalyzeJob[] = [];

    /** Dedicated process for one-shot `sendCommand` calls (plugin
     *  scan / describe / render). Separate from the analyze lanes so
     *  these don't queue behind a 5-minute stems job. */
    private controlProc: ChildProcessWithoutNullStreams | null = null;
    private controlSpawning = false;
    private controlReadyPromise: Promise<void> | null = null;
    private controlReadyResolve: (() => void) | null = null;
    private controlBuffer = "";

    private healthCache: HealthReport | null = null;
    private logs: AnalyzerLogEntry[] = [];
    private logSeq = 0;
    private rehydrated = false;

    constructor() {
        super();
        this.store = getAnalyzerStore();
        this.workers = {
            dsp: new Worker("dsp", this.store, this),
            stems: new Worker("stems", this.store, this),
            fingerprint: new Worker("fingerprint", this.store, this),
            metadata: new Worker("metadata", this.store, this),
        };
        // CRITICAL: wire library-DB persistence BEFORE the rehydrate
        // microtask fires. Otherwise jobs that complete on a fresh
        // restart could miss the listener and we'd lose the per-track
        // bpm/key/stems write — exactly the bug that forced users to
        // re-analyze the whole library after closing the companion.
        this.wirePersistence();
        // Defer rehydrate until first call — keeps construction sync
        // and lets the routes file import the singleton at module load.
        Promise.resolve().then(() => this.ensureRehydrated());
    }

    /** Wire analyzer events → tracks-table writes. Idempotent: a
     *  flag on `this` prevents double-attach if HMR re-evaluates the
     *  module. Each successful job commits its result inline (same
     *  tick as `emit("complete")`) so progress is durable even if
     *  the user closes the companion mid-batch. */
    private wirePersistence() {
        if ((this as unknown as { _persistWired?: boolean })._persistWired) return;
        (this as unknown as { _persistWired: boolean })._persistWired = true;

        // Mark stems "processing" the moment the python sidecar starts
        // working on the stems stage — distinct UI state from "queued".
        this.on("progress", (job: AnalyzeJob) => {
            if (!job.options.stems) return;
            if (job.stage !== "stems") return;
            if (job.progress > 0.05) return;
            try {
                getLibraryDb().update(tracks)
                    .set({ stemsStatus: "processing" })
                    .where(eq(tracks.id, job.trackId)).run();
            } catch (e) {
                console.error("[analyzer.persist] processing-mark failed:", e);
            }
        });

        this.on("complete", (job: AnalyzeJob) => {
            try {
                this.persistResult(job);
            } catch (e) {
                console.error("[analyzer.persist] complete write failed:",
                    `track=${job.trackId} category=${job.category}`, e);
                this.pushLog("error",
                    `Persist failed for track ${job.trackId} (${job.category}): ${e instanceof Error ? e.message : String(e)}`,
                    job.id);
            }
        });

        this.on("error", (job: AnalyzeJob) => {
            try {
                if (job.options.stems) {
                    getLibraryDb().update(tracks).set({
                        stemsStatus: "error",
                        stemsError: job.error ?? "unknown error",
                    }).where(eq(tracks.id, job.trackId)).run();
                }
            } catch (e) {
                console.error("[analyzer.persist] error-mark failed:", e);
            }
        });
    }

    /** Fold one completed job's AnalyzeResult into the tracks row.
     *  Uses per-category gating so a fingerprint-only run never sets
     *  `dspAnalyzedAt` (which would falsely make the bulk skip-filter
     *  think DSP was done). */
    private persistResult(job: AnalyzeJob) {
        const data = job.data;
        if (!data) return;
        const db = getLibraryDb();
        const update: Partial<typeof tracks.$inferInsert> = {};
        let dspTouched = false;
        let stemsTouched = false;
        let fpTouched = false;

        // ── DSP fields ──────────────────────────────────────────────
        if (typeof data.bpm === "number") { update.bpm = data.bpm; dspTouched = true; }
        if (typeof data.bpmConfidence === "number") { update.bpmConfidence = data.bpmConfidence; dspTouched = true; }
        if (data.keyMusical) { update.keyMusical = data.keyMusical; dspTouched = true; }
        if (typeof data.keyConfidence === "number") { update.keyConfidence = data.keyConfidence; dspTouched = true; }
        if (data.keyCamelot) { update.keyCamelot = data.keyCamelot; dspTouched = true; }
        if (typeof data.energy === "number") { update.energy = data.energy; dspTouched = true; }
        if (typeof data.loudnessLufs === "number") { update.loudnessLufs = data.loudnessLufs; dspTouched = true; }
        if (typeof data.loudnessTruePeakDbfs === "number") { update.loudnessTruePeakDbfs = data.loudnessTruePeakDbfs; dspTouched = true; }
        if (typeof data.loudnessRangeLu === "number") { update.loudnessRangeLu = data.loudnessRangeLu; dspTouched = true; }
        if (Array.isArray(data.beats)) { update.beats = JSON.stringify(data.beats); dspTouched = true; }
        if (Array.isArray(data.downbeats)) { update.downbeats = JSON.stringify(data.downbeats); dspTouched = true; }
        if (Array.isArray(data.chordProgression)) { update.chordProgression = JSON.stringify(data.chordProgression); dspTouched = true; }

        // ── Waveform overview peaks (sidecar file, not a DB column) ─
        if (data.waveformPeaksHex && typeof data.waveformPeaksCount === "number") {
            try {
                const buf = Buffer.from(data.waveformPeaksHex, "hex");
                writeFileSync(this.waveformPeaksPath(job.trackId), buf);
                dspTouched = true;
            } catch (e) {
                console.error("[analyzer.persist] waveform write failed:", e);
            }
        }

        // ── Fingerprint fields ──────────────────────────────────────
        if (data.acoustidFingerprint) {
            update.acoustidFingerprint = data.acoustidFingerprint;
            fpTouched = true;
        }

        // ── Stems fields ────────────────────────────────────────────
        if (data.stems) {
            update.stemsStatus = "ready";
            update.stemsModel = data.stemsModel ?? null;
            update.stemsAnalyzedAt = new Date().toISOString();
            if (data.stems.vocals) update.stemsVocalsPath = data.stems.vocals;
            if (data.stems.drums) update.stemsDrumsPath = data.stems.drums;
            if (data.stems.bass) update.stemsBassPath = data.stems.bass;
            // "other" → melody (web app's canonical 4th stem name).
            if (data.stems.other) update.stemsMelodyPath = data.stems.other;
            update.stemsError = null;
            stemsTouched = true;
        }

        // ── Web-metadata fields (in-process metadata lane) ──────────
        let metaTouched = false;
        if (data.metadataChecked) {
            if (data.genre) update.genre = data.genre;
            if (data.album) update.album = data.album;
            if (typeof data.year === "number") update.year = data.year;
            if (data.label) update.label = data.label;
            if (data.isrc) update.isrc = data.isrc;
            if (data.artworkUrl) update.artworkUrl = data.artworkUrl;
            if (data.lyrics) update.lyrics = data.lyrics;
            if (data.syncedLyrics) update.syncedLyrics = data.syncedLyrics;
            if (data.musicbrainzId) update.musicbrainzId = data.musicbrainzId;
            if (data.releaseMbid) update.releaseMbid = data.releaseMbid;
            if (typeof data.bpm === "number" && update.bpm == null) update.bpm = data.bpm;
            // Always stamp metadata completion (even with no new fields) so the
            // bulk skip-filter advances and re-runs resume on the rest.
            update.analyzedAt = new Date().toISOString();
            metaTouched = true;
        }

        // Stamp DSP completion ONLY when DSP fields actually landed —
        // otherwise a fingerprint-only or stems-only run would falsely
        // mark DSP as done and the bulk-analyze skip filter would skip
        // real DSP work on the next pass.
        if (dspTouched) update.dspAnalyzedAt = new Date().toISOString();

        if (Object.keys(update).length === 0) {
            // Nothing to write (e.g. python returned an empty result).
            // Don't silently swallow — log so we can investigate.
            this.pushLog("warn",
                `Persist: track ${job.trackId} (${job.category}) returned no fields`,
                job.id);
            return;
        }

        const result = db.update(tracks).set(update)
            .where(eq(tracks.id, job.trackId)).run();
        const changed = (result as unknown as { changes?: number }).changes ?? 0;
        if (changed === 0) {
            this.pushLog("warn",
                `Persist: track ${job.trackId} not found in library DB (orphaned analyzer job?)`,
                job.id);
            return;
        }

        // Force a WAL checkpoint after stems (the heavy, multi-minute
        // job whose loss would hurt most). DSP/FP are quick enough that
        // the next stems write will checkpoint them anyway.
        if (stemsTouched) {
            try { getLibrarySqlite().pragma("wal_checkpoint(PASSIVE)"); }
            catch { /* checkpoints are best-effort */ }
        }

        const parts: string[] = [];
        if (dspTouched) parts.push("dsp");
        if (stemsTouched) parts.push("stems");
        if (fpTouched) parts.push("fp");
        if (metaTouched) parts.push("metadata");
        this.pushLog("info",
            `Persisted track ${job.trackId} → ${parts.join("+")}`, job.id);

        // Lazy sha256 backfill — fires on any analysis pass for tracks
        // that don't have one yet. Cheap (streaming hash, no load into
        // memory) and idempotent. Decoupled from the persistResult
        // success path with `void` so a hashing failure never affects
        // the analyzer pipeline.
        void this.backfillSha256(job.trackId);
    }

    /** One-shot SHA-256 backfill for a track. No-op when sha256 is set
     *  or the file is gone. Errors are logged at debug level — the row
     *  stays valid without sha256 (cloud sync gracefully degrades). */
    private async backfillSha256(trackId: number): Promise<void> {
        try {
            const db = getLibraryDb();
            const row = await db
                .select({ id: tracks.id, filepath: tracks.filepath, sha256: tracks.sha256 })
                .from(tracks)
                .where(eq(tracks.id, trackId))
                .limit(1);
            const r = row[0];
            if (!r || r.sha256 || !r.filepath || !existsSync(r.filepath)) return;

            const sha = await new Promise<string>((resolve, reject) => {
                const hash = createHash("sha256");
                const stream = createReadStream(r.filepath);
                stream.on("data", (chunk) => hash.update(chunk));
                stream.on("end", () => resolve(hash.digest("hex")));
                stream.on("error", reject);
            });
            await db.update(tracks).set({ sha256: sha }).where(eq(tracks.id, r.id)).run();
        } catch (err) {
            this.pushLog("warn", `sha256 backfill failed for track ${trackId}: ${(err as Error).message}`);
        }
    }

    pushLog(level: AnalyzerLogEntry["level"], message: string, jobId?: string) {
        const entry: AnalyzerLogEntry = {
            seq: ++this.logSeq,
            ts: Date.now(),
            level,
            message: message.length > 500 ? message.slice(0, 500) + "…" : message,
            jobId,
        };
        this.logs.push(entry);
        if (this.logs.length > Analyzer.LOG_BUFFER_MAX) {
            this.logs.splice(0, this.logs.length - Analyzer.LOG_BUFFER_MAX);
        }
        this.emit("log", entry);
    }

    getLogs(since = 0, limit = 500): AnalyzerLogEntry[] {
        if (since <= 0) return this.logs.slice(-limit);
        const out: AnalyzerLogEntry[] = [];
        for (const e of this.logs) if (e.seq > since) out.push(e);
        return out.slice(-limit);
    }

    /** Internal: invoked by Worker on completion. Kept on the parent
     *  so the cross-lane ring buffer is single-source. */
    recordCompleted(job: AnalyzeJob) {
        this.completed.push(job);
        if (this.completed.length > Analyzer.COMPLETED_RING_MAX) {
            this.completed.shift();
        }
    }

    private ensureRehydrated() {
        if (this.rehydrated) return;
        this.rehydrated = true;
        const rows = this.store.rehydrate();
        if (rows.length === 0) {
            this.pushLog("info", "Analyzer ready — no pending jobs");
            return;
        }
        const byCat: Record<Category, AnalyzeJob[]> = { dsp: [], stems: [], fingerprint: [], metadata: [] };
        for (const r of rows) byCat[r.category].push(persistedToJob(r));
        for (const cat of CATEGORIES) {
            if (byCat[cat].length > 0) this.workers[cat].rehydrate(byCat[cat]);
        }
        // Also seed the in-memory completed buffer from disk so the
        // first /status request shows recent history.
        const recentDone = this.store.listCompleted(Analyzer.COMPLETED_RING_MAX);
        for (const r of recentDone.reverse()) this.completed.push(persistedToJob(r));
    }

    stemsRoot(): string {
        const base = (() => {
            try { return app.getPath("userData"); } catch { return process.cwd(); }
        })();
        const root = path.join(base, "stems");
        if (!existsSync(root)) mkdirSync(root, { recursive: true });
        return root;
    }

    stemsDirFor(trackId: number): string {
        const dir = path.join(this.stemsRoot(), String(trackId));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Filesystem location of the binary overview-peaks sidecar for a
     *  given track. Format: Int16 LE interleaved min/max pairs. We keep
     *  these out of the SQLite row because at 4 KB per track a 50k-track
     *  library would push the DB past 200 MB and slow every read. */
    waveformPeaksPath(trackId: number): string {
        const base = (() => {
            try { return app.getPath("userData"); } catch { return process.cwd(); }
        })();
        const dir = path.join(base, "waveforms");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        return path.join(dir, `${trackId}.peaks`);
    }

    // ─── Public API ──────────────────────────────────────────────────

    /** Split a multi-category request into per-lane sub-jobs and
     *  enqueue them. Returns the FIRST sub-job (for backwards compat
     *  with code that polls `.id`). To track all sub-jobs use
     *  `.requestId` and `findByRequest()`. */
    enqueue(trackId: number, audioPath: string, options: AnalyzeOptions): AnalyzeJob {
        this.ensureRehydrated();
        const requestId = randomUUID();
        const now = Date.now();
        const subjobs: AnalyzeJob[] = [];

        const make = (category: Category, narrowed: AnalyzeOptions): AnalyzeJob => {
            const j: AnalyzeJob = {
                id: randomUUID(),
                requestId, category,
                trackId, path: audioPath,
                options: narrowed,
                enqueuedAt: now,
                progress: 0,
                stage: "queued",
                state: "queued",
                message: "Queued",
            };
            this.store.insert({
                id: j.id, requestId, category, trackId, path: audioPath,
                options: JSON.stringify(narrowed),
                state: "queued", progress: 0, stage: "queued", message: "Queued",
                error: null, stemsModel: narrowed.stemsModel ?? null,
                enqueuedAt: now, startedAt: null, finishedAt: null, data: null,
            });
            return j;
        };

        if (options.dsp) subjobs.push(make("dsp", { dsp: true }));
        if (options.fingerprint) subjobs.push(make("fingerprint", { fingerprint: true }));
        if (options.stems) subjobs.push(make("stems", { stems: true, stemsModel: options.stemsModel }));
        if (options.metadata) subjobs.push(make("metadata", { metadata: true, metaFields: options.metaFields }));

        if (subjobs.length === 0) {
            // Behave like the old API: enqueue a no-op DSP job that
            // immediately fails rather than silently dropping.
            const j = make("dsp", { dsp: true });
            this.pushLog("warn",
                `Track ${trackId} enqueued with no options — defaulting to DSP`);
            this.workers.dsp.enqueue(j);
            return j;
        }

        const opsLabel = subjobs.map((j) => j.category).join("+");
        this.pushLog("info",
            `Enqueued track ${trackId} (${opsLabel}) — request ${requestId.slice(0, 8)}`);
        for (const j of subjobs) this.workers[j.category].enqueue(j);
        return subjobs[0];
    }

    /** Per-lane snapshot. */
    lanes(): LaneStatus[] {
        return CATEGORIES.map((cat) => {
            const w = this.workers[cat];
            return {
                category: cat,
                paused: w.paused,
                current: w.currentJob(),
                queue: w.queueSnapshot(),
                queueDepth: w.queueDepth(),
            };
        });
    }

    /** Backwards-compatible status: aggregates across lanes so the
     *  existing UI keeps working. The new UI should use `lanes()`.
     *  @param sinceMs  if provided, also returns total finished/errored
     *                  counts at-or-after this timestamp from sqlite —
     *                  the UI uses this for accurate batch progress
     *                  because the in-memory `completed` ring buffer
     *                  caps at 128 and gets evicted during big batches. */
    status(sinceMs?: number) {
        this.ensureRehydrated();
        const lanes = this.lanes();
        // For "current": pick whichever lane has the most-progressed job
        // (so the existing single-card UI shows the most-meaningful one).
        // For "queue" and "completed": flatten across lanes.
        let bestCurrent: AnalyzeJob | null = null;
        for (const l of lanes) {
            if (l.current && (!bestCurrent || l.current.progress > bestCurrent.progress)) {
                bestCurrent = l.current;
            }
        }
        const queue: Array<Pick<AnalyzeJob, "id" | "trackId" | "enqueuedAt" | "stage"> & { category: Category }> = [];
        for (const l of lanes) {
            for (const q of l.queue) queue.push({ ...q, category: l.category });
        }
        // Sort by enqueuedAt for deterministic display.
        queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        const completed = this.completed.slice(-32).map((j) => ({
            id: j.id, trackId: j.trackId,
            stage: j.stage, error: j.error,
            startedAt: j.startedAt, finishedAt: j.finishedAt,
            category: j.category,
        }));
        const finishedSince = sinceMs && sinceMs > 0
            ? this.store.countFinishedSince(sinceMs)
            : undefined;
        return {
            current: bestCurrent,
            queue,
            completed,
            lanes,
            paused: lanes.every((l) => l.paused),
            anyPaused: lanes.some((l) => l.paused),
            finishedSince,
        };
    }

    findJob(id: string): AnalyzeJob | null {
        for (const cat of CATEGORIES) {
            const w = this.workers[cat];
            const cur = w.currentJob();
            if (cur?.id === id) return cur;
            const q = (w as unknown as { queueMem: AnalyzeJob[] }).queueMem
                .find((j) => j.id === id);
            if (q) return q;
        }
        const done = this.completed.find((j) => j.id === id);
        return done ?? null;
    }

    cancel(id: string): boolean {
        for (const cat of CATEGORIES) {
            if (this.workers[cat].cancel(id)) return true;
        }
        return false;
    }

    /** Pause one lane or all lanes. */
    pause(category?: Category | "all"): void {
        if (!category || category === "all") {
            for (const cat of CATEGORIES) this.workers[cat].pause();
            return;
        }
        this.workers[category].pause();
    }

    resume(category?: Category | "all"): void {
        if (!category || category === "all") {
            for (const cat of CATEGORIES) this.workers[cat].resume();
            return;
        }
        this.workers[category].resume();
    }

    /** Drop every queued job in the given lane (or all lanes). */
    clearQueue(category?: Category | "all"): number {
        if (!category || category === "all") {
            let n = 0;
            for (const cat of CATEGORIES) n += this.workers[cat].clearQueue();
            return n;
        }
        return this.workers[category].clearQueue();
    }

    removeCompleted(id: string): boolean {
        const idx = this.completed.findIndex((j) => j.id === id);
        if (idx >= 0) this.completed.splice(idx, 1);
        this.store.deleteOne(id);
        return idx >= 0;
    }

    clearCompleted(filter: "all" | "errored" | "done" = "all"): number {
        const before = this.completed.length;
        this.completed = this.completed.filter((j) =>
            filter === "all" ? false :
                filter === "errored" ? !j.error :
                    !!j.error,
        );
        const persistedRemoved = this.store.clearCompleted(filter);
        return Math.max(before - this.completed.length, persistedRemoved);
    }

    /** Re-enqueue a completed job using its original options + path. */
    retry(id: string): AnalyzeJob | null {
        const original = this.completed.find((j) => j.id === id);
        if (!original) return null;
        if (!existsSync(original.path)) {
            this.pushLog("error",
                `Retry refused — source missing: ${original.path}`, id);
            return null;
        }
        this.pushLog("info",
            `Retry track ${original.trackId} category=${original.category}`, original.id);
        // Re-create as a single-category enqueue so it lands in the
        // same lane that originally produced the result/error.
        const opts: AnalyzeOptions = original.category === "dsp" ? { dsp: true }
            : original.category === "stems" ? { stems: true, stemsModel: original.options.stemsModel }
                : { fingerprint: true };
        return this.enqueue(original.trackId, original.path, opts);
    }

    shutdown() {
        for (const cat of CATEGORIES) this.workers[cat].kill("shutdown");
        if (this.controlProc) {
            try { this.controlProc.stdin.write(JSON.stringify({ kind: "shutdown" }) + "\n"); } catch { /* ignore */ }
            try { this.controlProc.kill(); } catch { /* ignore */ }
            this.controlProc = null;
        }
    }

    /** Restart all lane sidecars. Used after `installGpu()` so the
     *  newly-installed onnxruntime-gpu providers actually register. */
    async restartSidecar(opts: { force?: boolean } = {}): Promise<void> {
        const inFlight = CATEGORIES.filter((c) => this.workers[c].currentJob());
        if (inFlight.length > 0 && !opts.force) {
            throw new Error(
                `Refusing to restart — ${inFlight.length} lane(s) busy: ${inFlight.join(", ")}. Pause and cancel first or pass force=true.`,
            );
        }
        for (const cat of CATEGORIES) this.workers[cat].kill("restart");
        if (this.controlProc) {
            try { this.controlProc.kill(); } catch { /* ignore */ }
            this.controlProc = null;
        }
        this.healthCache = null;
        // Allow next pump() / sendCommand() to spawn fresh.
        await this.health();
    }

    // ─── Health / GPU install (use control sidecar) ──────────────────

    private async ensureControlProcess(): Promise<ChildProcessWithoutNullStreams> {
        if (this.controlProc && !this.controlProc.killed) return this.controlProc;
        if (this.controlSpawning && this.controlReadyPromise) {
            await this.controlReadyPromise;
            if (this.controlProc) return this.controlProc;
        }
        this.controlSpawning = true;
        const python = resolvePython();
        const script = resolveScript();
        if (!existsSync(script)) {
            this.controlSpawning = false;
            throw new Error(`analyzer script not found: ${script}`);
        }
        this.controlReadyPromise = new Promise((res) => { this.controlReadyResolve = res; });
        this.controlProc = spawn(python, [script], {
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PYTHONUNBUFFERED: "1",
                PYTHONIOENCODING: "utf-8",
                MMO_LANE: "control",
            },
            detached: false,
        });
        this.controlProc.on("exit", () => {
            this.controlProc = null;
            this.controlSpawning = false;
        });
        this.controlProc.on("error", () => {
            this.controlProc = null;
            this.controlSpawning = false;
        });
        this.controlProc.stdout.on("data", (chunk: Buffer) => {
            this.controlBuffer += chunk.toString("utf8");
            let nl: number;
            while ((nl = this.controlBuffer.indexOf("\n")) >= 0) {
                const line = this.controlBuffer.slice(0, nl).trim();
                this.controlBuffer = this.controlBuffer.slice(nl + 1);
                if (!line) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.kind === "ready") this.controlReadyResolve?.();
                } catch { /* dispatched via sendCommand listeners */ }
            }
        });
        this.controlProc.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8").trim();
            if (!text) return;
            for (const line of text.split(/\r?\n/)) {
                if (!line) continue;
                this.pushLog("debug", `[control:py] ${line}`);
            }
        });
        await this.controlReadyPromise;
        this.controlSpawning = false;
        return this.controlProc!;
    }

    async health(): Promise<HealthReport> {
        if (
            this.healthCache &&
            this.healthCache.ok &&
            Date.now() - (this.healthCache as unknown as { _ts: number })._ts < 30_000
        ) {
            return this.healthCache;
        }
        const fail = (reason: string): HealthReport => ({ ok: false, reason });
        try {
            const proc = await this.ensureControlProcess();
            const id = randomUUID();
            return await new Promise<HealthReport>((resolve) => {
                let buf = "";
                let timer: NodeJS.Timeout | null = null;
                const cleanup = () => {
                    proc.stdout.off("data", listen);
                    proc.off("exit", onExit);
                    if (timer) clearTimeout(timer);
                };
                const handler = (line: string) => {
                    let m: { id?: string; kind?: string; ok?: boolean; data?: { python?: string; executable?: string; available?: Record<string, boolean>; gpu?: GpuInfo }; error?: string };
                    try { m = JSON.parse(line); } catch { return; }
                    if (m.id !== id || m.kind !== "result") return;
                    cleanup();
                    if (m.ok && m.data) {
                        const r: HealthReport = {
                            ok: true,
                            pythonPath: resolvePython(),
                            pythonVersion: m.data.python,
                            pythonExecutable: m.data.executable,
                            available: m.data.available,
                            gpu: m.data.gpu,
                        };
                        (r as unknown as { _ts: number })._ts = Date.now();
                        this.healthCache = r;
                        resolve(r);
                    } else {
                        resolve(fail(m.error ?? "unknown error"));
                    }
                };
                const listen = (chunk: Buffer) => {
                    buf += chunk.toString("utf8");
                    let nl: number;
                    while ((nl = buf.indexOf("\n")) >= 0) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);
                        if (line) handler(line);
                    }
                };
                const onExit = () => { cleanup(); resolve(fail("python process exited")); };
                proc.stdout.on("data", listen);
                proc.once("exit", onExit);
                try {
                    proc.stdin.write(JSON.stringify({ id, kind: "ping" }) + "\n");
                } catch (e) {
                    cleanup();
                    resolve(fail(e instanceof Error ? e.message : String(e)));
                    return;
                }
                timer = setTimeout(() => { cleanup(); resolve(fail("ping timeout")); }, 20_000);
            });
        } catch (e) {
            return fail(e instanceof Error ? e.message : String(e));
        }
    }

    async installGpu(
        target: "onnx" | "torch" | "all" = "onnx",
        onProgress?: (p: { stage: string; pct: number; msg: string }) => void,
    ): Promise<{ installed: string; gpu: GpuInfo; log: string }> {
        const inFlight = CATEGORIES.filter((c) => this.workers[c].currentJob());
        if (inFlight.length > 0) {
            throw new Error(
                `Cannot install GPU support while lane(s) busy: ${inFlight.join(", ")}. Pause and cancel first.`,
            );
        }
        const result = await this.sendCommand<{ installed: string; restartRequired: boolean; gpu: GpuInfo; log: string }>(
            "gpu_install",
            { target },
            (p) => {
                this.pushLog("info", `[gpu_install] ${Math.round(p.pct * 100)}% — ${p.msg}`);
                onProgress?.(p);
            },
            30 * 60_000,
        );
        this.pushLog("info", `GPU install (${target}) complete — restarting sidecars…`);
        await this.restartSidecar({ force: true });
        const fresh = await this.health();
        return {
            installed: result.installed,
            gpu: fresh.gpu ?? result.gpu,
            log: result.log,
        };
    }

    /** Whether a silent core-deps auto-install has already run this session,
     *  so we never spawn pip more than once per launch (and don't loop if it
     *  keeps failing). */
    private depsAutoInstallTried = false;
    private depsInstalling: Promise<void> | null = null;

    /** Pip-install the CORE analyzer deps (librosa / pyloudnorm / pyacoustid /
     *  soundfile / numpy / audio-separator[cpu]) into the companion's Python
     *  interpreter. Idempotent on the Python side. Restarts the sidecars so
     *  the freshly-installed modules become importable. */
    async installDeps(
        packages?: string[],
        onProgress?: (p: { stage: string; pct: number; msg: string }) => void,
    ): Promise<{ installed: string[]; available: Record<string, boolean>; log: string }> {
        const inFlight = CATEGORIES.filter((c) => this.workers[c].currentJob());
        if (inFlight.length > 0) {
            throw new Error(`Cannot install deps while lane(s) busy: ${inFlight.join(", ")}.`);
        }
        const result = await this.sendCommand<{
            installed: string[]; restartRequired: boolean; available: Record<string, boolean>; log: string;
        }>(
            "deps_install",
            packages ? { packages } : {},
            (p) => {
                this.pushLog("info", `[deps_install] ${Math.round(p.pct * 100)}% — ${p.msg}`);
                onProgress?.(p);
            },
            30 * 60_000,
        );
        if (result.installed.length > 0) {
            this.pushLog("info", `Analyzer deps installed (${result.installed.join(", ")}) — restarting sidecars…`);
            await this.restartSidecar({ force: true });
        }
        const fresh = await this.health();
        return {
            installed: result.installed,
            available: fresh.available ?? result.available,
            log: result.log,
        };
    }

    /**
     * Provision the managed Python env (if needed) and install ONLY the
     * missing analyzer dependencies, reporting progress via `onProgress`. Runs
     * at most once per session and never throws into the caller. Skipped with
     * MMO_ANALYZER_AUTOINSTALL=0.
     *
     * Stages: env (uv + CPython 3.12 venv) → core deps → stems → GPU (when a
     * CUDA GPU is present). Each tier is fault-isolated: a failure in stems or
     * GPU never prevents DSP/loudness/fingerprint from working.
     */
    async ensureDepsInstalled(
        onProgress?: (u: { pct: number; msg: string; steps?: Array<{ id: string; label: string; state: "pending" | "active" | "done" | "error" }>; error?: boolean }) => void,
    ): Promise<{ changed: boolean }> {
        if (this.depsAutoInstallTried) { await this.depsInstalling; return { changed: false }; }
        this.depsAutoInstallTried = true;
        if (process.env.MMO_ANALYZER_AUTOINSTALL === "0") {
            this.pushLog("info", "[deps] auto-install disabled via MMO_ANALYZER_AUTOINSTALL=0");
            return { changed: false };
        }

        let changed = false;
        const steps: Array<{ id: string; label: string; state: "pending" | "active" | "done" | "error" }> = [
            { id: "env", label: "Python environment", state: "pending" },
            { id: "core", label: "Audio analysis (BPM, key, loudness, fingerprint)", state: "pending" },
            { id: "stems", label: "Stem separation engine", state: "pending" },
            { id: "gpu", label: "GPU acceleration", state: "pending" },
        ];
        const setStep = (id: string, state: "pending" | "active" | "done" | "error") => {
            const s = steps.find((x) => x.id === id); if (s) s.state = state;
        };
        const emit = (pct: number, msg: string, error = false) => {
            onProgress?.({ pct, msg, steps: steps.map((s) => ({ ...s })), error });
        };

        this.depsInstalling = (async () => {
            try {
                // 1) Managed Python env (uv + CPython 3.12 venv). Idempotent.
                setStep("env", "active"); emit(0.02, "Preparing Python environment…");
                const { ensurePythonEnv, venvReady } = await import("./python-env");
                const alreadyHadEnv = venvReady();
                await ensurePythonEnv((p) => emit(0.02 + p.pct * 0.28, p.msg, p.stage === "error"));
                if (!alreadyHadEnv) changed = true;
                setStep("env", "done");

                // The control sidecar may have been spawned earlier with the
                // system python. Now that the venv exists, restart it so all
                // subsequent health/install commands target the venv (where
                // resolvePython() now points). force=true: fresh startup.
                if (!alreadyHadEnv) {
                    try { await this.restartSidecar({ force: true }); } catch { /* ignore */ }
                }
                // Re-probe now that the sidecar uses the venv interpreter.
                let h = await this.health();
                if (!h.ok || !h.available) {
                    setStep("core", "error");
                    emit(0.3, "Python unavailable — analysis disabled.", true);
                    return;
                }

                // 2) Core deps (pure wheels → reliable).
                const CORE_FLAGS = ["numpy", "soundfile", "librosa", "pyloudnorm", "pyacoustid"];
                const CORE_PKGS = ["numpy", "soundfile", "librosa", "pyloudnorm", "pyacoustid"];
                if (CORE_FLAGS.some((k) => !h.available![k])) {
                    setStep("core", "active"); emit(0.35, "Installing audio analysis packages…");
                    try {
                        const res = await this.installDeps(CORE_PKGS, (p) => emit(0.35 + p.pct * 0.2, p.msg));
                        if (res.installed.length) changed = true;
                        setStep("core", "done");
                    } catch (e) {
                        setStep("core", "error");
                        this.pushLog("warn", `[deps] core install failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                } else { setStep("core", "done"); }

                // 3) Stems engine (heavy). Best-effort, isolated.
                h = await this.health();
                if (!h.available?.["audio_separator"]) {
                    setStep("stems", "active"); emit(0.58, "Installing stem-separation engine…");
                    try {
                        const res = await this.installDeps(["audio-separator[cpu]"], (p) => emit(0.58 + p.pct * 0.22, p.msg));
                        if (res.installed.length) changed = true;
                        const after = await this.health();
                        setStep("stems", after.available?.["audio_separator"] ? "done" : "error");
                    } catch (e) {
                        setStep("stems", "error");
                        this.pushLog("warn", `[deps] stems install failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                } else { setStep("stems", "done"); }

                // 4) GPU acceleration (only if CUDA GPU present + stems usable).
                h = await this.health();
                const wantGpu = h.gpu?.hasNvidia && !h.gpu?.onnxGpuActive && h.available?.["audio_separator"];
                if (wantGpu) {
                    setStep("gpu", "active"); emit(0.82, "Installing GPU acceleration…");
                    try {
                        await this.installGpu("onnx", (p) => emit(0.82 + p.pct * 0.15, p.msg));
                        changed = true;
                        setStep("gpu", "done");
                    } catch (e) {
                        setStep("gpu", "error");
                        this.pushLog("warn", `[deps] GPU install failed (CPU stems still work): ${e instanceof Error ? e.message : String(e)}`);
                    }
                } else { setStep("gpu", "done"); }

                emit(1, "Analyzer ready.");
            } catch (e) {
                this.pushLog("warn", `[deps] provisioning failed (will retry next launch): ${e instanceof Error ? e.message : String(e)}`);
                emit(1, "Setup incomplete — will retry next launch.", true);
            } finally {
                this.depsInstalling = null;
            }
        })();
        await this.depsInstalling;
        return { changed };
    }

    /** One-shot command on the control sidecar. Used by plugins/host.ts
     *  for `plugins.scan` / `plugins.describe` / `plugins.render`. */
    async sendCommand<T = unknown>(
        kind: string,
        payload: Record<string, unknown> = {},
        onProgress?: (p: { stage: string; pct: number; msg: string }) => void,
        timeoutMs = 5 * 60_000,
    ): Promise<T> {
        const proc = await this.ensureControlProcess();
        const id = randomUUID();
        return new Promise<T>((resolve, reject) => {
            let buf = "";
            let timer: NodeJS.Timeout | null = null;
            const cleanup = () => {
                proc.stdout.off("data", listen);
                proc.off("exit", onExit);
                if (timer) clearTimeout(timer);
            };
            const handler = (line: string) => {
                let m: { id?: string; kind?: string; ok?: boolean; data?: T; error?: string; stage?: string; pct?: number; msg?: string };
                try { m = JSON.parse(line); } catch { return; }
                if (m.id !== id) return;
                if (m.kind === "progress") {
                    onProgress?.({ stage: m.stage ?? "", pct: m.pct ?? 0, msg: m.msg ?? "" });
                    return;
                }
                if (m.kind === "result") {
                    cleanup();
                    if (m.ok && m.data !== undefined) resolve(m.data);
                    else reject(new Error(m.error ?? "unknown error"));
                }
            };
            const listen = (chunk: Buffer) => {
                buf += chunk.toString("utf8");
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line) handler(line);
                }
            };
            const onExit = () => { cleanup(); reject(new Error("python process exited")); };
            proc.stdout.on("data", listen);
            proc.once("exit", onExit);
            try {
                proc.stdin.write(JSON.stringify({ id, kind, ...payload }) + "\n");
            } catch (e) {
                cleanup();
                reject(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            timer = setTimeout(() => {
                cleanup();
                reject(new Error(`command ${kind} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });
    }
}

export const analyzer = new Analyzer();
