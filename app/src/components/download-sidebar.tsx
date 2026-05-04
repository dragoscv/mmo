"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    History,
    Sparkles,
    Loader2,
    Trash2,
    Download,
    Music,
    X,
    PanelRightClose,
    RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LatestDownloadsList } from "@/components/latest-downloads-list";
import {
    downloadTrackFile,
    useSessionDownloads,
} from "@/hooks/use-session-downloads";
import type { Track } from "@/db/schema";

// ─── Types ───────────────────────────────────────────────────────────────

export interface DownloadHistoryItem {
    id: number;
    url: string;
    title: string | null;
    artist: string | null;
    duration: number | null;
    thumbnail: string | null;
    extractor: string | null;
    filePath: string | null;
    fileSize: number | null;
    format: string | null;
    quality: string | null;
    status: string;
    trackId: number | null;
    error: string | null;
    downloadedAt: string;
}

type SidebarTab = "latest" | "history";

interface DownloadSidebarProps {
    // Latest downloads
    latestTracks: Track[];
    freshIds?: Set<number>;
    onRemoveLatest?: (id: number) => void;

    // History
    history: DownloadHistoryItem[];
    historyLoading: boolean;
    onClearHistory: () => void;
    onDeleteHistoryItem: (id: number) => void;
    /** Re-download from a history row. */
    onRedownload: (url: string) => void;

    /** Active tab (controlled by the parent so the header toggle button can
     *  drive the sidebar open + select the tab in one click). */
    activeTab: SidebarTab;
    onTabChange: (tab: SidebarTab) => void;

    /** Optional handler to collapse the sidebar (mobile / user action). */
    onClose?: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
    const d = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

// ─── Component ───────────────────────────────────────────────────────────

export function DownloadSidebar({
    latestTracks,
    freshIds,
    onRemoveLatest,
    history,
    historyLoading,
    onClearHistory,
    onDeleteHistoryItem,
    onRedownload,
    activeTab,
    onTabChange,
    onClose,
}: DownloadSidebarProps) {
    return (
        <aside className="w-full lg:w-[360px] xl:w-[400px] shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] flex flex-col rounded-xl bg-card border border-border overflow-hidden">
            {/* Header / Tabs */}
            <div className="flex items-center justify-between px-2 py-1.5 border-b border-border bg-muted/30">
                <div className="flex items-center gap-1">
                    <SidebarTabButton
                        active={activeTab === "latest"}
                        onClick={() => onTabChange("latest")}
                        icon={<Sparkles className="h-3.5 w-3.5" />}
                        label="Latest"
                        count={latestTracks.length}
                    />
                    <SidebarTabButton
                        active={activeTab === "history"}
                        onClick={() => onTabChange("history")}
                        icon={<History className="h-3.5 w-3.5" />}
                        label="History"
                        count={history.length}
                    />
                </div>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
                        title="Hide sidebar"
                    >
                        <PanelRightClose className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                <AnimatePresence mode="wait" initial={false}>
                    {activeTab === "latest" ? (
                        <motion.div
                            key="latest"
                            initial={{ opacity: 0, x: -8 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 8 }}
                            transition={{ duration: 0.18 }}
                        >
                            {latestTracks.length === 0 ? (
                                <EmptyState
                                    icon={<Sparkles className="h-5 w-5 opacity-40" />}
                                    title="No new downloads yet"
                                    hint="Tracks added during this session will appear here in real time."
                                />
                            ) : (
                                <LatestDownloadsList
                                    tracks={latestTracks}
                                    freshIds={freshIds}
                                    onRemoveFromList={onRemoveLatest}
                                    embedded
                                />
                            )}
                        </motion.div>
                    ) : (
                        <motion.div
                            key="history"
                            initial={{ opacity: 0, x: 8 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -8 }}
                            transition={{ duration: 0.18 }}
                        >
                            <HistoryPane
                                history={history}
                                loading={historyLoading}
                                onClear={onClearHistory}
                                onDelete={onDeleteHistoryItem}
                                onRedownload={onRedownload}
                            />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </aside>
    );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function SidebarTabButton({
    active,
    onClick,
    icon,
    label,
    count,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
    count: number;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer",
                active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
            )}
        >
            {active && (
                <motion.span
                    layoutId="download-sidebar-active-tab"
                    className="absolute inset-0 rounded-lg bg-card border border-border shadow-sm"
                    transition={{ type: "spring", duration: 0.3, bounce: 0.15 }}
                />
            )}
            <span className="relative flex items-center gap-1.5">
                {icon}
                {label}
                <span
                    className={cn(
                        "text-[10px] px-1 rounded font-normal tabular-nums",
                        active ? "text-muted-foreground" : "text-muted-foreground/60"
                    )}
                >
                    {count}
                </span>
            </span>
        </button>
    );
}

function EmptyState({
    icon,
    title,
    hint,
}: {
    icon: React.ReactNode;
    title: string;
    hint?: string;
}) {
    return (
        <div className="flex flex-col items-center justify-center text-center py-12 px-6 gap-2">
            <div className="text-muted-foreground/60">{icon}</div>
            <p className="text-xs font-medium text-foreground/80">{title}</p>
            {hint && (
                <p className="text-[11px] text-muted-foreground/60 leading-relaxed max-w-[260px]">
                    {hint}
                </p>
            )}
        </div>
    );
}

function HistoryPane({
    history,
    loading,
    onClear,
    onDelete,
    onRedownload,
}: {
    history: DownloadHistoryItem[];
    loading: boolean;
    onClear: () => void;
    onDelete: (id: number) => void;
    onRedownload: (url: string) => void;
}) {
    const [pendingClear, setPendingClear] = useState(false);
    const { savedIds } = useSessionDownloads();

    if (loading && history.length === 0) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (history.length === 0) {
        return (
            <EmptyState
                icon={<History className="h-5 w-5 opacity-40" />}
                title="No download history"
                hint="Every download you start will be tracked here, with status and a one-click re-download."
            />
        );
    }

    return (
        <div>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20 sticky top-0 z-10 backdrop-blur">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    Last {history.length} downloads
                </span>
                {pendingClear ? (
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            onClick={() => {
                                onClear();
                                setPendingClear(false);
                            }}
                            className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors cursor-pointer"
                        >
                            Confirm
                        </button>
                        <button
                            type="button"
                            onClick={() => setPendingClear(false)}
                            className="text-[10px] px-2 py-0.5 rounded-md text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                            Cancel
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={() => setPendingClear(true)}
                        className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors cursor-pointer flex items-center gap-1"
                    >
                        <Trash2 className="h-3 w-3" />
                        Clear all
                    </button>
                )}
            </div>

            <ul className="divide-y divide-border">
                <AnimatePresence initial={false}>
                    {history.map(item => {
                        const isSaved = item.trackId != null && savedIds.has(item.trackId);
                        return (
                            <motion.li
                                key={item.id}
                                layout
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: "auto" }}
                                exit={{ opacity: 0, height: 0, x: 24 }}
                                transition={{ duration: 0.2 }}
                                className="overflow-hidden"
                            >
                                <div
                                    className={cn(
                                        "flex items-center gap-2.5 px-3 py-2 hover:bg-accent/30 transition-colors group",
                                        isSaved &&
                                        "bg-sky-500/[0.07] ring-1 ring-sky-500/25 ring-inset"
                                    )}
                                >
                                    {/* Thumbnail */}
                                    {item.thumbnail ? (
                                        <div className="w-9 h-9 rounded shrink-0 overflow-hidden bg-muted">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img
                                                src={item.thumbnail}
                                                alt=""
                                                className="w-full h-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <div className="w-9 h-9 rounded shrink-0 bg-muted flex items-center justify-center">
                                            <Music className="h-4 w-4 text-muted-foreground/40" />
                                        </div>
                                    )}

                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium text-foreground truncate">
                                            {item.title || "Unknown"}
                                        </p>
                                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground truncate">
                                            {item.artist && (
                                                <span className="truncate max-w-[120px]">
                                                    {item.artist}
                                                </span>
                                            )}
                                            {item.extractor && (
                                                <span className="text-purple-400/70 shrink-0">
                                                    {item.extractor}
                                                </span>
                                            )}
                                            <span className="shrink-0">
                                                {timeAgo(item.downloadedAt)}
                                            </span>
                                            {isSaved && (
                                                <span
                                                    className="shrink-0 inline-flex items-center gap-0.5 text-sky-400"
                                                    title="Saved to your PC during this session"
                                                >
                                                    <Download className="h-2.5 w-2.5" />
                                                    Saved
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Status badge */}
                                    <span
                                        className={cn(
                                            "text-[9px] px-1.5 py-0.5 rounded-full shrink-0 font-medium",
                                            item.status === "complete" &&
                                            "bg-green-500/10 text-green-400",
                                            item.status === "added" &&
                                            "bg-blue-500/10 text-blue-400",
                                            item.status === "error" &&
                                            "bg-red-500/10 text-red-400",
                                            item.status === "downloading" &&
                                            "bg-yellow-500/10 text-yellow-400",
                                            item.status === "pending" &&
                                            "bg-muted text-muted-foreground"
                                        )}
                                    >
                                        {item.status === "added"
                                            ? `#${item.trackId}`
                                            : item.status}
                                    </span>

                                    {/* Hover actions */}
                                    <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                                        {item.trackId != null && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    downloadTrackFile(
                                                        item.trackId!,
                                                        `${item.artist || "Unknown"} - ${item.title || "track"}`
                                                    );
                                                }}
                                                className="p-1 rounded text-muted-foreground hover:text-sky-400 hover:bg-accent transition-colors cursor-pointer"
                                                title="Save to PC"
                                            >
                                                <Download className="h-3.5 w-3.5" />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => onRedownload(item.url)}
                                            className="p-1 rounded text-muted-foreground hover:text-purple-400 hover:bg-accent transition-colors cursor-pointer"
                                            title="Re-download from source"
                                        >
                                            <RefreshCw className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onDelete(item.id)}
                                            className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-accent transition-colors cursor-pointer"
                                            title="Remove from history"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                </div>
                            </motion.li>
                        );
                    })}
                </AnimatePresence>
            </ul>
        </div>
    );
}
