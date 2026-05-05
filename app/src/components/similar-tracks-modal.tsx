"use client";

import { useState, useEffect, useTransition } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Artwork } from "@/components/artwork";
import { usePlayer } from "@/components/player-context";
import { formatDuration, cn, GENRE_COLORS, ENERGY_COLORS, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import {
    Play,
    Pause,
    Plus,
    Minus,
    Loader2,
    Sparkles,
    Music,
} from "lucide-react";
import {
    getSimilarTracks,
    addTracksToPlaylist,
    removeTrackFromPlaylist,
} from "@/actions/playlists";
import { toast } from "sonner";

interface SimilarTrack {
    id: number;
    filepath: string;
    filename: string;
    artist: string | null;
    title: string | null;
    album: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    duration: number | null;
    energy: number | null;
    genre: string | null;
    subgenre: string | null;
    mood: string | null;
    rating: number | null;
    isFavorite: boolean;
    artworkUrl: string | null;
    tags: string | null;
    score: number;
}

interface SimilarTracksModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    playlistId: number;
    playlistName: string;
    onMutate?: () => void;
}

export function SimilarTracksModal({
    open,
    onOpenChange,
    playlistId,
    playlistName,
    onMutate,
}: SimilarTracksModalProps) {
    const player = usePlayer();
    const { noteNotations } = useDAWSettings();
    const [tracks, setTracks] = useState<SimilarTrack[]>([]);
    const [addedIds, setAddedIds] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(false);
    const [pendingId, setPendingId] = useState<number | null>(null);
    const [isPending, startTransition] = useTransition();

    useEffect(() => {
        if (!open) return;
        setLoading(true);
        setAddedIds(new Set());
        getSimilarTracks(playlistId)
            .then((rows) => setTracks(rows as SimilarTrack[]))
            .finally(() => setLoading(false));
    }, [open, playlistId]);

    function handleAdd(trackId: number) {
        setPendingId(trackId);
        startTransition(async () => {
            const result = await addTracksToPlaylist(playlistId, [trackId]);
            if (result.added > 0) {
                setAddedIds((prev) => new Set([...prev, trackId]));
                toast.success("Added to playlist");
                onMutate?.();
            } else {
                toast.info("Already in playlist");
            }
            setPendingId(null);
        });
    }

    function handleRemove(trackId: number) {
        setPendingId(trackId);
        startTransition(async () => {
            await removeTrackFromPlaylist(playlistId, trackId);
            setAddedIds((prev) => {
                const next = new Set(prev);
                next.delete(trackId);
                return next;
            });
            toast.success("Removed from playlist");
            onMutate?.();
            setPendingId(null);
        });
    }

    function handlePlay(track: SimilarTrack) {
        // Build a playable Track-like object
        player.play(track as never, tracks as never[]);
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-purple-400" />
                        Similar Tracks for &ldquo;{playlistName}&rdquo;
                    </DialogTitle>
                    <p className="text-sm text-[var(--muted-foreground)]">
                        Tracks matching by genre, BPM, key, energy, and playlist name
                    </p>
                </DialogHeader>

                <div className="flex-1 overflow-y-auto -mx-6 px-6">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-12">
                            <Loader2 className="h-8 w-8 animate-spin text-purple-400 mb-3" />
                            <p className="text-sm text-[var(--muted-foreground)]">
                                Finding similar tracks...
                            </p>
                        </div>
                    ) : tracks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-[var(--muted-foreground)]">
                            <Music className="h-10 w-10 mb-3 opacity-50" />
                            <p className="text-sm">No similar tracks found</p>
                            <p className="text-xs mt-1">
                                Try adding tracks to the playlist first, or rename it to match a genre
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {tracks.map((track) => {
                                const isAdded = addedIds.has(track.id);
                                const isCurrentTrack = player.currentTrack?.id === track.id;
                                const isPlayingThis = isCurrentTrack && player.isPlaying;
                                const isPendingThis = pendingId === track.id && isPending;

                                return (
                                    <div
                                        key={track.id}
                                        className={cn(
                                            "flex items-center gap-3 rounded-lg px-3 py-2 group hover:bg-[var(--accent)] transition-colors",
                                            isCurrentTrack && "bg-purple-500/5",
                                            isAdded && "opacity-60"
                                        )}
                                    >
                                        {/* Play button */}
                                        <button
                                            onClick={() =>
                                                isPlayingThis
                                                    ? player.pause()
                                                    : handlePlay(track)
                                            }
                                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-purple-500/20 transition-colors cursor-pointer"
                                        >
                                            {isPlayingThis ? (
                                                <Pause className="h-3.5 w-3.5 text-purple-400" />
                                            ) : (
                                                <Play className="h-3.5 w-3.5 ml-0.5 opacity-40 group-hover:opacity-100 transition-opacity" />
                                            )}
                                        </button>

                                        {/* Artwork */}
                                        <Artwork
                                            src={track.artworkUrl}
                                            size="sm"
                                            showPlaceholder={false}
                                        />

                                        {/* Track info */}
                                        <div className="min-w-0 flex-1">
                                            <p
                                                className={cn(
                                                    "text-sm font-medium truncate",
                                                    isCurrentTrack && "text-purple-400"
                                                )}
                                            >
                                                {track.title || track.filename}
                                            </p>
                                            <p className="text-xs text-[var(--muted-foreground)] truncate">
                                                {track.artist || "Unknown"}
                                            </p>
                                        </div>

                                        {/* Metadata badges */}
                                        <div className="hidden sm:flex items-center gap-1.5 shrink-0">
                                            {track.genre && (
                                                <Badge
                                                    className={cn(
                                                        "text-[10px] px-1.5 py-0",
                                                        GENRE_COLORS[track.genre] || GENRE_COLORS.Other
                                                    )}
                                                >
                                                    {track.genre}
                                                </Badge>
                                            )}
                                            {track.bpm && (
                                                <span className="text-xs tabular-nums text-[var(--muted-foreground)]">
                                                    {Math.round(track.bpm)}
                                                </span>
                                            )}
                                            {track.keyCamelot && (
                                                <span className="text-xs font-mono text-[var(--muted-foreground)]">
                                                    {formatKey(track.keyCamelot, noteNotations)}
                                                </span>
                                            )}
                                            {track.energy && (
                                                <span
                                                    className={cn(
                                                        "inline-block h-2 w-2 rounded-full",
                                                        ENERGY_COLORS[track.energy]
                                                    )}
                                                />
                                            )}
                                        </div>

                                        {/* Duration */}
                                        <span className="text-xs tabular-nums text-[var(--muted-foreground)] w-10 text-right shrink-0">
                                            {formatDuration(track.duration)}
                                        </span>

                                        {/* Score badge */}
                                        <Badge
                                            variant="outline"
                                            className="text-[10px] px-1.5 tabular-nums shrink-0"
                                        >
                                            {track.score}%
                                        </Badge>

                                        {/* Add/Remove button */}
                                        <Button
                                            variant={isAdded ? "outline" : "default"}
                                            size="icon"
                                            className={cn(
                                                "h-7 w-7 shrink-0",
                                                isAdded && "text-rose-400 hover:text-rose-300 hover:border-rose-500/30"
                                            )}
                                            disabled={isPendingThis}
                                            onClick={() =>
                                                isAdded
                                                    ? handleRemove(track.id)
                                                    : handleAdd(track.id)
                                            }
                                        >
                                            {isPendingThis ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : isAdded ? (
                                                <Minus className="h-3.5 w-3.5" />
                                            ) : (
                                                <Plus className="h-3.5 w-3.5" />
                                            )}
                                        </Button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {!loading && tracks.length > 0 && (
                    <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
                        <p className="text-xs text-[var(--muted-foreground)]">
                            {tracks.length} similar tracks found · {addedIds.size} added
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenChange(false)}
                        >
                            Done
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
