"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDuration } from "@/lib/utils";
import {
    Download,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Library,
    Music,
    Disc3,
} from "lucide-react";
import type { DeckSide } from "@/lib/mixer-engine";

// ─── Types ───────────────────────────────────────────────────────────────

export interface TrackDownloadInfo {
    url: string;
    /** For metadata providers (Deezer/iTunes/Spotify), a yt-dlp search query to download via YouTube */
    downloadUrl?: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
    extractor: string;
}

type DownloadStage = "idle" | "downloading" | "adding" | "complete" | "error";

interface DownloadState {
    stage: DownloadStage;
    progress: number;
    speed: string;
    eta: string;
    totalSize: string;
    error?: string;
    trackId?: number;
    filePath?: string;
    logs: string[];
}

interface InlineDownloadProps {
    track: TrackDownloadInfo;
    targetDeck: DeckSide;
    onLoadToDeck: (trackId: number, deck: DeckSide) => void;
    /** Fired after the track is added to the library (or detected as already there)
     *  with the freshly-created/found trackId. Parent uses this to refetch its
     *  track list so the new entry shows up immediately. */
    onAddedToLibrary?: (trackId: number) => void;
    onClose: () => void;
    open: boolean;
}

// ─── Settings loader ─────────────────────────────────────────────────────

async function loadDownloadSettings(): Promise<Record<string, string>> {
    try {
        const res = await fetch("/api/download/settings");
        if (res.ok) return await res.json();
    } catch { /* ignore */ }
    return {};
}

// ─── Progress regex (shared with download page) ──────────────────────────

const PROGRESS_RE = /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/;

// ─── Component ───────────────────────────────────────────────────────────

export function InlineDownloadModal({ track, targetDeck, onLoadToDeck, onAddedToLibrary, onClose, open }: InlineDownloadProps) {
    const [state, setState] = useState<DownloadState>({
        stage: "idle",
        progress: 0,
        speed: "",
        eta: "",
        totalSize: "",
        logs: [],
    });
    const abortRef = useRef<AbortController | null>(null);
    const hasStarted = useRef(false);

    const addLog = useCallback((msg: string) => {
        setState(prev => ({ ...prev, logs: [...prev.logs.slice(-30), msg] }));
    }, []);

    const startDownload = useCallback(async () => {
        if (hasStarted.current) return;
        hasStarted.current = true;
        setState(prev => ({ ...prev, stage: "downloading", progress: 0 }));

        try {
            // Load download settings
            const settings = await loadDownloadSettings();
            const audioFormat = settings.audioFormat || "auto";
            const audioQuality = settings.audioQuality || "auto";
            const downloadFolder = settings.downloadFolder || "";

            addLog(`Downloading: ${track.title}`);

            const controller = new AbortController();
            abortRef.current = controller;

            // For metadata providers (Deezer/iTunes/Spotify), use the YouTube search URL
            const effectiveUrl = track.downloadUrl || track.url;

            const res = await fetch("/api/download/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: effectiveUrl,
                    title: track.title,
                    artist: track.artist,
                    duration: track.duration,
                    thumbnail: track.thumbnail,
                    audioOnly: true,
                    audioQuality,
                    audioFormat,
                    downloadFolder,
                    mediaExtractor: track.extractor,
                }),
                signal: controller.signal,
            });

            if (!res.ok || !res.body) {
                throw new Error(`Download failed: HTTP ${res.status}`);
            }

            // Parse SSE stream
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let downloadedFile = "";
            let downloadId = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const event = JSON.parse(line.slice(6));

                        if (event.type === "progress") {
                            const match = event.raw?.match(PROGRESS_RE);
                            if (match) {
                                setState(prev => ({
                                    ...prev,
                                    progress: parseFloat(match[1]),
                                    totalSize: match[2],
                                    speed: match[3],
                                    eta: match[4],
                                }));
                            }
                        } else if (event.type === "complete" || event.type === "track_complete") {
                            downloadedFile = event.file || "";
                            downloadId = event.downloadId || 0;
                            addLog("Download complete, adding to library...");
                        } else if (event.type === "log") {
                            addLog(event.message || "");
                        } else if (event.type === "error" || event.type === "track_error") {
                            throw new Error(event.error || "Download failed");
                        } else if (event.type === "destination") {
                            addLog(`Saving to: ${event.path?.split(/[/\\]/).pop() || ""}`);
                        }
                    } catch (e) {
                        if (e instanceof SyntaxError) continue;
                        throw e;
                    }
                }
            }

            if (!downloadedFile) {
                throw new Error("Download completed but no file was produced");
            }

            // Stage 2: Add to library
            setState(prev => ({ ...prev, stage: "adding", progress: 100 }));
            addLog("Analyzing and adding to library...");

            const addRes = await fetch("/api/download/add-to-library", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: downloadedFile,
                    downloadId,
                    sourceInfo: {
                        sourceUrl: track.url,
                        sourcePlatform: track.extractor,
                        sourceId: track.url,
                    },
                }),
            });

            if (!addRes.ok) {
                const err = await addRes.json().catch(() => ({}));
                throw new Error(err.error || "Failed to add to library");
            }

            const addResult = await addRes.json();

            if (!addResult.success) {
                throw new Error(addResult.error || "Failed to add to library");
            }

            setState(prev => ({
                ...prev,
                stage: "complete",
                trackId: addResult.trackId,
                filePath: downloadedFile,
            }));
            addLog("Track ready!");
            // Notify parent so the library list / load-to-deck buttons see the
            // new (or freshly-detected duplicate) track immediately.
            if (typeof addResult.trackId === "number") {
                onAddedToLibrary?.(addResult.trackId);
            }
        } catch (err) {
            if ((err as Error).name === "AbortError") return;
            const message = err instanceof Error ? err.message : "Download failed";
            setState(prev => ({ ...prev, stage: "error", error: message }));
            addLog(`Error: ${message}`);
        }
    }, [track, addLog, onAddedToLibrary]);

    // Auto-start on open
    useEffect(() => {
        if (open && state.stage === "idle" && !hasStarted.current) {
            startDownload();
        }
    }, [open, state.stage, startDownload]);

    const handleClose = useCallback(() => {
        if (state.stage === "downloading") {
            abortRef.current?.abort();
        }
        // Reset state
        hasStarted.current = false;
        setState({ stage: "idle", progress: 0, speed: "", eta: "", totalSize: "", logs: [] });
        onClose();
    }, [state.stage, onClose]);

    return (
        <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
            <DialogContent className="sm:max-w-[420px] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[90]">
                <div className="p-4 space-y-3">
                    <DialogTitle className="flex items-center gap-2 text-sm font-semibold text-white/90">
                        <Download className="h-4 w-4" />
                        {state.stage === "complete" ? "Download Complete" : "Downloading Track"}
                    </DialogTitle>

                    {/* Track info */}
                    <div className="flex items-center gap-3 rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5">
                        {track.thumbnail ? (
                            <img src={track.thumbnail} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
                        ) : (
                            <div className="w-10 h-10 rounded bg-white/10 flex items-center justify-center shrink-0">
                                <Music className="h-4 w-4 text-white/20" />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="text-xs text-white/80 truncate">{track.title}</p>
                            <p className="text-[10px] text-white/35 truncate">{track.artist}</p>
                        </div>
                        {track.duration > 0 && (
                            <span className="text-[10px] text-white/25 tabular-nums shrink-0">
                                {formatDuration(track.duration)}
                            </span>
                        )}
                    </div>

                    {/* Progress */}
                    {(state.stage === "downloading" || state.stage === "adding") && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-[10px]">
                                <span className="text-white/50 flex items-center gap-1.5">
                                    {state.stage === "downloading" ? (
                                        <><Loader2 className="h-3 w-3 animate-spin" /> Downloading...</>
                                    ) : (
                                        <><Library className="h-3 w-3 animate-pulse" /> Adding to library...</>
                                    )}
                                </span>
                                {state.stage === "downloading" && (
                                    <span className="text-white/30 tabular-nums">
                                        {state.progress.toFixed(0)}% {state.speed && `• ${state.speed}`} {state.eta && `• ETA ${state.eta}`}
                                    </span>
                                )}
                            </div>
                            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-all duration-300",
                                        state.stage === "adding" ? "bg-purple-500/60 animate-pulse w-full" : "bg-green-500/60"
                                    )}
                                    style={state.stage === "downloading" ? { width: `${state.progress}%` } : undefined}
                                />
                            </div>
                        </div>
                    )}

                    {/* Success */}
                    {state.stage === "complete" && state.trackId && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2 text-green-400/80 text-xs">
                                <CheckCircle2 className="h-4 w-4" />
                                Track downloaded and added to library!
                            </div>
                            <button
                                onClick={() => {
                                    onLoadToDeck(state.trackId!, targetDeck);
                                    handleClose();
                                }}
                                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-medium bg-purple-500/20 border border-purple-500/30 text-purple-300 hover:bg-purple-500/30 transition-colors cursor-pointer"
                            >
                                <Disc3 className="h-4 w-4" />
                                Load to Deck {targetDeck}
                            </button>
                        </div>
                    )}

                    {/* Error */}
                    {state.stage === "error" && (
                        <div className="flex items-start gap-2 text-red-400/80 text-xs rounded-lg bg-red-500/[0.06] border border-red-500/10 p-2.5">
                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                            <span>{state.error || "Download failed"}</span>
                        </div>
                    )}

                    {/* Logs */}
                    {state.logs.length > 0 && (
                        <div className="max-h-20 overflow-y-auto rounded bg-black/40 border border-white/[0.04] p-2 text-[9px] text-white/25 font-mono space-y-0.5">
                            {state.logs.map((log, i) => (
                                <div key={i} className="truncate">{log}</div>
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
