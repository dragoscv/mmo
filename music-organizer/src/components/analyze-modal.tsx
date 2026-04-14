"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
} from "lucide-react";
import type {
  AnalysisChange,
  AnalysisBatchResult,
  AnalysisScope,
} from "@/actions/analyze";
import {
  getAnalysisScope,
  analyzeTrackBatch,
  applyAnalysisChanges,
} from "@/actions/analyze";

// ─── Types ───────────────────────────────────────────────────────────────────

type ModalState = "config" | "analyzing" | "review" | "applying" | "done";

interface FetchOptions {
  metadata: boolean;
  artwork: boolean;
  lyrics: boolean;
  bpmKey: boolean;
}

// ─── Source Colors ───────────────────────────────────────────────────────────

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

const BATCH_SIZE = 5;

// ─── Component ───────────────────────────────────────────────────────────────

interface AnalyzeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AnalyzeModal({ open, onOpenChange }: AnalyzeModalProps) {
  const [state, setState] = useState<ModalState>("config");
  const [scope, setScope] = useState<AnalysisScope | null>(null);
  const [mode, setMode] = useState<"quick" | "full">("quick");
  const [options, setOptions] = useState<FetchOptions>({
    metadata: true,
    artwork: true,
    lyrics: true,
    bpmKey: true,
  });

  // Analysis state
  const [changes, setChanges] = useState<AnalysisChange[]>([]);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentTrack, setCurrentTrack] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const abortRef = useRef(false);

  // Review state
  const [filter, setFilter] = useState<string>("all");
  const [expandedTracks, setExpandedTracks] = useState<Set<number>>(new Set());

  // Apply state
  const [applyProgress, setApplyProgress] = useState(0);
  const [applyTotal, setApplyTotal] = useState(0);
  const [applyResult, setApplyResult] = useState<{
    applied: number;
    errors: number;
  } | null>(null);

  // Load scope on open
  useEffect(() => {
    if (open) {
      setState("config");
      setChanges([]);
      setProgress(0);
      setErrors([]);
      abortRef.current = false;
      getAnalysisScope().then(setScope);
    }
  }, [open]);

  // ─── Analysis Logic ──────────────────────────────────────────────────────

  const startAnalysis = useCallback(async () => {
    setState("analyzing");
    setChanges([]);
    setProgress(0);
    setErrors([]);
    abortRef.current = false;

    let offset = 0;
    let finished = false;

    while (!finished && !abortRef.current) {
      try {
        const result: AnalysisBatchResult = await analyzeTrackBatch(
          offset,
          BATCH_SIZE,
          mode,
          options
        );

        setChanges((prev) => [...prev, ...result.changes]);
        setProgress(result.processed);
        setTotal(result.total);
        setCurrentTrack(result.currentTrack);
        if (result.errors.length > 0) {
          setErrors((prev) => [...prev, ...result.errors]);
        }

        offset += BATCH_SIZE;
        finished = result.processed >= result.total;
      } catch (err) {
        setErrors((prev) => [
          ...prev,
          `Batch error at offset ${offset}: ${err instanceof Error ? err.message : "Unknown"}`,
        ]);
        offset += BATCH_SIZE; // Skip failed batch
      }
    }

    if (!abortRef.current) {
      setState("review");
    }
  }, [mode, options]);

  const stopAnalysis = useCallback(() => {
    abortRef.current = true;
    setState("review");
  }, []);

  // ─── Review Logic ────────────────────────────────────────────────────────

  const toggleChange = (trackId: number, field: string) => {
    setChanges((prev) =>
      prev.map((c) =>
        c.trackId === trackId && c.field === field
          ? { ...c, checked: !c.checked }
          : c
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

  // ─── Apply Logic ────────────────────────────────────────────────────────

  const applyChanges = useCallback(async () => {
    const selected = changes.filter((c) => c.checked);
    if (selected.length === 0) return;

    setState("applying");
    setApplyTotal(selected.length);
    setApplyProgress(0);

    // Apply in batches
    const applyBatchSize = 50;
    let totalApplied = 0;
    let totalErrors = 0;

    for (let i = 0; i < selected.length; i += applyBatchSize) {
      const batch = selected.slice(i, i + applyBatchSize).map((c) => ({
        trackId: c.trackId,
        field: c.field,
        newValue: c.newValue,
      }));

      const result = await applyAnalysisChanges(batch);
      totalApplied += result.applied;
      totalErrors += result.errors;
      setApplyProgress(Math.min(i + applyBatchSize, selected.length));
    }

    setApplyResult({ applied: totalApplied, errors: totalErrors });
    setState("done");
  }, [changes]);

  // ─── Filtered Changes ───────────────────────────────────────────────────

  const filteredChanges =
    filter === "all"
      ? changes
      : changes.filter((c) => {
          if (filter === "metadata")
            return ["genre", "album", "year", "label", "isrc", "musicbrainzId", "releaseMbid"].includes(c.field);
          if (filter === "artwork") return c.field === "artworkUrl";
          if (filter === "lyrics")
            return c.field === "lyrics" || c.field === "syncedLyrics";
          if (filter === "bpm") return c.field === "bpm";
          return true;
        });

  // Group by track
  const groupedChanges = new Map<
    number,
    { artist: string; title: string; changes: AnalysisChange[] }
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
  const uniqueTracksWithChanges = new Set(changes.map((c) => c.trackId)).size;

  const progressPct = total > 0 ? Math.round((progress / total) * 100) : 0;
  const applyPct =
    applyTotal > 0 ? Math.round((applyProgress / applyTotal) * 100) : 0;

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
              {state === "config" && "Reanalyze Library"}
              {state === "analyzing" && "Analyzing..."}
              {state === "review" && "Review Changes"}
              {state === "applying" && "Applying Changes..."}
              {state === "done" && "Analysis Complete"}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* ─── Config ─── */}
          {state === "config" && (
            <div className="space-y-6">
              {/* Scope Stats */}
              {scope && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Total Tracks", value: scope.total, icon: "🎵" },
                    { label: "Missing Artwork", value: scope.missingArtwork, icon: "🖼️" },
                    { label: "Missing Lyrics", value: scope.missingLyrics, icon: "📝" },
                    { label: "Missing Genre", value: scope.missingGenre, icon: "🎶" },
                    { label: "Missing BPM", value: scope.missingBpm, icon: "⏱️" },
                    { label: "Missing Year", value: scope.missingYear, icon: "📅" },
                  ].map((s) => (
                    <div
                      key={s.label}
                      className="rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 p-3 text-center"
                    >
                      <div className="text-lg">{s.icon}</div>
                      <div className="text-lg font-bold tabular-nums">
                        {s.value.toLocaleString()}
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
                <label className="text-sm font-medium">Scan Mode</label>
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
                    <span className="text-sm font-medium">Quick Scan</span>
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
                    <span className="text-sm font-medium">Full Rescan</span>
                    <span className="text-[10px] text-[var(--muted-foreground)] text-center">
                      All tracks, update everything
                    </span>
                  </button>
                </div>
              </div>

              {/* Options */}
              <div className="space-y-2">
                <label className="text-sm font-medium">What to Fetch</label>
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
              <div className="rounded-lg bg-[var(--secondary)]/30 p-3 text-xs text-[var(--muted-foreground)]">
                <div className="flex items-center gap-1.5 mb-1.5 font-medium text-[var(--foreground)]">
                  <Globe className="h-3 w-3" /> Free Services Used
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {["MusicBrainz", "Cover Art Archive", "iTunes", "Deezer", "LRCLIB"].map(
                    (s) => (
                      <Badge
                        key={s}
                        className={cn("text-[10px]", SOURCE_COLORS[s])}
                      >
                        {s}
                      </Badge>
                    )
                  )}
                </div>
                <p className="mt-1.5">
                  Rate limited to respect API limits. ~5 tracks/batch with 1s
                  delay between MusicBrainz calls.
                </p>
              </div>
            </div>
          )}

          {/* ─── Analyzing ─── */}
          {state === "analyzing" && (
            <div className="space-y-6 py-4">
              {/* Progress */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--muted-foreground)]">
                    Analyzing track {progress.toLocaleString()} of{" "}
                    {total.toLocaleString()}
                  </span>
                  <span className="font-mono font-bold text-purple-400">
                    {progressPct}%
                  </span>
                </div>
                <div className="h-3 rounded-full bg-[var(--secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500 transition-[width] duration-500 ease-out"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              {/* Current track */}
              {currentTrack && (
                <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 p-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20">
                    <RefreshCw className="h-4 w-4 text-purple-400 animate-spin" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {currentTrack}
                    </p>
                    <p className="text-[10px] text-[var(--muted-foreground)]">
                      Querying MusicBrainz, iTunes, Deezer, LRCLIB...
                    </p>
                  </div>
                </div>
              )}

              {/* Live stats */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-2xl font-bold text-green-400 tabular-nums">
                    {changes.length}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Updates Found
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-2xl font-bold text-purple-400 tabular-nums">
                    {new Set(changes.map((c) => c.trackId)).size}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Tracks with Updates
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-2xl font-bold text-rose-400 tabular-nums">
                    {errors.length}
                  </div>
                  <div className="text-[10px] text-[var(--muted-foreground)]">
                    Errors
                  </div>
                </div>
              </div>

              {/* API activity */}
              <div className="flex flex-wrap gap-2">
                {["MusicBrainz", "iTunes", "Deezer", "LRCLIB", "Cover Art Archive"].map(
                  (api) => (
                    <div
                      key={api}
                      className="flex items-center gap-1.5 text-xs"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                      <span className="text-[var(--muted-foreground)]">
                        {api}
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* ─── Review ─── */}
          {state === "review" && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium">
                    {changes.length} changes
                  </span>{" "}
                  <span className="text-[var(--muted-foreground)]">
                    across {uniqueTracksWithChanges} tracks
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
                  { key: "all", label: "All", count: changes.length },
                  {
                    key: "metadata",
                    label: "Metadata",
                    count: changes.filter((c) =>
                      ["genre", "album", "year", "label", "isrc", "musicbrainzId", "releaseMbid"].includes(c.field)
                    ).length,
                  },
                  {
                    key: "artwork",
                    label: "Artwork",
                    count: changes.filter((c) => c.field === "artworkUrl").length,
                  },
                  {
                    key: "lyrics",
                    label: "Lyrics",
                    count: changes.filter((c) =>
                      ["lyrics", "syncedLyrics"].includes(c.field)
                    ).length,
                  },
                  {
                    key: "bpm",
                    label: "BPM",
                    count: changes.filter((c) => c.field === "bpm").length,
                  },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setFilter(tab.key)}
                    className={cn(
                      "px-3 py-1 rounded-md text-xs transition-colors cursor-pointer",
                      filter === tab.key
                        ? "bg-purple-500/20 text-purple-400"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    )}
                  >
                    {tab.label}
                    {tab.count > 0 && (
                      <span className="ml-1 tabular-nums">({tab.count})</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Changes list */}
              {changes.length === 0 ? (
                <div className="text-center py-12 text-[var(--muted-foreground)]">
                  <ScanSearch className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No changes found</p>
                  <p className="text-xs mt-1">
                    All your library metadata is already up to date!
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  {Array.from(groupedChanges.entries()).map(
                    ([trackId, group]) => {
                      const isExpanded = expandedTracks.has(trackId);
                      const allChecked = group.changes.every((c) => c.checked);
                      const someChecked = group.changes.some((c) => c.checked);

                      return (
                        <div
                          key={trackId}
                          className="rounded-lg border border-[var(--border)] overflow-hidden"
                        >
                          {/* Track row */}
                          <button
                            onClick={() => toggleTrackExpand(trackId)}
                            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-[var(--accent)] transition-colors cursor-pointer"
                          >
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                // Toggle all changes for this track
                                const newVal = !allChecked;
                                setChanges((prev) =>
                                  prev.map((c) =>
                                    c.trackId === trackId
                                      ? { ...c, checked: newVal }
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
                                {group.artist}
                              </span>
                              <span className="text-[var(--muted-foreground)]">
                                {" "}
                                —{" "}
                              </span>
                              <span>{group.title}</span>
                            </div>
                            <Badge className="text-[10px] bg-[var(--secondary)] text-[var(--muted-foreground)]">
                              {group.changes.length} change
                              {group.changes.length !== 1 ? "s" : ""}
                            </Badge>
                          </button>

                          {/* Expanded changes */}
                          {isExpanded && (
                            <div className="border-t border-[var(--border)] bg-[var(--secondary)]/20">
                              {group.changes.map((change) => (
                                <div
                                  key={`${change.trackId}-${change.field}`}
                                  className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-[var(--border)] last:border-0 hover:bg-[var(--accent)]/50"
                                >
                                  <button
                                    onClick={() =>
                                      toggleChange(
                                        change.trackId,
                                        change.field
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
                                    {FIELD_ICONS[change.field] || "📋"}
                                  </span>
                                  <span className="w-24 font-medium text-[var(--foreground)]">
                                    {change.fieldLabel}
                                  </span>
                                  <span className="text-[var(--muted-foreground)] truncate max-w-[120px]">
                                    {change.field === "lyrics" ||
                                    change.field === "syncedLyrics"
                                      ? change.oldValue || "None"
                                      : change.oldValue || "—"}
                                  </span>
                                  <ArrowRight className="h-3 w-3 text-purple-400 shrink-0" />
                                  <span className="text-green-400 truncate max-w-[120px] font-medium">
                                    {change.field === "lyrics" ||
                                    change.field === "syncedLyrics"
                                      ? `${change.newValue.split("\n").length} lines`
                                      : change.field === "artworkUrl"
                                        ? "New artwork"
                                        : change.newValue}
                                  </span>
                                  <Badge
                                    className={cn(
                                      "text-[9px] ml-auto shrink-0",
                                      SOURCE_COLORS[change.source] ||
                                        "bg-zinc-500/20 text-zinc-400"
                                    )}
                                  >
                                    {change.source}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                  )}
                </div>
              )}

              {/* Errors */}
              {errors.length > 0 && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-rose-400 mb-1">
                    <AlertCircle className="h-3 w-3" />
                    {errors.length} error{errors.length !== 1 ? "s" : ""}{" "}
                    during analysis
                  </div>
                  <div className="max-h-20 overflow-y-auto text-[10px] text-rose-300/70 space-y-0.5">
                    {errors.slice(0, 10).map((err, i) => (
                      <div key={i} className="truncate">
                        {err}
                      </div>
                    ))}
                    {errors.length > 10 && (
                      <div>...and {errors.length - 10} more</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Applying ─── */}
          {state === "applying" && (
            <div className="space-y-6 py-8">
              <div className="text-center">
                <Loader2 className="h-10 w-10 text-purple-400 animate-spin mx-auto mb-4" />
                <p className="text-sm text-[var(--muted-foreground)]">
                  Applying change {applyProgress} of {applyTotal}...
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
          {state === "done" && applyResult && (
            <div className="py-8 text-center space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/20 mx-auto">
                <CheckCheck className="h-8 w-8 text-green-400" />
              </div>
              <div>
                <p className="text-lg font-semibold">Changes Applied!</p>
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
          {state === "config" && (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
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
          {state === "analyzing" && (
            <>
              <div className="text-xs text-[var(--muted-foreground)]">
                {changes.length} updates found so far
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={stopAnalysis}
                  className="cursor-pointer"
                >
                  Stop & Review
                </Button>
              </div>
            </>
          )}
          {state === "review" && (
            <>
              <div className="text-xs text-[var(--muted-foreground)]">
                {selectedCount} of {changes.length} selected
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  className="cursor-pointer"
                >
                  Cancel
                </Button>
                <Button
                  onClick={applyChanges}
                  disabled={selectedCount === 0}
                  className="gap-2 bg-green-600 hover:bg-green-700 text-white cursor-pointer"
                >
                  <Check className="h-4 w-4" />
                  Apply {selectedCount} Changes
                </Button>
              </div>
            </>
          )}
          {state === "done" && (
            <div className="ml-auto">
              <Button
                onClick={() => {
                  onOpenChange(false);
                  // Refresh the page to show updates
                  window.location.reload();
                }}
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
