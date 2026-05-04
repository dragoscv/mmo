"use client";

/**
 * AnalysisClient — the heart of the /analysis page.
 *
 * Real-time dashboard for the Companion analyzer pipeline:
 *  • Top: hero with health pill + global stats.
 *  • Mid:  three columns — Current job (big card with animated bar),
 *          Queue (compact list), Recently completed (with status).
 *  • Side panel: bulk-analysis controls (mode, scope, options).
 *  • Bottom: live log console with filter + colored levels +
 *          auto-scroll, fed by an incremental cursor poll.
 *
 * No SSE — just two cheap polls (status / logs) that piggy-back the
 * existing companion HTTP API. They self-throttle (3 s when idle,
 * 1.2 s when work is in flight, 8 s when companion is offline).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
    Activity,
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    Ban,
    BarChart3,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    CircleDot,
    Clock,
    Cpu,
    Disc3,
    Filter,
    Globe,
    HardDrive,
    Image,
    Layers,
    Loader2,
    Music2,
    Pause,
    Play,
    RefreshCw,
    ScanSearch,
    Sparkles,
    Square,
    Terminal,
    Trash2,
    XCircle,
    Zap,
} from "lucide-react";
import {
    cancelAnalyzerJob,
    clearAnalyzerQueue,
    clearCompletedJobs,
    getAnalyzerHealth,
    getAnalyzerLogs,
    getAnalyzerStatus,
    getAnalysisScope,
    installGpuSupport,
    pauseAnalyzerLane,
    removeCompletedJob,
    restartAnalyzerSidecar,
    resumeAnalyzerLane,
    retryAnalyzerJob,
    retryFailedJobs,
    startBulkDspAnalysis,
} from "@/actions/analyze";
import type { AnalysisScope } from "@/actions/analyze";
import type {
    AnalyzerHealth,
    AnalyzerJob,
    AnalyzerLogEntry,
    AnalyzerStatus,
    Category,
    LaneStatus,
} from "@/lib/companion-library";
import { cn, formatNumber } from "@/lib/utils";

// ─── Constants ──────────────────────────────────────────────────────

const POLL_STATUS_ACTIVE_MS = 1200;
const POLL_STATUS_IDLE_MS = 3000;
const POLL_STATUS_OFFLINE_MS = 8000;
const POLL_LOGS_ACTIVE_MS = 1000;
const POLL_LOGS_IDLE_MS = 4000;
const HEALTH_CADENCE_MS = 12_000;

const STAGE_META: Record<string, { label: string; color: string }> = {
    queued: { label: "Queued", color: "text-white/60" },
    dsp: { label: "DSP", color: "text-blue-300" },
    fp: { label: "Fingerprint", color: "text-violet-300" },
    stems: { label: "Stems", color: "text-emerald-300" },
    done: { label: "Done", color: "text-emerald-400" },
    error: { label: "Error", color: "text-rose-400" },
};

// ─── Component ──────────────────────────────────────────────────────

export function AnalysisClient() {
    // Health
    const [health, setHealth] = useState<AnalyzerHealth | null>(null);
    const [healthMisses, setHealthMisses] = useState(0);

    // Status (queue + current + completed)
    const [status, setStatus] = useState<AnalyzerStatus | null>(null);
    const [scope, setScope] = useState<AnalysisScope | null>(null);

    // Logs
    const [logs, setLogs] = useState<AnalyzerLogEntry[]>([]);
    const [logCursor, setLogCursor] = useState(0);
    const [logFilter, setLogFilter] = useState<"all" | "info" | "warn" | "error">("all");
    const [logAutoScroll, setLogAutoScroll] = useState(true);
    const logScrollRef = useRef<HTMLDivElement>(null);

    // Controls
    const [opts, setOpts] = useState({ dsp: true, stems: false, fingerprint: false });
    const [filter, setFilter] = useState<"all" | "missing-dsp" | "missing-stems">("missing-dsp");
    const [forceReanalyze, setForceReanalyze] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [lastResult, setLastResult] = useState<string | null>(null);

    // Batch progress: tracks the current "wave" of work across the whole queue
    // so we can show overall %, ETA, and throughput — not just per-job progress.
    // A batch starts when work appears (current+queue > 0) after being idle, and
    // ends when everything drains. If the user enqueues more mid-batch, we grow
    // the batch total instead of starting a fresh one.
    const [batch, setBatch] = useState<{
        startedAt: number;
        initialPending: number; // jobs we had to do at batch start
        addedSince: number; // extra jobs enqueued mid-batch
        finishedAt: number | null;
    } | null>(null);

    const inFlight = !!status?.current || (status?.queue?.length ?? 0) > 0;

    // ─── Health probe (sticky) ──────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        const probe = async () => {
            const h = await getAnalyzerHealth();
            if (cancelled) return;
            if (h.ok) {
                setHealth(h);
                setHealthMisses(0);
            } else {
                setHealthMisses((p) => {
                    const next = p + 1;
                    if (next < 2 && health?.ok) return next;
                    setHealth(h);
                    return next;
                });
            }
        };
        probe();
        const id = setInterval(probe, HEALTH_CADENCE_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, [health?.ok]);

    // ─── Status poll (adaptive cadence) ─────────────────────────────
    // The poll passes `batch.startedAt` as a `since` query param so
    // the companion can return authoritative finished-job counts from
    // sqlite (the in-memory `completed` ring buffer caps at 128 and
    // gets evicted in seconds during a 17 000-job batch). We use a
    // ref to avoid restarting the polling loop on every batch change.
    const batchStartedAtRef = useRef<number | undefined>(undefined);
    useEffect(() => {
        batchStartedAtRef.current = batch?.startedAt;
    }, [batch?.startedAt]);

    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            const s = await getAnalyzerStatus(batchStartedAtRef.current);
            if (cancelled) return;
            if ("error" in s) {
                setStatus(null);
            } else {
                setStatus(s);
            }
            const cadence = !health?.ok
                ? POLL_STATUS_OFFLINE_MS
                : (s && !("error" in s) && (s.current || s.queue.length > 0))
                    ? POLL_STATUS_ACTIVE_MS
                    : POLL_STATUS_IDLE_MS;
            timer = setTimeout(tick, cadence);
        };
        tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [health?.ok]);

    // ─── Logs poll (incremental) ────────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            const r = await getAnalyzerLogs(logCursor, 500);
            if (cancelled) return;
            if (r.logs.length > 0) {
                setLogs((prev) => {
                    // Cap to 400 entries client-side. Rendering 1000 framer-motion
                    // rows kills FPS during high-throughput batches; 400 is plenty
                    // of scrollback and keeps the DOM cheap.
                    const merged = prev.length === 0 ? r.logs : [...prev, ...r.logs];
                    return merged.length > 400 ? merged.slice(-400) : merged;
                });
                setLogCursor(r.logs[r.logs.length - 1]!.seq);
            }
            const cadence = inFlight ? POLL_LOGS_ACTIVE_MS : POLL_LOGS_IDLE_MS;
            timer = setTimeout(tick, cadence);
        };
        tick();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [logCursor, inFlight]);

    // Initial scope
    useEffect(() => {
        getAnalysisScope().then(setScope);
    }, []);

    // Auto-scroll logs container.
    useEffect(() => {
        if (!logAutoScroll) return;
        const el = logScrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [logs.length, logAutoScroll]);

    // ─── Actions ────────────────────────────────────────────────────
    const startBulk = useCallback(async () => {
        if (!opts.dsp && !opts.stems && !opts.fingerprint) return;
        setSubmitting(true);
        setLastResult(null);
        try {
            const r = await startBulkDspAnalysis(opts, filter, forceReanalyze);
            if ("error" in r && r.error) setLastResult(`Error: ${r.error}`);
            else {
                const parts = [`Enqueued ${r.enqueued} job(s)`];
                if (r.tracksTouched) parts.push(`across ${r.tracksTouched} track(s)`);
                if (r.skipped) parts.push(`— skipped ${r.skipped} already complete`);
                setLastResult(parts.join(" ") + ".");
            }
        } finally {
            setSubmitting(false);
        }
    }, [opts, filter, forceReanalyze]);

    const cancelCurrent = useCallback(async () => {
        if (!status?.current) return;
        await cancelAnalyzerJob(status.current.id);
    }, [status]);

    const cancelQueued = useCallback(async (id: string) => {
        await cancelAnalyzerJob(id);
    }, []);

    const retryJob = useCallback(async (id: string) => {
        await retryAnalyzerJob(id);
    }, []);

    const removeJob = useCallback(async (id: string) => {
        await removeCompletedJob(id);
    }, []);

    const clearQueue = useCallback(async () => {
        if (!status?.queue.length) return;
        if (!window.confirm(`Remove ${status.queue.length} queued job(s)?`)) return;
        await clearAnalyzerQueue();
    }, [status]);

    const clearLaneQueue = useCallback(async (cat: Category) => {
        const lane = status?.lanes?.find((l) => l.category === cat);
        if (!lane?.queueDepth) return;
        if (!window.confirm(`Remove ${lane.queueDepth} queued ${cat} job(s)?`)) return;
        await clearAnalyzerQueue(cat);
    }, [status]);

    const togglePauseLane = useCallback(async (cat: Category, paused: boolean) => {
        if (paused) await resumeAnalyzerLane(cat);
        else await pauseAnalyzerLane(cat);
    }, []);

    const clearCompleted = useCallback(async (filter: "all" | "errored" | "done" = "all") => {
        await clearCompletedJobs(filter);
    }, []);

    const retryAllFailed = useCallback(async () => {
        await retryFailedJobs();
    }, []);

    const clearLogs = useCallback(() => setLogs([]), []);

    // ─── Derived ────────────────────────────────────────────────────
    const filteredLogs = useMemo(
        () => (logFilter === "all" ? logs : logs.filter((l) => l.level === logFilter)),
        [logs, logFilter],
    );

    const stats = useMemo(() => {
        const done = (status?.completed ?? []).filter((j) => !j.error).length;
        const failed = (status?.completed ?? []).filter((j) => !!j.error).length;
        const queued = status?.queue.length ?? 0;
        return { done, failed, queued };
    }, [status]);

    // Batch lifecycle: open one when work starts, grow when more is enqueued,
    // close (with finishedAt) when everything drains. We keep the closed batch
    // around for ~6s so the user can see the final "done in X" summary.
    //
    // NOTE: with the v0.9 multi-lane analyzer, each track produces 1-3 sub-jobs
    // (one per active category) that run on independent worker lanes. So
    // `pending` here counts SUB-JOBS, not tracks — `lanes[*].current` and
    // `lanes[*].queueDepth` are summed across all 3 lanes for an accurate
    // total. Falling back to `status.current/queue` keeps it working with
    // older companion versions that didn't expose `lanes`.
    useEffect(() => {
        const lanes = status?.lanes;
        const pending = lanes
            ? lanes.reduce((sum, l) => sum + l.queueDepth + (l.current ? 1 : 0), 0)
            : (status?.current ? 1 : 0) + (status?.queue?.length ?? 0);
        setBatch((prev) => {
            if (pending === 0) {
                if (!prev) return null;
                if (prev.finishedAt) return prev;
                return { ...prev, finishedAt: Date.now() };
            }
            // pending > 0
            if (!prev || prev.finishedAt) {
                // start a fresh batch (idle → busy, or new burst after one closed)
                return {
                    startedAt: Date.now(),
                    initialPending: pending,
                    addedSince: 0,
                    finishedAt: null,
                };
            }
            // We're inside an open batch. Count finished-since-start
            // from the AUTHORITATIVE sqlite count (companion 0.9.2+),
            // falling back to the in-memory ring buffer otherwise.
            // Without sqlite the count caps at 128 and `addedSince`
            // detection breaks during big batches.
            const finishedSinceStart = status?.finishedSince
                ? status.finishedSince.total
                : (status?.completed ?? []).filter(
                    (j) => j.finishedAt && j.finishedAt >= prev.startedAt,
                ).length;
            const totalSeen = finishedSinceStart + pending;
            const baselineTotal = prev.initialPending + prev.addedSince;
            if (totalSeen > baselineTotal) {
                return { ...prev, addedSince: prev.addedSince + (totalSeen - baselineTotal) };
            }
            return prev;
        });
    }, [status]);

    // Auto-clear a finished batch after 6s so the card collapses gracefully.
    useEffect(() => {
        if (!batch?.finishedAt) return;
        const t = setTimeout(() => setBatch(null), 6000);
        return () => clearTimeout(t);
    }, [batch?.finishedAt]);

    const batchStats = useMemo(() => {
        if (!batch) return null;
        const total = batch.initialPending + batch.addedSince;
        // Prefer the authoritative sqlite-backed count from the
        // companion (v0.9.2+) so we don't get capped by the 128-entry
        // in-memory ring buffer. Fall back to filtering the buffer
        // for older companions.
        const fromServer = status?.finishedSince;
        let doneCount: number;
        let failedCount: number;
        if (fromServer) {
            doneCount = fromServer.total;
            failedCount = fromServer.errored;
        } else {
            const completed = (status?.completed ?? []).filter(
                (j) => j.finishedAt && j.finishedAt >= batch.startedAt,
            );
            doneCount = completed.length;
            failedCount = completed.filter((j) => !!j.error).length;
        }
        const remaining = Math.max(0, total - doneCount);
        // Sum partial progress of EVERY running lane (not just the
        // "best" one). With 3 lanes running concurrently this is up
        // to 3 partial-credits per moment.
        const lanes = status?.lanes;
        const runningProgress = lanes
            ? lanes.reduce((sum, l) => sum + (l.current?.progress ?? 0), 0)
            : (status?.current?.progress ?? 0);
        const runningCount = lanes
            ? lanes.filter((l) => !!l.current).length
            : (status?.current ? 1 : 0);
        const fractionalDone = doneCount + runningProgress;
        const overall = total > 0 ? Math.min(1, fractionalDone / total) : 0;
        const elapsed = (batch.finishedAt ?? Date.now()) - batch.startedAt;
        const avgPerJobMs =
            fractionalDone > 0.05 ? elapsed / fractionalDone : null;
        const etaMs =
            !batch.finishedAt && avgPerJobMs != null && remaining > 0
                ? Math.max(
                      0,
                      avgPerJobMs * (remaining - runningProgress),
                  )
                : null;
        return {
            total,
            doneCount,
            failedCount,
            remaining,
            overall,
            elapsed,
            avgPerJobMs,
            etaMs,
            finished: !!batch.finishedAt,
            runningCount,
        };
    }, [batch, status]);

    // ─── Render ─────────────────────────────────────────────────────
    return (
        <div className="flex h-full flex-col overflow-y-auto bg-[var(--background)] text-[var(--foreground)]">
            {/* Hero */}
            <header className="relative overflow-hidden border-b border-[var(--border)] bg-gradient-to-br from-purple-500/10 via-transparent to-emerald-500/10 px-6 py-6">
                <div className="absolute -top-12 -right-12 h-48 w-48 rounded-full bg-purple-500/10 blur-3xl" />
                <div className="relative flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                        <Link
                            href="/"
                            className="inline-flex items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                        >
                            <ArrowLeft className="h-3 w-3" /> Dashboard
                        </Link>
                        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                            <Activity className="h-6 w-6 text-purple-400" />
                            Library Analysis
                        </h1>
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Real-time view of the Companion DSP / Stems / AcoustID pipeline.
                        </p>
                    </div>
                    <HealthPill health={health} />
                </div>
                <div className="relative mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                    <StatTile
                        label="In queue"
                        value={stats.queued}
                        accent="purple"
                        icon={<CircleDot className="h-4 w-4" />}
                    />
                    <StatTile
                        label="Currently"
                        value={status?.current ? 1 : 0}
                        accent="emerald"
                        icon={<Loader2 className={cn("h-4 w-4", status?.current && "animate-spin")} />}
                    />
                    <StatTile
                        label="Completed"
                        value={stats.done}
                        accent="emerald"
                        icon={<CheckCircle2 className="h-4 w-4" />}
                    />
                    <StatTile
                        label="Errored"
                        value={stats.failed}
                        accent={stats.failed > 0 ? "rose" : "muted"}
                        icon={<AlertCircle className="h-4 w-4" />}
                    />
                    <StatTile
                        label="Library size"
                        value={scope?.total ?? 0}
                        accent="muted"
                        icon={<HardDrive className="h-4 w-4" />}
                    />
                </div>
            </header>

            {/* Body */}
            <div className="grid flex-1 grid-cols-1 gap-4 px-6 py-5 lg:grid-cols-12">
                {/* Left column: live job + queue + completed */}
                <section className="lg:col-span-8 space-y-4">
                    <BatchProgressCard stats={batchStats} />
                    {status?.lanes && status.lanes.length > 0 ? (
                        <LanesPanel
                            lanes={status.lanes}
                            onTogglePause={togglePauseLane}
                            onClearLane={clearLaneQueue}
                            onCancelJob={cancelQueued}
                        />
                    ) : (
                        // Legacy single-job view (companion < 0.9). With
                        // lanes the per-lane mini-bars in LanesPanel make
                        // this card redundant — it would just duplicate
                        // whichever lane happens to be most-progressed.
                        <CurrentJobCard
                            job={status?.current ?? null}
                            onCancel={cancelCurrent}
                        />
                    )}
                    <div className="grid gap-4 md:grid-cols-2">
                        <QueueCard
                            queue={status?.queue ?? []}
                            onCancel={cancelQueued}
                            onClearAll={clearQueue}
                        />
                        <CompletedCard
                            completed={status?.completed ?? []}
                            onRetry={retryJob}
                            onRemove={removeJob}
                            onClearAll={() => clearCompleted("all")}
                            onClearDone={() => clearCompleted("done")}
                            onRetryAllFailed={retryAllFailed}
                        />
                    </div>
                </section>

                {/* Right column: controls */}
                <aside className="lg:col-span-4 space-y-4">
                    <ControlsCard
                        health={health}
                        scope={scope}
                        opts={opts}
                        setOpts={setOpts}
                        filter={filter}
                        setFilter={setFilter}
                        forceReanalyze={forceReanalyze}
                        setForceReanalyze={setForceReanalyze}
                        submitting={submitting}
                        lastResult={lastResult}
                        onStart={startBulk}
                    />
                    <SystemCard health={health} healthMisses={healthMisses} />
                </aside>

                {/* Logs full width */}
                <section className="lg:col-span-12">
                    <LogConsole
                        logs={filteredLogs}
                        rawCount={logs.length}
                        filter={logFilter}
                        setFilter={setLogFilter}
                        autoScroll={logAutoScroll}
                        setAutoScroll={setLogAutoScroll}
                        onClear={clearLogs}
                        scrollRef={logScrollRef}
                    />
                </section>
            </div>
        </div>
    );
}

// ─── Sub-components ─────────────────────────────────────────────────

function HealthPill({ health }: { health: AnalyzerHealth | null }) {
    const ok = !!health?.ok;
    return (
        <motion.div
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
                ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-200",
            )}
        >
            <span className="relative flex h-2 w-2">
                <span
                    className={cn(
                        "absolute inset-0 rounded-full",
                        ok ? "bg-emerald-400" : "bg-amber-400",
                    )}
                />
                {ok && (
                    <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
                )}
            </span>
            <span className="font-medium">
                {ok ? "Companion online" : "Companion offline"}
            </span>
            {ok && health?.pythonVersion && (
                <span className="text-emerald-300/70">
                    py {health.pythonVersion.split(" ")[0]}
                </span>
            )}
        </motion.div>
    );
}

function StatTile({
    label,
    value,
    accent,
    icon,
}: {
    label: string;
    value: number;
    accent: "purple" | "emerald" | "rose" | "muted";
    icon: React.ReactNode;
}) {
    const accentClass = {
        purple: "from-purple-500/10 border-purple-500/30 text-purple-200",
        emerald: "from-emerald-500/10 border-emerald-500/30 text-emerald-200",
        rose: "from-rose-500/10 border-rose-500/30 text-rose-200",
        muted: "from-white/5 border-white/10 text-white/80",
    }[accent];
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
                "rounded-lg border bg-gradient-to-br to-transparent px-3 py-2",
                accentClass,
            )}
        >
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-white/60">
                    {label}
                </span>
                <span className="opacity-70">{icon}</span>
            </div>
            <motion.div
                key={value}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-1 text-2xl font-semibold tabular-nums"
            >
                {formatNumber(value)}
            </motion.div>
        </motion.div>
    );
}

type BatchStats = {
    total: number;
    doneCount: number;
    failedCount: number;
    remaining: number;
    overall: number;
    elapsed: number;
    avgPerJobMs: number | null;
    etaMs: number | null;
    finished: boolean;
};

// ─── LanesPanel: per-category status with pause/resume ──────────────

const LANE_META: Record<Category, { label: string; description: string; color: string; icon: typeof Cpu; badge: string }> = {
    dsp: {
        label: "DSP",
        description: "BPM · Key · Energy · Loudness",
        color: "from-emerald-500/20 to-emerald-500/5 border-emerald-500/30",
        icon: Activity,
        badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    },
    stems: {
        label: "Stems",
        description: "Source separation (GPU)",
        color: "from-fuchsia-500/20 to-fuchsia-500/5 border-fuchsia-500/30",
        icon: Layers,
        badge: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200",
    },
    fingerprint: {
        label: "Fingerprint",
        description: "AcoustID / Chromaprint",
        color: "from-sky-500/20 to-sky-500/5 border-sky-500/30",
        icon: ScanSearch,
        badge: "border-sky-500/40 bg-sky-500/10 text-sky-200",
    },
};

/** Compact lane badge used in queue/completed lists so the user can tell
 *  at-a-glance which lane each sub-job belongs to (a single track now
 *  generates 1-3 sub-jobs across DSP/stems/fingerprint). */
function CategoryBadge({ category }: { category?: Category }) {
    if (!category) return null;
    const meta = LANE_META[category];
    return (
        <span
            className={cn(
                "inline-flex items-center rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                meta.badge,
            )}
        >
            {meta.label}
        </span>
    );
}

function LanesPanel({
    lanes,
    onTogglePause,
    onClearLane,
    onCancelJob,
}: {
    lanes: LaneStatus[];
    onTogglePause: (cat: Category, paused: boolean) => void | Promise<void>;
    onClearLane: (cat: Category) => void | Promise<void>;
    onCancelJob: (id: string) => void | Promise<void>;
}) {
    return (
        <div className="rounded-2xl border border-border/60 bg-card/50 p-4">
            <div className="mb-3 flex items-center justify-between">
                <div>
                    <div className="text-sm font-medium">Worker lanes</div>
                    <div className="text-xs text-muted-foreground">
                        Three independent queues running concurrently. Pause one without affecting the others.
                    </div>
                </div>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {lanes.map((lane) => {
                    const meta = LANE_META[lane.category];
                    const Icon = meta.icon;
                    const cur = lane.current;
                    const pct = cur ? Math.round((cur.progress ?? 0) * 100) : 0;
                    return (
                        <div
                            key={lane.category}
                            className={cn(
                                "rounded-xl border bg-gradient-to-br p-3 transition-colors",
                                meta.color,
                                lane.paused && "opacity-70",
                            )}
                        >
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-2">
                                    <Icon className="h-4 w-4" />
                                    <div>
                                        <div className="flex items-center gap-1.5 text-sm font-semibold">
                                            {meta.label}
                                            {lane.paused && (
                                                <span className="rounded-full bg-secondary px-1.5 text-[10px] text-secondary-foreground">
                                                    paused
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-[10px] text-muted-foreground">
                                            {meta.description}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex gap-1">
                                    <button
                                        type="button"
                                        onClick={() => onTogglePause(lane.category, lane.paused)}
                                        title={lane.paused ? "Resume lane" : "Pause lane"}
                                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                                    >
                                        {lane.paused
                                            ? <Play className="h-3.5 w-3.5" />
                                            : <Pause className="h-3.5 w-3.5" />}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onClearLane(lane.category)}
                                        disabled={lane.queueDepth === 0}
                                        title="Clear queued in this lane"
                                        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>

                            <div className="mt-3 space-y-2">
                                {cur ? (
                                    <div>
                                        <div className="flex items-center justify-between text-[11px]">
                                            <span className="truncate font-mono text-muted-foreground">
                                                track {cur.trackId}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => onCancelJob(cur.id)}
                                                className="text-muted-foreground hover:text-destructive"
                                                title="Cancel current"
                                            >
                                                <XCircle className="h-3 w-3" />
                                            </button>
                                        </div>
                                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-background/60">
                                            <motion.div
                                                className="h-full bg-primary"
                                                initial={false}
                                                animate={{ width: `${pct}%` }}
                                                transition={{ duration: 0.4, ease: "easeOut" }}
                                            />
                                        </div>
                                        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                                            <span className="truncate">{cur.message ?? cur.stage}</span>
                                            <span className="tabular-nums">{pct}%</span>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="rounded-md border border-dashed border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                                        idle
                                    </div>
                                )}

                                <div className="flex items-center justify-between text-[11px]">
                                    <span className="text-muted-foreground">queued</span>
                                    <span className="font-mono tabular-nums">{lane.queueDepth}</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function BatchProgressCard({ stats }: { stats: BatchStats | null }) {
    return (
        <AnimatePresence initial={false}>
            {stats && stats.total > 0 && (
                <motion.section
                    key="batch"
                    initial={{ opacity: 0, y: -8, height: 0 }}
                    animate={{ opacity: 1, y: 0, height: "auto" }}
                    exit={{ opacity: 0, y: -8, height: 0 }}
                    transition={{ type: "spring", stiffness: 200, damping: 26 }}
                    className={cn(
                        "overflow-hidden rounded-xl border bg-gradient-to-br p-4",
                        stats.finished
                            ? "border-emerald-500/30 from-emerald-500/10 to-transparent"
                            : "border-purple-500/30 from-purple-500/10 via-pink-500/5 to-emerald-500/10",
                    )}
                >
                    <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-white/60">
                                <Layers className="h-3 w-3" />
                                {stats.finished ? "Batch complete" : "Batch progress"}
                            </div>
                            <div className="mt-0.5 flex items-baseline gap-2">
                                <span className="font-mono text-3xl font-semibold tabular-nums text-white">
                                    {stats.doneCount}
                                </span>
                                <span className="font-mono text-lg text-white/50">
                                    / {stats.total}
                                </span>
                                <span className="text-xs text-white/50">
                                    job{stats.total === 1 ? "" : "s"}
                                </span>
                                {stats.failedCount > 0 && (
                                    <span className="ml-2 inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-200">
                                        <AlertCircle className="h-3 w-3" />
                                        {stats.failedCount} failed
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="text-right">
                            <div className="text-[10px] uppercase tracking-wide text-white/60">
                                Overall
                            </div>
                            <motion.div
                                key={Math.round(stats.overall * 1000)}
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="font-mono text-3xl font-semibold tabular-nums text-white"
                            >
                                {Math.round(stats.overall * 100)}%
                            </motion.div>
                        </div>
                    </div>

                    <div className="mt-3">
                        <ProgressBar value={stats.overall} />
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <BatchStatCell
                            icon={<Clock className="h-3 w-3" />}
                            label="Elapsed"
                            value={formatDuration(stats.elapsed)}
                        />
                        <BatchStatCell
                            icon={<Activity className="h-3 w-3" />}
                            label="Avg / track"
                            value={
                                stats.avgPerJobMs != null
                                    ? formatDuration(stats.avgPerJobMs)
                                    : "—"
                            }
                        />
                        <BatchStatCell
                            icon={<CircleDot className="h-3 w-3" />}
                            label="Remaining"
                            value={`${stats.remaining}`}
                        />
                        <BatchStatCell
                            icon={<Zap className="h-3 w-3" />}
                            label={stats.finished ? "Done in" : "ETA"}
                            value={
                                stats.finished
                                    ? formatDuration(stats.elapsed)
                                    : stats.etaMs != null
                                      ? `~${formatDuration(stats.etaMs)}`
                                      : "calculating…"
                            }
                            highlight={!stats.finished && stats.etaMs != null}
                        />
                    </div>
                </motion.section>
            )}
        </AnimatePresence>
    );
}

function BatchStatCell({
    icon,
    label,
    value,
    highlight,
}: {
    icon: React.ReactNode;
    label: string;
    value: string;
    highlight?: boolean;
}) {
    return (
        <div
            className={cn(
                "rounded-md border px-2.5 py-1.5",
                highlight
                    ? "border-purple-400/40 bg-purple-500/10"
                    : "border-white/10 bg-white/5",
            )}
        >
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-white/55">
                {icon}
                {label}
            </div>
            <div
                className={cn(
                    "mt-0.5 font-mono text-sm tabular-nums",
                    highlight ? "text-purple-100" : "text-white/85",
                )}
            >
                {value}
            </div>
        </div>
    );
}

function CurrentJobCard({
    job,
    onCancel,
}: {
    job: AnalyzerJob | null;
    onCancel: () => void;
}) {
    const stageMeta = job ? STAGE_META[job.stage ?? "queued"] ?? STAGE_META.queued : null;
    return (
        <Card title="Current job" icon={<Sparkles className="h-3.5 w-3.5 text-purple-400" />}>
            <AnimatePresence mode="wait" initial={false}>
                {!job ? (
                    <motion.div
                        key="idle"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex flex-col items-center justify-center gap-1 py-8 text-center text-white/40"
                    >
                        <Loader2 className="h-5 w-5" />
                        <span className="text-xs">Idle — no job in flight</span>
                    </motion.div>
                ) : (
                    <motion.div
                        key={job.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="space-y-3"
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[10px] uppercase tracking-wide text-white/50">
                                    Track
                                </div>
                                <div className="font-mono text-sm">#{job.trackId}</div>
                                <div className="mt-1 flex items-center gap-2">
                                    <span className={cn("text-xs font-medium", stageMeta?.color)}>
                                        {stageMeta?.label}
                                    </span>
                                    <span className="text-xs text-white/60 truncate max-w-[300px]">
                                        {job.message ?? ""}
                                    </span>
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-[10px] uppercase tracking-wide text-white/50">
                                    Progress
                                </div>
                                <div className="font-mono text-2xl font-semibold tabular-nums text-white">
                                    {Math.round((job.progress ?? 0) * 100)}%
                                </div>
                            </div>
                        </div>
                        <ProgressBar value={job.progress ?? 0} />
                        <div className="flex items-center justify-between gap-2 pt-1">
                            <span className="text-[10px] text-white/40">
                                {job.startedAt
                                    ? `running ${formatDuration(Date.now() - job.startedAt)}`
                                    : "starting…"}
                            </span>
                            <button
                                onClick={onCancel}
                                className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-xs text-rose-200 hover:bg-rose-500/20 transition-colors"
                            >
                                <Ban className="h-3 w-3" /> Cancel
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </Card>
    );
}

function QueueCard({
    queue,
    onCancel,
    onClearAll,
}: {
    queue: AnalyzerJob[];
    onCancel: (id: string) => void;
    onClearAll: () => void;
}) {
    return (
        <Card
            title={`Queue (${queue.length})`}
            icon={<CircleDot className="h-3.5 w-3.5 text-purple-300" />}
            actions={queue.length > 0 ? (
                <button
                    onClick={onClearAll}
                    title="Remove all queued jobs"
                    className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                >
                    <Trash2 className="h-3 w-3" /> Clear
                </button>
            ) : undefined}
        >
            {queue.length === 0 ? (
                <div className="py-6 text-center text-xs text-white/40">
                    No queued jobs
                </div>
            ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs">
                    {queue.slice(0, 25).map((j) => (
                        <li
                            key={j.id}
                            className="group flex items-center justify-between gap-2 rounded border border-white/5 bg-white/5 px-2 py-1.5"
                        >
                            <span className="flex items-center gap-1.5 min-w-0">
                                <CategoryBadge category={j.category} />
                                <span className="font-mono text-white/70 truncate">
                                    #{j.trackId}
                                </span>
                            </span>
                            <span className="flex items-center gap-2">
                                <span className="text-white/40">queued</span>
                                <button
                                    onClick={() => onCancel(j.id)}
                                    title="Remove from queue"
                                    className="opacity-0 group-hover:opacity-100 transition-opacity rounded p-0.5 text-rose-300/80 hover:bg-rose-500/15 hover:text-rose-200"
                                >
                                    <XCircle className="h-3.5 w-3.5" />
                                </button>
                            </span>
                        </li>
                    ))}
                    {queue.length > 25 && (
                        <li className="pt-1 text-center text-[10px] text-white/40">
                            + {queue.length - 25} more
                        </li>
                    )}
                </ul>
            )}
        </Card>
    );
}

function CompletedCard({
    completed,
    onRetry,
    onRemove,
    onClearAll,
    onClearDone,
    onRetryAllFailed,
}: {
    completed: AnalyzerJob[];
    onRetry: (id: string) => void;
    onRemove: (id: string) => void;
    onClearAll: () => void;
    onClearDone: () => void;
    onRetryAllFailed: () => void;
}) {
    const recent = useMemo(() => {
        const out: AnalyzerJob[] = [];
        const start = Math.max(0, completed.length - 25);
        for (let i = completed.length - 1; i >= start; i--) out.push(completed[i]!);
        return out;
    }, [completed]);
    const failedCount = useMemo(
        () => completed.reduce((n, j) => (j.error ? n + 1 : n), 0),
        [completed],
    );
    return (
        <Card
            title={`Recently completed (${completed.length})`}
            icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
            actions={completed.length > 0 ? (
                <div className="flex items-center gap-1">
                    {failedCount > 0 && (
                        <button
                            onClick={onRetryAllFailed}
                            title={`Retry ${failedCount} failed job(s)`}
                            className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200 hover:bg-amber-500/20 transition-colors"
                        >
                            <RefreshCw className="h-3 w-3" /> Retry failed ({failedCount})
                        </button>
                    )}
                    {failedCount > 0 && failedCount < completed.length && (
                        <button
                            onClick={onClearDone}
                            title="Clear successful entries (keep failures)"
                            className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                        >
                            <Trash2 className="h-3 w-3" /> Clear done
                        </button>
                    )}
                    <button
                        onClick={onClearAll}
                        title="Clear all entries"
                        className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/70 hover:bg-white/10 hover:text-white transition-colors"
                    >
                        <Trash2 className="h-3 w-3" /> Clear
                    </button>
                </div>
            ) : undefined}
        >
            {recent.length === 0 ? (
                <div className="py-6 text-center text-xs text-white/40">
                    Nothing finished yet
                </div>
            ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto pr-1 text-xs">
                    {recent.map((j) => {
                        const ms =
                            j.startedAt && j.finishedAt
                                ? j.finishedAt - j.startedAt
                                : null;
                        return (
                            <li
                                key={j.id}
                                className={cn(
                                    "group flex items-center justify-between gap-2 rounded border px-2 py-1.5",
                                    j.error
                                        ? "border-rose-500/20 bg-rose-500/5"
                                        : "border-emerald-500/20 bg-emerald-500/5",
                                )}
                            >
                                <span className="flex min-w-0 items-center gap-1.5">
                                    {j.error ? (
                                        <XCircle className="h-3 w-3 text-rose-400 shrink-0" />
                                    ) : (
                                        <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
                                    )}
                                    <CategoryBadge category={j.category} />
                                    <span className="font-mono text-white/80 shrink-0">
                                        #{j.trackId}
                                    </span>
                                    {j.error && (
                                        <span className="truncate text-rose-300/80">
                                            {j.error}
                                        </span>
                                    )}
                                </span>
                                <span className="flex items-center gap-2 shrink-0">
                                    {ms !== null && (
                                        <span className="text-white/40 tabular-nums">
                                            {formatDuration(ms)}
                                        </span>
                                    )}
                                    <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button
                                            onClick={() => onRetry(j.id)}
                                            title={j.error ? "Retry this failed job" : "Run again"}
                                            className="rounded p-0.5 text-amber-300/80 hover:bg-amber-500/15 hover:text-amber-200"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            onClick={() => onRemove(j.id)}
                                            title="Remove from history"
                                            className="rounded p-0.5 text-white/50 hover:bg-white/10 hover:text-white"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </span>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </Card>
    );
}

function ControlsCard({
    health,
    scope,
    opts,
    setOpts,
    filter,
    setFilter,
    forceReanalyze,
    setForceReanalyze,
    submitting,
    lastResult,
    onStart,
}: {
    health: AnalyzerHealth | null;
    scope: AnalysisScope | null;
    opts: { dsp: boolean; stems: boolean; fingerprint: boolean };
    setOpts: (o: { dsp: boolean; stems: boolean; fingerprint: boolean }) => void;
    filter: "all" | "missing-dsp" | "missing-stems";
    setFilter: (f: "all" | "missing-dsp" | "missing-stems") => void;
    forceReanalyze: boolean;
    setForceReanalyze: (v: boolean) => void;
    submitting: boolean;
    lastResult: string | null;
    onStart: () => void;
}) {
    const noneSelected = !opts.dsp && !opts.stems && !opts.fingerprint;
    const disabled = submitting || !health?.ok || noneSelected;

    return (
        <Card title="Bulk analysis" icon={<Zap className="h-3.5 w-3.5 text-amber-300" />}>
            <div className="space-y-4">
                {/* Options */}
                <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-white/50">
                        What to run
                    </div>
                    <OptionToggle
                        label="DSP analysis"
                        desc="BPM · Key · Loudness · Chords · Energy"
                        icon={<Sparkles className="h-3.5 w-3.5" />}
                        checked={opts.dsp}
                        disabled={!health?.available?.librosa}
                        onChange={(v) => setOpts({ ...opts, dsp: v })}
                    />
                    <OptionToggle
                        label="Stems separation"
                        desc="Vocals / drums / bass / other (Demucs htdemucs_ft)"
                        icon={<Layers className="h-3.5 w-3.5" />}
                        checked={opts.stems}
                        disabled={!health?.available?.audio_separator}
                        onChange={(v) => setOpts({ ...opts, stems: v })}
                    />
                    <OptionToggle
                        label="Audio fingerprint"
                        desc="AcoustID — for MusicBrainz matching"
                        icon={<ScanSearch className="h-3.5 w-3.5" />}
                        checked={opts.fingerprint}
                        disabled={!health?.available?.pyacoustid}
                        onChange={(v) => setOpts({ ...opts, fingerprint: v })}
                    />
                </div>

                {/* Scope */}
                <div className="space-y-2">
                    <div className="text-[10px] uppercase tracking-wide text-white/50">
                        Scope
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-xs">
                        {(
                            [
                                { v: "missing-dsp", l: "Missing DSP" },
                                { v: "missing-stems", l: "Missing stems" },
                                { v: "all", l: "Entire library" },
                            ] as const
                        ).map((o) => (
                            <button
                                key={o.v}
                                onClick={() => setFilter(o.v)}
                                className={cn(
                                    "rounded-md border px-2 py-1.5 transition-colors",
                                    filter === o.v
                                        ? "border-purple-500/50 bg-purple-500/15 text-purple-200"
                                        : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10",
                                )}
                            >
                                {o.l}
                            </button>
                        ))}
                    </div>
                    {scope && (
                        <div className="text-[10px] text-white/40">
                            ~{formatNumber(
                                filter === "all"
                                    ? scope.total
                                    : filter === "missing-dsp"
                                        ? scope.missingBpm
                                        : scope.total - (scope.recentlyAnalyzed ?? 0),
                            )}{" "}
                            track(s) match
                        </div>
                    )}
                </div>

                {/* Skip-already-done toggle */}
                <label
                    className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors",
                        forceReanalyze
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                            : "border-white/10 bg-white/5 text-white/70 hover:bg-white/8",
                    )}
                >
                    <input
                        type="checkbox"
                        checked={forceReanalyze}
                        onChange={(e) => setForceReanalyze(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 cursor-pointer accent-amber-500"
                    />
                    <span className="flex-1">
                        <span className="block font-medium">
                            Re-analyze already-done categories
                        </span>
                        <span className="block text-[10px] text-white/50">
                            {forceReanalyze
                                ? "Will overwrite existing DSP / stems / fingerprint data."
                                : "Default: skip per-track per-category. A track with DSP done but no stems will only enqueue the stems sub-job."}
                        </span>
                    </span>
                </label>

                {/* Action */}
                <button
                    onClick={onStart}
                    disabled={disabled}
                    className={cn(
                        "group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-md px-4 py-2.5 text-sm font-medium transition-all",
                        disabled
                            ? "cursor-not-allowed bg-white/5 text-white/30"
                            : "bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-500 hover:to-pink-500 cursor-pointer shadow-lg shadow-purple-500/20",
                    )}
                >
                    {submitting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Play className="h-4 w-4" />
                    )}
                    {submitting ? "Enqueuing…" : "Start analysis"}
                </button>
                {lastResult && (
                    <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={cn(
                            "rounded-md border px-2.5 py-1.5 text-xs",
                            lastResult.startsWith("Error")
                                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
                        )}
                    >
                        {lastResult}
                    </motion.div>
                )}
            </div>
        </Card>
    );
}

function SystemCard({
    health,
    healthMisses,
}: {
    health: AnalyzerHealth | null;
    healthMisses: number;
}) {
    const deps = health?.available ?? {};
    const gpu = health?.gpu;
    const items = [
        { key: "librosa", label: "librosa", desc: "BPM · key · chords" },
        { key: "audio_separator", label: "audio-separator", desc: "Stems" },
        { key: "pyacoustid", label: "pyacoustid", desc: "AcoustID" },
        { key: "pyloudnorm", label: "pyloudnorm", desc: "LUFS" },
        { key: "soundfile", label: "soundfile", desc: "I/O" },
        { key: "numpy", label: "numpy", desc: "Numerics" },
    ] as const;

    const [installing, setInstalling] = useState<null | "onnx" | "torch" | "all">(null);
    const [installResult, setInstallResult] = useState<string | null>(null);
    const onInstallGpu = useCallback(async (target: "onnx" | "torch" | "all") => {
        if (installing) return;
        if (
            !window.confirm(
                target === "all"
                    ? "Install onnxruntime-gpu AND torch+CUDA? Downloads can be ~2 GB and may take several minutes. Continue?"
                    : target === "torch"
                      ? "Install torch+torchaudio CUDA wheels? ~2 GB download. Continue?"
                      : "Install onnxruntime-gpu? Replaces the CPU build. Continue?",
            )
        ) return;
        setInstalling(target);
        setInstallResult(null);
        try {
            const r = await installGpuSupport(target);
            if (r.error) {
                setInstallResult(`Install failed: ${r.error}`);
            } else if (r.gpu?.recommendation === "ready") {
                setInstallResult(
                    `GPU ready! Active on ${r.gpu.gpuName ?? "GPU"} (${r.gpu.onnxPackage ?? "onnx"}).`,
                );
            } else if (r.gpu?.recommendation === "install_cuda_runtime") {
                setInstallResult(
                    `Installed ${r.installed} but CUDA/cuDNN runtime is missing — install the CUDA Toolkit (matching driver: ${r.gpu.cudaRuntime ?? "unknown"}).`,
                );
            } else {
                setInstallResult(`Installed ${r.installed}. Reload health to verify.`);
            }
        } finally {
            setInstalling(null);
        }
    }, [installing]);

    const onRestart = useCallback(async () => {
        if (!window.confirm("Restart the python sidecar? Any in-flight job will be aborted.")) return;
        setInstallResult("Restarting…");
        const r = await restartAnalyzerSidecar(true);
        setInstallResult(r.error ? `Restart failed: ${r.error}` : "Sidecar restarted.");
    }, []);

    return (
        <Card title="System" icon={<Cpu className="h-3.5 w-3.5 text-emerald-300" />}>
            <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                    <span className="text-white/50">Python</span>
                    <span className="font-mono text-white/80">
                        {health?.pythonVersion?.split(" ")[0] ?? "—"}
                    </span>
                </div>
                {health?.pythonPath && (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-white/50">Path</span>
                        <span
                            title={health.pythonPath}
                            className="font-mono text-[10px] text-white/60 truncate max-w-[180px]"
                        >
                            {health.pythonPath}
                        </span>
                    </div>
                )}
                {!health?.ok && health?.reason && (
                    <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
                        <div className="flex items-center gap-1.5 font-medium">
                            <AlertTriangle className="h-3 w-3" />
                            Offline ({healthMisses} miss{healthMisses === 1 ? "" : "es"})
                        </div>
                        <div className="mt-1 text-amber-200/80">{health.reason}</div>
                        <div className="mt-1.5 break-all">
                            <code className="rounded bg-black/30 px-1 py-0.5 text-[10px] text-amber-100">
                                pip install audio-separator[cpu] librosa pyloudnorm pyacoustid soundfile numpy
                            </code>
                        </div>
                    </div>
                )}

                {/* GPU acceleration panel */}
                {gpu && (
                    <div
                        className={cn(
                            "rounded border p-2",
                            gpu.recommendation === "ready"
                                ? "border-emerald-500/30 bg-emerald-500/10"
                                : gpu.recommendation === "no_gpu"
                                  ? "border-white/10 bg-white/5"
                                  : "border-purple-500/30 bg-purple-500/10",
                        )}
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-[11px] font-medium">
                                <Zap className={cn(
                                    "h-3 w-3",
                                    gpu.recommendation === "ready" ? "text-emerald-300" : "text-purple-300",
                                )} />
                                GPU acceleration
                            </div>
                            <span className={cn(
                                "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                                gpu.recommendation === "ready"
                                    ? "bg-emerald-500/20 text-emerald-200"
                                    : gpu.recommendation === "no_gpu"
                                      ? "bg-white/10 text-white/60"
                                      : "bg-amber-500/20 text-amber-200",
                            )}>
                                {gpu.recommendation === "ready" ? "active" :
                                 gpu.recommendation === "no_gpu" ? "no GPU" :
                                 gpu.recommendation === "install_onnx_gpu" ? "needs onnx-gpu" :
                                 "needs CUDA runtime"}
                            </span>
                        </div>
                        <div className="mt-1 space-y-0.5 text-[10px] text-white/70">
                            {gpu.gpuName && (
                                <div className="font-mono text-white/85">{gpu.gpuName}</div>
                            )}
                            {gpu.cudaRuntime && (
                                <div>Driver: <span className="font-mono text-white/60">CUDA {gpu.cudaRuntime}</span></div>
                            )}
                            <div>
                                ONNX:{" "}
                                <span className="font-mono text-white/60">
                                    {gpu.onnxPackage ?? "not installed"}
                                </span>
                                {gpu.onnxProviders.length > 0 && (
                                    <span className="ml-1 text-white/40">
                                        ({gpu.onnxProviders.map((p) => p.replace("ExecutionProvider", "")).join(", ")})
                                    </span>
                                )}
                            </div>
                            <div>
                                Torch CUDA:{" "}
                                <span className={cn(
                                    "font-mono",
                                    gpu.torchCuda ? "text-emerald-300" : "text-white/50",
                                )}>
                                    {gpu.torchCuda ? "available" : "no"}
                                </span>
                            </div>
                        </div>

                        {gpu.recommendation === "install_onnx_gpu" && (
                            <div className="mt-2 space-y-1">
                                <p className="text-[10px] text-white/65">
                                    Your NVIDIA card is detected. Install <code className="font-mono">onnxruntime-gpu</code> to make stems separation 5–15× faster on UVR/Roformer/MDX models. For Demucs (htdemucs_ft) you also need torch CUDA.
                                </p>
                                <div className="flex flex-wrap gap-1">
                                    <button
                                        onClick={() => onInstallGpu("onnx")}
                                        disabled={!!installing}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors",
                                            installing
                                                ? "border-white/10 bg-white/5 text-white/40 cursor-wait"
                                                : "border-purple-400/40 bg-purple-500/15 text-purple-100 hover:bg-purple-500/25",
                                        )}
                                    >
                                        {installing === "onnx" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                                        Install onnx-gpu
                                    </button>
                                    <button
                                        onClick={() => onInstallGpu("torch")}
                                        disabled={!!installing}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors",
                                            installing
                                                ? "border-white/10 bg-white/5 text-white/40 cursor-wait"
                                                : "border-purple-400/40 bg-purple-500/15 text-purple-100 hover:bg-purple-500/25",
                                        )}
                                    >
                                        {installing === "torch" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                                        Install torch-CUDA
                                    </button>
                                    <button
                                        onClick={() => onInstallGpu("all")}
                                        disabled={!!installing}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors",
                                            installing
                                                ? "border-white/10 bg-white/5 text-white/40 cursor-wait"
                                                : "border-emerald-400/40 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25",
                                        )}
                                    >
                                        {installing === "all" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                                        Install all
                                    </button>
                                </div>
                            </div>
                        )}
                        {gpu.recommendation === "install_cuda_runtime" && (
                            <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-1.5 text-[10px] text-amber-100">
                                <strong>Almost there.</strong> onnxruntime-gpu is installed but no GPU provider is registered. Install the <a href="https://developer.nvidia.com/cuda-downloads" target="_blank" rel="noreferrer" className="underline">CUDA Toolkit 12.x</a> and matching <a href="https://developer.nvidia.com/cudnn" target="_blank" rel="noreferrer" className="underline">cuDNN</a>, then click Restart.
                                <button
                                    onClick={onRestart}
                                    className="mt-1 ml-2 inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 hover:bg-white/20"
                                >
                                    <RefreshCw className="h-2.5 w-2.5" /> Restart
                                </button>
                            </div>
                        )}
                        {installResult && (
                            <div className="mt-1.5 rounded bg-black/30 px-1.5 py-1 text-[10px] text-white/70">
                                {installResult}
                            </div>
                        )}
                    </div>
                )}

                <div className="pt-1">
                    <div className="text-[10px] uppercase tracking-wide text-white/40 mb-1">
                        Dependencies
                    </div>
                    <ul className="space-y-1">
                        {items.map((d) => {
                            const ok = !!deps[d.key];
                            return (
                                <li
                                    key={d.key}
                                    className="flex items-center justify-between rounded border border-white/5 bg-white/5 px-2 py-1"
                                >
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={cn(
                                                "h-1.5 w-1.5 rounded-full",
                                                ok ? "bg-emerald-400" : "bg-rose-400",
                                            )}
                                        />
                                        <span className="font-mono text-white/80">{d.label}</span>
                                    </div>
                                    <span className="text-[10px] text-white/40">{d.desc}</span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </Card>
    );
}

// Memoized log row — log entries are immutable (keyed by seq) so React.memo
// short-circuits re-renders when the parent re-renders for status changes.
const LogRow = memo(function LogRow({ entry: l }: { entry: AnalyzerLogEntry }) {
    return (
        <div className="flex gap-2 py-0.5">
            <span className="text-white/30 tabular-nums shrink-0">
                {formatTime(l.ts)}
            </span>
            <span
                className={cn(
                    "uppercase shrink-0",
                    l.level === "error" && "text-rose-400",
                    l.level === "warn" && "text-amber-300",
                    l.level === "info" && "text-emerald-300",
                    l.level === "debug" && "text-white/40",
                )}
            >
                {l.level}
            </span>
            {l.jobId && (
                <span className="text-white/30 shrink-0 truncate max-w-[60px]">
                    {l.jobId.slice(0, 8)}
                </span>
            )}
            <span className="text-white/85 break-words">{l.message}</span>
        </div>
    );
});

function LogConsole({
    logs,
    rawCount,
    filter,
    setFilter,
    autoScroll,
    setAutoScroll,
    onClear,
    scrollRef,
}: {
    logs: AnalyzerLogEntry[];
    rawCount: number;
    filter: "all" | "info" | "warn" | "error";
    setFilter: (f: "all" | "info" | "warn" | "error") => void;
    autoScroll: boolean;
    setAutoScroll: (v: boolean) => void;
    onClear: () => void;
    scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
    return (
        <Card
            title={`Live log (${formatNumber(rawCount)})`}
            icon={<Terminal className="h-3.5 w-3.5 text-emerald-300" />}
            actions={
                <div className="flex items-center gap-1">
                    {(["all", "info", "warn", "error"] as const).map((f) => (
                        <button
                            key={f}
                            onClick={() => setFilter(f)}
                            className={cn(
                                "rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors",
                                filter === f
                                    ? "bg-white/15 text-white"
                                    : "text-white/40 hover:bg-white/10 hover:text-white/70",
                            )}
                        >
                            {f}
                        </button>
                    ))}
                    <span className="mx-1 h-3 w-px bg-white/10" />
                    <button
                        onClick={() => setAutoScroll(!autoScroll)}
                        className={cn(
                            "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors",
                            autoScroll
                                ? "bg-emerald-500/15 text-emerald-300"
                                : "text-white/40 hover:bg-white/10 hover:text-white/70",
                        )}
                        title="Auto-scroll"
                    >
                        {autoScroll ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                        auto
                    </button>
                    <button
                        onClick={onClear}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/40 hover:bg-white/10 hover:text-white/70 transition-colors"
                    >
                        <Trash2 className="h-3 w-3" /> clear
                    </button>
                </div>
            }
        >
            <div
                ref={scrollRef}
                className="h-72 overflow-y-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed"
            >
                {logs.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-white/30">
                        Waiting for events…
                    </div>
                ) : (
                    logs.map((l) => (
                        <LogRow key={l.seq} entry={l} />
                    ))
                )}
            </div>
        </Card>
    );
}

// ─── Primitives ─────────────────────────────────────────────────────

function Card({
    title,
    icon,
    actions,
    children,
}: {
    title: string;
    icon?: React.ReactNode;
    actions?: React.ReactNode;
    children: React.ReactNode;
}) {
    // Plain section (no framer-motion layout). The card mounts once and stays;
    // animating its layout on every parent re-render was forcing FLIP measurements
    // across all child nodes (queue/completed/log lists) every poll tick.
    return (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-white/70">
                    {icon}
                    {title}
                </div>
                {actions}
            </div>
            <div className="p-3">{children}</div>
        </section>
    );
}

function ProgressBar({ value }: { value: number }) {
    const pct = Math.max(0, Math.min(1, value));
    return (
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-white/10">
            <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-purple-500 via-pink-500 to-emerald-400"
                initial={false}
                animate={{ width: `${pct * 100}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 22 }}
            />
            <motion.div
                className="absolute inset-y-0 left-0 w-full rounded-full bg-gradient-to-r from-transparent via-white/25 to-transparent"
                initial={{ x: "-100%" }}
                animate={{ x: "100%" }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
                style={{ width: "30%" }}
            />
        </div>
    );
}

function OptionToggle({
    label,
    desc,
    icon,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    desc: string;
    icon: React.ReactNode;
    checked: boolean;
    disabled?: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <button
            onClick={() => !disabled && onChange(!checked)}
            disabled={disabled}
            title={disabled ? "Dependency not installed" : undefined}
            className={cn(
                "flex w-full items-start gap-2 rounded-md border p-2 text-left transition-all",
                disabled && "cursor-not-allowed opacity-40",
                !disabled && checked
                    ? "border-purple-500/50 bg-purple-500/10"
                    : !disabled && "border-white/10 bg-white/5 hover:bg-white/10",
            )}
        >
            <div
                className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                    checked && !disabled
                        ? "border-purple-500 bg-purple-500"
                        : "border-white/20",
                )}
            >
                {checked && !disabled && (
                    <CheckCircle2 className="h-3 w-3 text-white" />
                )}
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs font-medium text-white/90">
                    {icon}
                    {label}
                </div>
                <div className="text-[10px] text-white/50">{desc}</div>
            </div>
        </button>
    );
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${rem.toString().padStart(2, "0")}s`;
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d
        .getMinutes()
        .toString()
        .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}
