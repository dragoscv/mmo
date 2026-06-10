"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
    Sparkles,
    Music,
    Library,
    ExternalLink,
    Play,
    Trash2,
    X,
    Download,
} from "lucide-react";
import { Artwork } from "@/components/artwork";
import { TrackContextMenu, TrackActions } from "@/components/track-actions";
import { usePlayer } from "@/components/player-context";
import { cn, formatDuration, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import {
    downloadTrackFile,
    useSessionDownloads,
} from "@/hooks/use-session-downloads";
import type { Track } from "@/db/schema";

interface LatestDownloadsListProps {
    tracks: Track[];
    /** Track IDs added during the current page session. Used to highlight
     *  freshly-added rows with a brief glow/sparkle animation. */
    freshIds?: Set<number>;
    /** Optional handler to remove a track from the in-page list (does not
     *  delete from library). */
    onRemoveFromList?: (id: number) => void;
    /** Called after a destructive action (delete, hide) so the parent can
     *  refresh / drop stale rows. */
    onMutate?: () => void;
    /** When true, render without the outer card wrapper / header / footer.
     *  Used when embedded inside another container (e.g. the download
     *  sidebar) that already provides chrome. */
    embedded?: boolean;
    className?: string;
}

function timeAgo(dateStr: string | null): string {
    if (!dateStr) return "";
    // SQLite stores naive timestamps; treat as UTC.
    const d = new Date(dateStr.includes("T") ? dateStr : dateStr + "Z");
    const diff = Date.now() - d.getTime();
    if (Number.isNaN(diff)) return "";
    const s = Math.floor(diff / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString();
}

function platformBadgeColor(platform: string | null): string {
    const p = (platform || "").toLowerCase();
    if (p.includes("youtube")) return "bg-red-500/10 text-red-400 border-red-500/20";
    if (p.includes("soundcloud")) return "bg-orange-500/10 text-orange-400 border-orange-500/20";
    if (p.includes("spotify")) return "bg-green-500/10 text-green-400 border-green-500/20";
    if (p.includes("deezer")) return "bg-purple-500/10 text-purple-400 border-purple-500/20";
    if (p.includes("apple")) return "bg-pink-500/10 text-pink-400 border-pink-500/20";
    if (p.includes("bandcamp")) return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
    return "bg-muted text-muted-foreground border-border";
}

export function LatestDownloadsList({
    tracks,
    freshIds,
    onRemoveFromList,
    onMutate,
    embedded = false,
    className,
}: LatestDownloadsListProps) {
    const player = usePlayer();
    const { noteNotations } = useDAWSettings();
    const { savedIds } = useSessionDownloads();

    if (tracks.length === 0) return null;

    const rowsContent = (
        <ul className="divide-y divide-border">
            <AnimatePresence initial={false}>
                {tracks.map((track) => {
                    const isFresh = freshIds?.has(track.id) ?? false;
                    const isSaved = savedIds.has(track.id);
                    return (
                        <motion.li
                            key={track.id}
                            layout
                            initial={{
                                opacity: 0,
                                y: -16,
                                scale: 0.97,
                                backgroundColor: "rgba(168, 85, 247, 0.18)",
                            }}
                            animate={{
                                opacity: 1,
                                y: 0,
                                scale: 1,
                                backgroundColor: "rgba(168, 85, 247, 0)",
                            }}
                            exit={{
                                opacity: 0,
                                x: 24,
                                transition: { duration: 0.18 },
                            }}
                            transition={{
                                duration: 0.45,
                                ease: [0.25, 0.46, 0.45, 0.94],
                                backgroundColor: { duration: 1.6 },
                            }}
                            className="relative group"
                        >
                            <TrackContextMenu track={track} onMutate={onMutate}>
                                <div
                                    className={cn(
                                        "flex items-center gap-3 px-3 py-2 hover:bg-accent/40 transition-colors cursor-default",
                                        isFresh && "ring-1 ring-purple-500/30 ring-inset",
                                        isSaved &&
                                        "bg-sky-500/[0.07] ring-1 ring-sky-500/25 ring-inset"
                                    )}
                                >
                                    {/* Artwork (with hover-to-play overlay) */}
                                    <button
                                        type="button"
                                        onClick={() => player.play(track)}
                                        className="relative shrink-0 rounded-md overflow-hidden focus:outline-none focus:ring-2 focus:ring-purple-500/40"
                                        title="Play"
                                    >
                                        <Artwork
                                            src={track.artworkUrl}
                                            size="md"
                                            alt={track.title || track.filename}
                                        />
                                        <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Play className="h-4 w-4 text-white fill-white" />
                                        </span>
                                        {isFresh && (
                                            <motion.span
                                                initial={{ opacity: 0, scale: 0.5 }}
                                                animate={{ opacity: 1, scale: 1 }}
                                                className="absolute -top-1 -right-1 flex items-center justify-center h-4 w-4 rounded-full bg-purple-500 text-white shadow-lg shadow-purple-500/40"
                                                title="Just added"
                                            >
                                                <Sparkles className="h-2.5 w-2.5" />
                                            </motion.span>
                                        )}
                                    </button>

                                    {/* Title / artist */}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className="text-xs font-medium text-foreground truncate">
                                                {track.title || track.filename}
                                            </p>
                                            {track.sourcePlatform && (
                                                <span
                                                    className={cn(
                                                        "shrink-0 px-1.5 py-0.5 rounded text-[9px] font-medium border",
                                                        platformBadgeColor(track.sourcePlatform)
                                                    )}
                                                >
                                                    {track.sourcePlatform}
                                                </span>
                                            )}
                                            {isSaved && (
                                                <span
                                                    className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium border bg-sky-500/10 text-sky-400 border-sky-500/30"
                                                    title="Saved to your PC during this session"
                                                >
                                                    <Download className="h-2.5 w-2.5" />
                                                    Saved
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground truncate">
                                            <span className="truncate">
                                                {track.artist || "Unknown artist"}
                                            </span>
                                            {track.addedAt && (
                                                <>
                                                    <span className="text-muted-foreground/40">·</span>
                                                    <span className="shrink-0 text-muted-foreground/70">
                                                        {timeAgo(track.addedAt)}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>

                                    {/* Metrics */}
                                    <div className="flex items-center gap-1 shrink-0">
                                        {track.bpm != null && (
                                            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground tabular-nums">
                                                {Math.round(track.bpm)}
                                            </span>
                                        )}
                                        {track.keyCamelot && (
                                            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                                                {formatKey(track.keyCamelot, noteNotations)}
                                            </span>
                                        )}
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-0.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                downloadTrackFile(
                                                    track.id,
                                                    `${track.artist || "Unknown"} - ${track.title || track.filename}`
                                                );
                                            }}
                                            className="p-1 rounded-md text-muted-foreground hover:text-sky-400 hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
                                            title="Save to PC"
                                        >
                                            <Download className="h-3 w-3" />
                                        </button>
                                        {track.sourceUrl && (
                                            <a
                                                href={track.sourceUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={(e) => e.stopPropagation()}
                                                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
                                                title="Open source URL"
                                            >
                                                <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                        <TrackActions track={track} onMutate={onMutate} />
                                        {onRemoveFromList && (
                                            <button
                                                type="button"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onRemoveFromList(track.id);
                                                }}
                                                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
                                                title="Remove from this list"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </TrackContextMenu>
                        </motion.li>
                    );
                })}
            </AnimatePresence>
        </ul>
    );

    if (embedded) {
        return <div className={cn("flex flex-col", className)}>{rowsContent}</div>;
    }

    return (
        <div
            className={cn(
                "rounded-xl bg-card border border-border overflow-hidden",
                className
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gradient-to-r from-purple-500/5 via-transparent to-transparent">
                <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="h-3.5 w-3.5 text-purple-400" />
                    Latest Downloads
                    <span className="text-muted-foreground font-normal normal-case tracking-normal">
                        ({tracks.length})
                    </span>
                </h3>
                <Link
                    href="/library?sort=addedAt&order=desc"
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                    <Library className="h-3 w-3" />
                    Open Library
                </Link>
            </div>

            {rowsContent}

            {/* Footer hint */}
            <div className="px-4 py-2 border-t border-border bg-muted/20 text-[10px] text-muted-foreground/70 flex items-center gap-1.5">
                <Music className="h-3 w-3" />
                Right-click a track for full library actions
            </div>
        </div>
    );
}

// ─── Hook: tracks freshly added during the current session ──────────────

/** Tracks that were added during the current page session. Returns the list
 *  plus helpers to add/remove. Newly-added tracks are prepended and marked as
 *  fresh for `freshDuration` ms so the UI can play a one-shot animation. */
export function useLatestDownloads(freshDuration = 4000) {
    const [tracks, setTracks] = useState<Track[]>([]);
    const [freshIds, setFreshIds] = useState<Set<number>>(new Set());

    // Auto-remove "fresh" highlight after the duration elapses.
    useEffect(() => {
        if (freshIds.size === 0) return;
        const timers = Array.from(freshIds).map((id) =>
            setTimeout(() => {
                setFreshIds((prev) => {
                    if (!prev.has(id)) return prev;
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }, freshDuration)
        );
        return () => {
            for (const t of timers) clearTimeout(t);
        };
    }, [freshIds, freshDuration]);

    const addTrack = (track: Track) => {
        setTracks((prev) => {
            // Move existing entry to top instead of duplicating.
            const filtered = prev.filter((t) => t.id !== track.id);
            return [track, ...filtered].slice(0, 25);
        });
        setFreshIds((prev) => {
            const next = new Set(prev);
            next.add(track.id);
            return next;
        });
    };

    const addTracks = (incoming: Track[]) => {
        if (incoming.length === 0) return;
        setTracks((prev) => {
            const incomingIds = new Set(incoming.map((t) => t.id));
            const filtered = prev.filter((t) => !incomingIds.has(t.id));
            return [...incoming, ...filtered].slice(0, 25);
        });
        setFreshIds((prev) => {
            const next = new Set(prev);
            for (const t of incoming) next.add(t.id);
            return next;
        });
    };

    const removeTrack = (id: number) => {
        setTracks((prev) => prev.filter((t) => t.id !== id));
        setFreshIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    const setInitial = (initial: Track[]) => {
        setTracks(initial.slice(0, 25));
    };

    return { tracks, freshIds, addTrack, addTracks, removeTrack, setInitial };
}
