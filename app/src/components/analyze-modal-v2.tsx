"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatNumber } from "@/lib/utils";
import {
    RefreshCw,
    Zap,
    ScanSearch,
    Image,
    Music2,
    Disc3,
    Check,
    CheckCheck,
    XCircle,
    ChevronDown,
    ChevronRight,
    Square,
    CheckSquare,
    MinusSquare,
    Loader2,
    ArrowRight,
    Sparkles,
    Globe,
    AlertCircle,
    Pause,
    Play,
    StopCircle,
    Wifi,
    WifiOff,
    Clock,
    Users,
    Minus,
    Plus,
} from "lucide-react";
import { getAnalysisScope } from "@/actions/analyze";
import type { AnalysisScope } from "@/actions/analyze";
import { useAnalysisContext } from "@/hooks/analysis-context";
import type { AnalysisChange } from "@/hooks/use-analysis";

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
    MusicBrainz: "bg-amber-500/20 text-amber-400",
    "Cover Art Archive": "bg-blue-500/20 text-blue-400",
    iTunes: "bg-pink-500/20 text-pink-400",
    Deezer: "bg-purple-500/20 text-purple-400",
    LRCLIB: "bg-green-500/20 text-green-400",
};

const FIELD_ICONS: Record<string, string> = {
    artworkUrl: "🖼️",
    genre: "🎵",
    album: "💿",
    year: "📅",
    label: "🏷️",
    bpm: "⏱️",
    isrc: "🔢",
    lyrics: "📝",
    syncedLyrics: "🎤",
    musicbrainzId: "🆔",
    releaseMbid: "🆔",
};

interface FetchOptions {
    metadata: boolean;
    artwork: boolean;
    lyrics: boolean;
    bpmKey: boolean;
    skipAnalyzedDays: number | null;
    workers: number;
}

// ─── Derived view from server + local state ──────────────────────────────────

type ModalView = "config" | "analyzing" | "review" | "applying" | "done";

// ─── Component ───────────────────────────────────────────────────────────────

interface AnalyzeModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function AnalyzeModal({ open, onOpenChange }: AnalyzeModalProps) {
    // SSE-backed analysis state from context
    const analysis = useAnalysisContext();

    // Local-only state
    const [localView, setLocalView] = useState<"applying" | "done" | null>(
        null
    );
    const [scope, setScope] = useState<AnalysisScope | null>(null);
    const [mode, setMode] = useState<"quick" | "full">("quick");
    const [options, setOptions] = useState<FetchOptions>({
        metadata: true,
        artwork: true,
        lyrics: true,
        bpmKey: true,
        skipAnalyzedDays: 7,
        workers: 1,
    });

    // Changes for review (loaded from DB)
    const [changes, setChanges] = useState<AnalysisChange[]>([]);
    const [changesLoaded, setChanagesLoaded] = useState(false);

    // Review state
    const [filter, setFilter] = useState<string>("all");
    const [expandedTracks, setExpandedTracks] = useState<Set<number>>(
        new Set()
    );

    // Apply state
    const [applyProgress, setApplyProgress] = useState(0);
    const [applyTotal, setApplyTotal] = useState(0);
    const [applyResult, setApplyResult] = useState<{
        applied: number;
        errors: number;
    } | null>(null);

    // Derive the current view
    const view: ModalView = (() => {
        if (localView) return localView;
        if (
            analysis.status === "running" ||
            analysis.status === "paused"
        )
            return "analyzing";
        if (
            analysis.status === "completed" ||
            analysis.status === "stopped"
        )
            return "review";
        return "config";
    })();

    // Load scope on open (config view)
    useEffect(() => {
        if (open && view === "config") {
            getAnalysisScope().then(setScope);
        }
    }, [open, view]);

    // Load changes from DB when entering review state
    useEffect(() => {
        if (
            view === "review" &&
            analysis.jobId &&
            !changesLoaded
        ) {
            analysis
                .fetchChanges(analysis.jobId)
                .then((loaded) => {
                    setChanges(loaded);
                    setChanagesLoaded(true);
                });
        }
    }, [view, analysis.jobId, changesLoaded, analysis]);

    // Reset local state when modal closes
    useEffect(() => {
        if (!open) {
            setLocalView(null);
            setChanges([]);
            setChanagesLoaded(false);
            setFilter("all");
            setExpandedTracks(new Set());
            setApplyResult(null);
        }
    }, [open]);

    // ─── Actions ─────────────────────────────────────────────────────────

    const startAnalysis = useCallback(async () => {
        setLocalView(null);
        setChanagesLoaded(false);
        setChanges([]);
        await analysis.start(mode, options);
    }, [analysis, mode, options]);

    const handlePause = useCallback(async () => {
        await analysis.pause();
    }, [analysis]);

    const handleResume = useCallback(async () => {
        await analysis.resume();
    }, [analysis]);

    const handleStop = useCallback(async () => {
        await analysis.stop();
    }, [analysis]);

    const handleClose = useCallback(async () => {
        if (analysis.status === "idle") {
            onOpenChange(false);
        } else if (
            analysis.status === "completed" ||
            analysis.status === "stopped"
        ) {
            await analysis.reset();
            onOpenChange(false);
        } else {
            onOpenChange(false);
        }
    }, [analysis, onOpenChange]);

    const handleDone = useCallback(async () => {
        await analysis.reset();
        onOpenChange(false);
        window.location.reload();
    }, [analysis, onOpenChange]);

    // ─── Review Logic ────────────────────────────────────────────────────

    const toggleChange = (changeId: number) => {
        setChanges((prev) =>
            prev.map((c) =>
                c.id === changeId ? { ...c, checked: !c.checked } : c
            )
        );
    };

    const selectAll = () => {
        setChanges((prev) => prev.map((c) => ({ ...c, checked: true })));
    };

    const deselectAll = () => {
        setChanges((prev) => prev.map((c) => ({ ...c, checked: false })));
    };

    const toggleTrackExpand = (trackId: number) => {
        setExpandedTracks((prev) => {
            const next = new Set(prev);
            if (next.has(trackId)) next.delete(trackId);
            else next.add(trackId);
            return next;
        });
    };

    // ─── Apply Logic ─────────────────────────────────────────────────────

    const handleApply = useCallback(async () => {
        const selected = changes.filter((c) => c.checked);
        if (selected.length === 0) return;

        setLocalView("applying");
        setApplyTotal(selected.length);
        setApplyProgress(0);

        // Apply in batches of 50 IDs
        const batchSize = 50;
        let totalApplied = 0;
        let totalErrors = 0;

        for (let i = 0; i < selected.length; i += batchSize) {
            const batch = selected.slice(i, i + batchSize);
            const changeIds = batch.map((c) => c.id);

            const result = await analysis.applyChanges(changeIds);
            totalApplied += result.applied;
            totalErrors += result.errors;
            setApplyProgress(Math.min(i + batchSize, selected.length));
        }

        setApplyResult({ applied: totalApplied, errors: totalErrors });
        setLocalView("done");
    }, [changes, analysis]);

    // ─── Filtered Changes ────────────────────────────────────────────────

    const filteredChanges =
        filter === "all"
            ? changes
            : changes.filter((c) => {
                if (filter === "metadata")
                    return [
                        "genre",
                        "album",
                        "year",
                        "label",
                        "isrc",
                        "musicbrainzId",
                        "releaseMbid",
                    ].includes(c.field);
                if (filter === "artwork") return c.field === "artworkUrl";
                if (filter === "lyrics")
                    return (
                        c.field === "lyrics" || c.field === "syncedLyrics"
                    );
                if (filter === "bpm") return c.field === "bpm";
                return true;
            });

    // Group by track
    const groupedChanges = new Map<
        number,
        {
            artist: string;
            title: string;
            changes: AnalysisChange[];
        }
    >();
    for (const change of filteredChanges) {
        const existing = groupedChanges.get(change.trackId);
        if (existing) {
            existing.changes.push(change);
        } else {
            groupedChanges.set(change.trackId, {
                artist: change.trackArtist,
                title: change.trackTitle,
                changes: [change],
            });
        }
    }

    const selectedCount = changes.filter((c) => c.checked).length;
    const uniqueTracksWithChanges = new Set(
        changes.map((c) => c.trackId)
    ).size;

    const progressPct =
        analysis.total > 0
            ? Math.round((analysis.progress / analysis.total) * 100)
            : 0;
    const applyPct =
        applyTotal > 0
            ? Math.round((applyProgress / applyTotal) * 100)
            : 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
                {/* Header */}
                <DialogHeader className="px-6 pt-6 pb-4 border-b border-[var(--border)] shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20">
                            <Sparkles className="h-4 w-4 text-purple-400" />
                        </div>
                        <span>
                            {view === "config" && "Reanalyze Library"}
                            {view === "analyzing" && (
                                <>
                                    {analysis.status === "paused"
                                        ? "Paused"
                                        : "Analyzing..."}
                                </>
                            )}
                            {view === "review" && "Review Changes"}
                            {view === "applying" && "Applying Changes..."}
                            {view === "done" && "Analysis Complete"}
                        </span>
                        {/* SSE connection indicator */}
                        {view === "analyzing" && (
                            <span className="ml-auto">
                                {analysis.connected ? (
                                    <Wifi className="h-3.5 w-3.5 text-green-400" />
                                ) : (
                                    <WifiOff className="h-3.5 w-3.5 text-rose-400" />
                                )}
                            </span>
                        )}
                    </DialogTitle>
                </DialogHeader>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-6 py-4">
                    {/* ─── Config ─── */}
                    {view === "config" && (
                        <div className="space-y-6">
                            {/* Scope Stats */}
                            {scope && (
                                <div className="grid grid-cols-3 gap-3">
                                    {[
                                        {
                                            label: "Total Tracks",
                                            value: scope.total,
                                            icon: "🎵",
                                        },
                                        {
                                            label: "Missing Artwork",
                                            value: scope.missingArtwork,
                                            icon: "🖼️",
                                        },
                                        {
                                            label: "Missing Lyrics",
                                            value: scope.missingLyrics,
                                            icon: "📝",
                                        },
                                        {
                                            label: "Missing Genre",
                                            value: scope.missingGenre,
                                            icon: "🎶",
                                        },
                                        {
                                            label: "Missing BPM",
                                            value: scope.missingBpm,
                                            icon: "⏱️",
                                        },
                                        {
                                            label: "Recently Analyzed",
                                            value: scope.recentlyAnalyzed,
                                            icon: "✅",
                                        },
                                    ].map((s) => (
                                        <div
                                            key={s.label}
                                            className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 p-3 text-center"
                                        >
                                            <div className="text-lg">
                                                {s.icon}
                                            </div>
                                            <div className="text-lg font-bold tabular-nums">
                                                {formatNumber(s.value)}
                                            </div>
                                            <div className="text-[10px] text-[var(--muted-foreground)]">
                                                {s.label}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Mode */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium">
                                    Scan Mode
                                </label>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setMode("quick")}
                                        className={cn(
                                            "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all cursor-pointer",
                                            mode === "quick"
                                                ? "border-purple-500 bg-purple-500/10"
                                                : "border-[var(--border)] hover:border-[var(--foreground)]/20"
                                        )}
                                    >
                                        <Zap
                                            className={cn(
                                                "h-5 w-5",
                                                mode === "quick"
                                                    ? "text-purple-400"
                                                    : "text-[var(--muted-foreground)]"
                                            )}
                                        />
                                        <span className="text-sm font-medium">
                                            Quick Scan
                                        </span>
                                        <span className="text-[10px] text-[var(--muted-foreground)] text-center">
                                            Only tracks missing metadata
                                        </span>
                                    </button>
                                    <button
                                        onClick={() => setMode("full")}
                                        className={cn(
                                            "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all cursor-pointer",
                                            mode === "full"
                                                ? "border-purple-500 bg-purple-500/10"
                                                : "border-[var(--border)] hover:border-[var(--foreground)]/20"
                                        )}
                                    >
                                        <ScanSearch
                                            className={cn(
                                                "h-5 w-5",
                                                mode === "full"
                                                    ? "text-purple-400"
                                                    : "text-[var(--muted-foreground)]"
                                            )}
                                        />
                                        <span className="text-sm font-medium">
                                            Full Rescan
                                        </span>
                                        <span className="text-[10px] text-[var(--muted-foreground)] text-center">
                                            All tracks, update everything
                                        </span>
                                    </button>
                                </div>
                            </div>

                            {/* Options */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium">
                                    What to Fetch
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                    {[
                                        {
                                            key: "metadata" as const,
                                            label: "Metadata",
                                            desc: "Genre, album, year, label, ISRC",
                                            icon: Globe,
                                        },
                                        {
                                            key: "artwork" as const,
                                            label: "Artwork",
                                            desc: "Album covers from multiple sources",
                                            icon: Image,
                                        },
                                        {
                                            key: "lyrics" as const,
                                            label: "Lyrics",
                                            desc: "Plain + synced lyrics from LRCLIB",
                                            icon: Music2,
                                        },
                                        {
                                            key: "bpmKey" as const,
                                            label: "BPM",
                                            desc: "BPM data from Deezer",
                                            icon: Disc3,
                                        },
                                    ].map((opt) => (
                                        <button
                                            key={opt.key}
                                            onClick={() =>
                                                setOptions((prev) => ({
                                                    ...prev,
                                                    [opt.key]: !prev[opt.key],
                                                }))
                                            }
                                            className={cn(
                                                "flex items-start gap-3 rounded-lg border p-3 text-left transition-all cursor-pointer",
                                                options[opt.key]
                                                    ? "border-purple-500/50 bg-purple-500/5"
                                                    : "border-[var(--border)] opacity-60"
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    "mt-0.5 flex h-4 w-4 items-center justify-center rounded border transition-colors shrink-0",
                                                    options[opt.key]
                                                        ? "bg-purple-500 border-purple-500"
                                                        : "border-[var(--border)]"
                                                )}
                                            >
                                                {options[opt.key] && (
                                                    <Check className="h-3 w-3 text-white" />
                                                )}
                                            </div>
                                            <div>
                                                <div className="text-sm font-medium flex items-center gap-1.5">
                                                    <opt.icon className="h-3.5 w-3.5" />
                                                    {opt.label}
                                                </div>
                                                <div className="text-[10px] text-[var(--muted-foreground)]">
                                                    {opt.desc}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Services info */}
                            <div className="space-y-3">
                                {/* Skip recently analyzed */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium flex items-center gap-1.5">
                                        <Clock className="h-3.5 w-3.5" /> Skip
                                        Recently Analyzed
                                    </label>
                                    <div className="flex flex-wrap gap-2">
                                        {[
                                            {
                                                label: "Don't Skip",
                                                value: null,
                                            },
                                            { label: "1 day", value: 1 },
                                            { label: "7 days", value: 7 },
                                            { label: "30 days", value: 30 },
                                            { label: "90 days", value: 90 },
                                        ].map((opt) => (
                                            <button
                                                key={opt.label}
                                                onClick={() =>
                                                    setOptions((prev) => ({
                                                        ...prev,
                                                        skipAnalyzedDays:
                                                            opt.value,
                                                    }))
                                                }
                                                className={cn(
                                                    "rounded-lg border px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
                                                    options.skipAnalyzedDays ===
                                                        opt.value
                                                        ? "border-purple-500 bg-purple-500/10 text-purple-400"
                                                        : "border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--foreground)]/20"
                                                )}
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-[var(--muted-foreground)]">
                                        {options.skipAnalyzedDays
                                            ? `Tracks analyzed in the last ${options.skipAnalyzedDays} day${options.skipAnalyzedDays > 1 ? "s" : ""} will be skipped`
                                            : "All matching tracks will be processed"}
                                    </p>
                                </div>

                                {/* Parallel workers */}
                                <div className="space-y-2">
                                    <label className="text-sm font-medium flex items-center gap-1.5">
                                        <Users className="h-3.5 w-3.5" />{" "}
                                        Parallel Workers
                                    </label>
                                    <div className="flex items-center gap-3">
                                        <button
                                            onClick={() =>
                                                setOptions((prev) => ({
                                                    ...prev,
                                                    workers: Math.max(
                                                        1,
                                                        prev.workers - 1
                                                    ),
                                                }))
                                            }
                                            disabled={options.workers <= 1}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                            <Minus className="h-3.5 w-3.5" />
                                        </button>
                                        <div className="flex items-center gap-1">
                                            {[1, 2, 3, 4, 5].map((w) => (
                                                <button
                                                    key={w}
                                                    onClick={() =>
                                                        setOptions((prev) => ({
                                                            ...prev,
                                                            workers: w,
                                                        }))
                                                    }
                                                    className={cn(
                                                        "flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold transition-all cursor-pointer",
                                                        options.workers === w
                                                            ? "bg-purple-500 text-white"
                                                            : "border border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--foreground)]/20"
                                                    )}
                                                >
                                                    {w}
                                                </button>
                                            ))}
                                        </div>
                                        <button
                                            onClick={() =>
                                                setOptions((prev) => ({
                                                    ...prev,
                                                    workers: Math.min(
                                                        5,
                                                        prev.workers + 1
                                                    ),
                                                }))
                                            }
                                            disabled={options.workers >= 5}
                                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-[var(--muted-foreground)]">
                                        {options.workers === 1
                                            ? "Sequential processing — safest, respects all rate limits"
                                            : `${options.workers} tracks processed in parallel — faster but uses more API calls`}
                                    </p>
                                </div>
                            </div>

                            {/* Free services info */}
                            <div className="rounded-lg bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)]">
                                <div className="flex items-center gap-1.5 mb-1.5 font-medium text-[var(--foreground)]">
                                    <Globe className="h-3 w-3" /> Free Services
                                    Used
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {[
                                        "MusicBrainz",
                                        "Cover Art Archive",
                                        "iTunes",
                                        "Deezer",
                                        "LRCLIB",
                                    ].map((s) => (
                                        <Badge
                                            key={s}
                                            className={cn(
                                                "text-[10px]",
                                                SOURCE_COLORS[s]
                                            )}
                                        >
                                            {s}
                                        </Badge>
                                    ))}
                                </div>
                                <p className="mt-1.5">
                                    Rate limited to respect API limits. ~5
                                    tracks/batch with 1s delay between
                                    MusicBrainz calls.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* ─── Analyzing ─── */}
                    {view === "analyzing" && (
                        <div className="space-y-6 py-4">
                            {/* Paused banner */}
                            {analysis.status === "paused" && (
                                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                                    <Pause className="h-4 w-4 text-amber-400" />
                                    <span className="text-sm text-amber-400 font-medium">
                                        Analysis paused
                                    </span>
                                    <span className="text-xs text-[var(--muted-foreground)]">
                                        — You can safely close this tab. Progress
                                        is saved.
                                    </span>
                                </div>
                            )}

                            {/* Progress */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="text-[var(--muted-foreground)]">
                                        {analysis.status === "paused"
                                            ? "Paused at"
                                            : "Analyzing"}{" "}
                                        track{" "}
                                        {formatNumber(analysis.progress)} of{" "}
                                        {formatNumber(analysis.total)}
                                    </span>
                                    <span className="font-mono font-bold text-purple-400">
                                        {progressPct}%
                                    </span>
                                </div>
                                <div className="h-3 rounded-full bg-[var(--secondary)] overflow-hidden">
                                    <div
                                        className={cn(
                                            "h-full rounded-full transition-[width] duration-500 ease-out",
                                            analysis.status === "paused"
                                                ? "bg-gradient-to-r from-amber-500 to-orange-500"
                                                : "bg-gradient-to-r from-purple-500 to-pink-500"
                                        )}
                                        style={{
                                            width: `${progressPct}%`,
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Current track */}
                            {analysis.currentTrack && (
                                <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 p-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20">
                                        {analysis.status === "paused" ? (
                                            <Pause className="h-4 w-4 text-amber-400" />
                                        ) : (
                                            <RefreshCw className="h-4 w-4 text-purple-400 animate-spin" />
                                        )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium truncate">
                                            {analysis.currentTrack}
                                        </p>
                                        <p className="text-[10px] text-[var(--muted-foreground)]">
                                            {analysis.status === "paused"
                                                ? "Waiting to resume..."
                                                : "Querying MusicBrainz, iTunes, Deezer, LRCLIB..."}
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Live stats */}
                            <div className="grid grid-cols-3 gap-3 text-center">
                                <div className="rounded-lg border border-[var(--border)] p-3">
                                    <div className="text-2xl font-bold text-green-400 tabular-nums">
                                        {analysis.changesCount}
                                    </div>
                                    <div className="text-[10px] text-[var(--muted-foreground)]">
                                        Updates Found
                                    </div>
                                </div>
                                <div className="rounded-lg border border-[var(--border)] p-3">
                                    <div className="text-2xl font-bold text-purple-400 tabular-nums">
                                        {analysis.progress}
                                    </div>
                                    <div className="text-[10px] text-[var(--muted-foreground)]">
                                        Tracks Scanned
                                    </div>
                                </div>
                                <div className="rounded-lg border border-[var(--border)] p-3">
                                    <div className="text-2xl font-bold text-rose-400 tabular-nums">
                                        {analysis.errorsCount}
                                    </div>
                                    <div className="text-[10px] text-[var(--muted-foreground)]">
                                        Errors
                                    </div>
                                </div>
                            </div>

                            {/* API activity */}
                            {analysis.status === "running" && (
                                <div className="flex flex-wrap gap-2">
                                    {[
                                        "MusicBrainz",
                                        "iTunes",
                                        "Deezer",
                                        "LRCLIB",
                                        "Cover Art Archive",
                                    ].map((api) => (
                                        <div
                                            key={api}
                                            className="flex items-center gap-1.5 text-xs"
                                        >
                                            <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                                            <span className="text-[var(--muted-foreground)]">
                                                {api}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Info banner */}
                            <div className="rounded-lg bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)]">
                                <div className="flex items-center gap-1.5 mb-1">
                                    <Globe className="h-3 w-3" />
                                    <span className="font-medium text-[var(--foreground)]">
                                        Background Processing
                                    </span>
                                </div>
                                <p>
                                    Analysis runs in the background. You can close
                                    this dialog, navigate away, or even refresh the
                                    page — progress is automatically saved and
                                    restored.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* ─── Review ─── */}
                    {view === "review" && (
                        <div className="space-y-4">
                            {!changesLoaded ? (
                                <div className="flex items-center justify-center py-12">
                                    <Loader2 className="h-6 w-6 text-purple-400 animate-spin" />
                                    <span className="ml-2 text-sm text-[var(--muted-foreground)]">
                                        Loading changes...
                                    </span>
                                </div>
                            ) : (
                                <>
                                    {/* Summary */}
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm">
                                            <span className="font-medium">
                                                {changes.length} changes
                                            </span>{" "}
                                            <span className="text-[var(--muted-foreground)]">
                                                across{" "}
                                                {uniqueTracksWithChanges}{" "}
                                                tracks
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={selectAll}
                                                className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer"
                                            >
                                                Select All
                                            </button>
                                            <span className="text-xs text-[var(--muted-foreground)]">
                                                |
                                            </span>
                                            <button
                                                onClick={deselectAll}
                                                className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                                            >
                                                Deselect All
                                            </button>
                                        </div>
                                    </div>

                                    {/* Filter tabs */}
                                    <div className="flex gap-1.5 border-b border-[var(--border)] pb-2">
                                        {[
                                            {
                                                key: "all",
                                                label: "All",
                                                count: changes.length,
                                            },
                                            {
                                                key: "metadata",
                                                label: "Metadata",
                                                count: changes.filter((c) =>
                                                    [
                                                        "genre",
                                                        "album",
                                                        "year",
                                                        "label",
                                                        "isrc",
                                                        "musicbrainzId",
                                                        "releaseMbid",
                                                    ].includes(c.field)
                                                ).length,
                                            },
                                            {
                                                key: "artwork",
                                                label: "Artwork",
                                                count: changes.filter(
                                                    (c) =>
                                                        c.field ===
                                                        "artworkUrl"
                                                ).length,
                                            },
                                            {
                                                key: "lyrics",
                                                label: "Lyrics",
                                                count: changes.filter((c) =>
                                                    [
                                                        "lyrics",
                                                        "syncedLyrics",
                                                    ].includes(c.field)
                                                ).length,
                                            },
                                            {
                                                key: "bpm",
                                                label: "BPM",
                                                count: changes.filter(
                                                    (c) => c.field === "bpm"
                                                ).length,
                                            },
                                        ].map((tab) => (
                                            <button
                                                key={tab.key}
                                                onClick={() =>
                                                    setFilter(tab.key)
                                                }
                                                className={cn(
                                                    "px-3 py-1 rounded-md text-xs transition-colors cursor-pointer",
                                                    filter === tab.key
                                                        ? "bg-purple-500/20 text-purple-400"
                                                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                                                )}
                                            >
                                                {tab.label}
                                                {tab.count > 0 && (
                                                    <span className="ml-1 tabular-nums">
                                                        ({tab.count})
                                                    </span>
                                                )}
                                            </button>
                                        ))}
                                    </div>

                                    {/* Changes list */}
                                    {changes.length === 0 ? (
                                        <div className="text-center py-12 text-[var(--muted-foreground)]">
                                            <ScanSearch className="h-10 w-10 mx-auto mb-3 opacity-50" />
                                            {analysis.total === 0 ? (
                                                <>
                                                    <p className="text-sm font-medium">
                                                        No tracks to analyze
                                                    </p>
                                                    <p className="text-xs mt-1">
                                                        All tracks were skipped
                                                        because they were
                                                        recently analyzed. Try
                                                        with a shorter skip
                                                        period or disable
                                                        &quot;Skip recently
                                                        analyzed&quot;.
                                                    </p>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="mt-4"
                                                        onClick={async () => {
                                                            await analysis.reset();
                                                            setLocalView(null);
                                                        }}
                                                    >
                                                        Back to Settings
                                                    </Button>
                                                </>
                                            ) : (
                                                <>
                                                    <p className="text-sm">
                                                        No changes found
                                                    </p>
                                                    <p className="text-xs mt-1">
                                                        All your library
                                                        metadata is already up
                                                        to date!
                                                    </p>
                                                </>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="space-y-1">
                                            {Array.from(
                                                groupedChanges.entries()
                                            ).map(([trackId, group]) => {
                                                const isExpanded =
                                                    expandedTracks.has(
                                                        trackId
                                                    );
                                                const allChecked =
                                                    group.changes.every(
                                                        (c) => c.checked
                                                    );
                                                const someChecked =
                                                    group.changes.some(
                                                        (c) => c.checked
                                                    );

                                                return (
                                                    <div
                                                        key={trackId}
                                                        className="rounded-lg border border-[var(--border)] overflow-hidden"
                                                    >
                                                        {/* Track row */}
                                                        <button
                                                            onClick={() =>
                                                                toggleTrackExpand(
                                                                    trackId
                                                                )
                                                            }
                                                            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[var(--accent)] transition-colors cursor-pointer"
                                                        >
                                                            <div
                                                                onClick={(
                                                                    e
                                                                ) => {
                                                                    e.stopPropagation();
                                                                    const newVal =
                                                                        !allChecked;
                                                                    setChanges(
                                                                        (
                                                                            prev
                                                                        ) =>
                                                                            prev.map(
                                                                                (
                                                                                    c
                                                                                ) =>
                                                                                    c.trackId ===
                                                                                        trackId
                                                                                        ? {
                                                                                            ...c,
                                                                                            checked:
                                                                                                newVal,
                                                                                        }
                                                                                        : c
                                                                            )
                                                                    );
                                                                }}
                                                                className="cursor-pointer"
                                                            >
                                                                {allChecked ? (
                                                                    <CheckSquare className="h-4 w-4 text-purple-400" />
                                                                ) : someChecked ? (
                                                                    <MinusSquare className="h-4 w-4 text-purple-400/60" />
                                                                ) : (
                                                                    <Square className="h-4 w-4 text-[var(--muted-foreground)]" />
                                                                )}
                                                            </div>
                                                            {isExpanded ? (
                                                                <ChevronDown className="h-3 w-3 text-[var(--muted-foreground)]" />
                                                            ) : (
                                                                <ChevronRight className="h-3 w-3 text-[var(--muted-foreground)]" />
                                                            )}
                                                            <div className="min-w-0 flex-1 truncate text-sm">
                                                                <span className="font-medium">
                                                                    {
                                                                        group.artist
                                                                    }
                                                                </span>
                                                                <span className="text-[var(--muted-foreground)]">
                                                                    {" "}
                                                                    —{" "}
                                                                </span>
                                                                <span>
                                                                    {
                                                                        group.title
                                                                    }
                                                                </span>
                                                            </div>
                                                            <Badge className="text-[10px] bg-[var(--secondary)] text-[var(--muted-foreground)]">
                                                                {
                                                                    group
                                                                        .changes
                                                                        .length
                                                                }{" "}
                                                                change
                                                                {group.changes
                                                                    .length !==
                                                                    1
                                                                    ? "s"
                                                                    : ""}
                                                            </Badge>
                                                        </button>

                                                        {/* Expanded changes */}
                                                        {isExpanded && (
                                                            <div className="border-t border-[var(--border)] bg-[var(--secondary)]/20">
                                                                {group.changes.map(
                                                                    (
                                                                        change
                                                                    ) => (
                                                                        <div
                                                                            key={`${change.trackId}-${change.field}`}
                                                                            className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent)]/50"
                                                                        >
                                                                            <button
                                                                                onClick={() =>
                                                                                    toggleChange(
                                                                                        change.id
                                                                                    )
                                                                                }
                                                                                className="cursor-pointer"
                                                                            >
                                                                                {change.checked ? (
                                                                                    <CheckSquare className="h-3.5 w-3.5 text-purple-400" />
                                                                                ) : (
                                                                                    <Square className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                                                                                )}
                                                                            </button>
                                                                            <span className="w-4 text-center">
                                                                                {FIELD_ICONS[
                                                                                    change
                                                                                        .field
                                                                                ] ||
                                                                                    "📋"}
                                                                            </span>
                                                                            <span className="w-24 font-medium text-[var(--foreground)]">
                                                                                {
                                                                                    change.fieldLabel
                                                                                }
                                                                            </span>
                                                                            <span className="text-[var(--muted-foreground)] truncate max-w-[120px]">
                                                                                {change.oldValue ||
                                                                                    "—"}
                                                                            </span>
                                                                            <ArrowRight className="h-3 w-3 text-purple-400 shrink-0" />
                                                                            <span className="text-green-400 truncate max-w-[120px] font-medium">
                                                                                {
                                                                                    change.newValueDisplay
                                                                                }
                                                                            </span>
                                                                            <Badge
                                                                                className={cn(
                                                                                    "text-[9px] ml-auto shrink-0",
                                                                                    SOURCE_COLORS[
                                                                                    change
                                                                                        .source
                                                                                    ] ||
                                                                                    "bg-zinc-500/20 text-zinc-400"
                                                                                )}
                                                                            >
                                                                                {
                                                                                    change.source
                                                                                }
                                                                            </Badge>
                                                                        </div>
                                                                    )
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* Errors */}
                                    {analysis.errors.length > 0 && (
                                        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
                                            <div className="flex items-center gap-1.5 text-xs font-medium text-rose-400 mb-1">
                                                <AlertCircle className="h-3 w-3" />
                                                {analysis.errorsCount} error
                                                {analysis.errorsCount !== 1
                                                    ? "s"
                                                    : ""}{" "}
                                                during analysis
                                            </div>
                                            <div className="max-h-20 overflow-y-auto text-[10px] text-rose-300/70 space-y-0.5">
                                                {analysis.errors
                                                    .slice(0, 10)
                                                    .map((err, i) => (
                                                        <div
                                                            key={i}
                                                            className="truncate"
                                                        >
                                                            {err}
                                                        </div>
                                                    ))}
                                                {analysis.errors.length >
                                                    10 && (
                                                        <div>
                                                            ...and{" "}
                                                            {analysis.errors
                                                                .length - 10}{" "}
                                                            more
                                                        </div>
                                                    )}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    {/* ─── Applying ─── */}
                    {view === "applying" && (
                        <div className="space-y-6 py-8">
                            <div className="text-center">
                                <Loader2 className="h-10 w-10 text-purple-400 animate-spin mx-auto mb-4" />
                                <p className="text-sm text-[var(--muted-foreground)]">
                                    Applying change {applyProgress} of{" "}
                                    {applyTotal}...
                                </p>
                            </div>
                            <div className="h-3 rounded-full bg-[var(--secondary)] overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-500 transition-[width] duration-300"
                                    style={{ width: `${applyPct}%` }}
                                />
                            </div>
                        </div>
                    )}

                    {/* ─── Done ─── */}
                    {view === "done" && applyResult && (
                        <div className="py-8 text-center space-y-4">
                            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 mx-auto">
                                <CheckCheck className="h-8 w-8 text-green-400" />
                            </div>
                            <div>
                                <p className="text-lg font-semibold">
                                    Changes Applied!
                                </p>
                                <p className="text-sm text-[var(--muted-foreground)] mt-1">
                                    Successfully updated{" "}
                                    <span className="text-green-400 font-medium">
                                        {applyResult.applied}
                                    </span>{" "}
                                    fields
                                    {applyResult.errors > 0 && (
                                        <>
                                            {" "}
                                            ·{" "}
                                            <span className="text-rose-400">
                                                {applyResult.errors} errors
                                            </span>
                                        </>
                                    )}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[var(--border)] flex items-center justify-between shrink-0">
                    {view === "config" && (
                        <>
                            <Button
                                variant="ghost"
                                onClick={handleClose}
                                className="cursor-pointer"
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={startAnalysis}
                                disabled={
                                    !options.metadata &&
                                    !options.artwork &&
                                    !options.lyrics &&
                                    !options.bpmKey
                                }
                                className="gap-2 bg-purple-600 hover:bg-purple-700 text-white cursor-pointer"
                            >
                                <ScanSearch className="h-4 w-4" />
                                Start Analysis
                            </Button>
                        </>
                    )}
                    {view === "analyzing" && (
                        <>
                            <div className="text-xs text-[var(--muted-foreground)]">
                                {analysis.changesCount} updates found so far
                            </div>
                            <div className="flex gap-2">
                                {analysis.status === "running" && (
                                    <Button
                                        variant="outline"
                                        onClick={handlePause}
                                        className="gap-2 cursor-pointer"
                                    >
                                        <Pause className="h-4 w-4" />
                                        Pause
                                    </Button>
                                )}
                                {analysis.status === "paused" && (
                                    <Button
                                        variant="outline"
                                        onClick={handleResume}
                                        className="gap-2 border-green-500/30 hover:bg-green-500/10 hover:text-green-400 cursor-pointer"
                                    >
                                        <Play className="h-4 w-4" />
                                        Resume
                                    </Button>
                                )}
                                <Button
                                    variant="outline"
                                    onClick={handleStop}
                                    className="gap-2 cursor-pointer"
                                >
                                    <StopCircle className="h-4 w-4" />
                                    Stop & Review
                                </Button>
                            </div>
                        </>
                    )}
                    {view === "review" && (
                        <>
                            <div className="text-xs text-[var(--muted-foreground)]">
                                {changes.length > 0 && `${selectedCount} of ${changes.length} selected`}
                            </div>
                            <div className="flex gap-2">
                                {changes.length === 0 && analysis.total === 0 ? (
                                    <Button
                                        variant="ghost"
                                        onClick={async () => {
                                            await analysis.reset();
                                            setLocalView(null);
                                        }}
                                        className="cursor-pointer"
                                    >
                                        Back to Settings
                                    </Button>
                                ) : (
                                    <>
                                        <Button
                                            variant="ghost"
                                            onClick={handleClose}
                                            className="cursor-pointer"
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            onClick={handleApply}
                                            disabled={selectedCount === 0}
                                            className="gap-2 bg-green-600 hover:bg-green-700 text-white cursor-pointer"
                                        >
                                            <Check className="h-4 w-4" />
                                            Apply {selectedCount} Changes
                                        </Button>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                    {view === "done" && (
                        <div className="ml-auto">
                            <Button
                                onClick={handleDone}
                                className="gap-2 cursor-pointer"
                            >
                                <Check className="h-4 w-4" />
                                Done
                            </Button>
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
