"use client";

import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { useMixer } from "./mixer-context";
import { usePlayer } from "./player-context";
import type { DeckSide } from "@/lib/mixer-engine";
import { Search, Music, Disc3, Loader2, Zap, X } from "lucide-react";
import { cn, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { globalSearch } from "@/actions/search";
import { getRecommendedTracks, type RecommendedTrack } from "@/actions/recommendations";

interface MixerTrack {
    id: number;
    title: string | null;
    artist: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    energy: number | null;
    duration: number | null;
    artworkUrl: string | null;
    genre?: string | null;
    filename?: string;
}

function formatDuration(s: number | null) {
    if (!s) return "--:--";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface DeckTrackPickerProps {
    side: DeckSide;
    open: boolean;
    onClose: () => void;
}

export function DeckTrackPicker({ side, open, onClose }: DeckTrackPickerProps) {
    const mixer = useMixer();
    const player = usePlayer();
    const { noteNotations } = useDAWSettings();
    const [query, setQuery] = useState("");
    const [searchResults, setSearchResults] = useState<MixerTrack[]>([]);
    const [recommendations, setRecommendations] = useState<RecommendedTrack[]>([]);
    const [isSearching, startSearchTransition] = useTransition();
    const [isLoadingRecs, setIsLoadingRecs] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    const color = side === "A" ? "rgb(168,85,247)" : "rgb(59,130,246)";
    const colorClass = side === "A" ? "text-purple-400" : "text-blue-400";
    const bgClass = side === "A" ? "bg-purple-500/20 border-purple-500/30" : "bg-blue-500/20 border-blue-500/30";

    // Focus input when opened
    useEffect(() => {
        if (open) {
            setTimeout(() => inputRef.current?.focus(), 100);
            // eslint-disable-next-line react-hooks/set-state-in-effect -- imperative reset on open transition
            setQuery("");
            setSearchResults([]);
        }
    }, [open]);

    // Load recommendations based on current track (Deck A or player's current track)
    useEffect(() => {
        if (!open) return;

        const refTrack = mixer.deckA.trackId
            ? { id: mixer.deckA.trackId, bpm: mixer.deckA.bpm, key: mixer.deckA.key }
            : player.currentTrack
                ? { id: player.currentTrack.id, bpm: player.currentTrack.bpm, key: player.currentTrack.keyCamelot }
                : null;

        if (!refTrack) return;

        // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch result; cannot derive
        setIsLoadingRecs(true);
        getRecommendedTracks(refTrack.id, undefined, refTrack.bpm, refTrack.key, 15)
            .then(setRecommendations)
            .catch(() => setRecommendations([]))
            .finally(() => setIsLoadingRecs(false));
    }, [open, mixer.deckA.trackId, mixer.deckA.bpm, mixer.deckA.key, player.currentTrack]);

    // Debounced search
    const handleSearch = useCallback((value: string) => {
        setQuery(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);

        if (!value.trim()) {
            setSearchResults([]);
            return;
        }

        debounceRef.current = setTimeout(() => {
            startSearchTransition(async () => {
                const result = await globalSearch(value);
                setSearchResults(result.tracks as MixerTrack[]);
            });
        }, 250);
    }, []);

    const handleSelect = useCallback((track: MixerTrack) => {
        // Cast to Track-like shape for loadTrack
        mixer.loadTrack(side, {
            id: track.id,
            title: track.title,
            artist: track.artist,
            filename: track.filename || track.title || "Unknown",
            bpm: track.bpm,
            keyCamelot: track.keyCamelot,
            artworkUrl: track.artworkUrl,
        } as any);
        onClose();
    }, [mixer, side, onClose]);

    if (!open) return null;

    const showResults = query.trim().length > 0;
    const tracks = showResults ? searchResults : [];

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onClose}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

            {/* Modal */}
            <div
                className="relative w-full max-w-lg mx-4 max-h-[80vh] bg-zinc-900 border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-[scaleIn_200ms_ease-out]"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
                    <Disc3 className={cn("h-5 w-5 shrink-0", colorClass)} />
                    <span className="text-sm font-semibold">Load Track to Deck {side}</span>
                    <button
                        onClick={onClose}
                        className="ml-auto p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors cursor-pointer"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Search Input */}
                <div className="px-4 py-3 border-b border-white/5">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/30" />
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => handleSearch(e.target.value)}
                            placeholder="Search by title, artist, album..."
                            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-white/30 outline-none focus:border-white/20 focus:bg-white/[0.07] transition-colors"
                        />
                        {isSearching && (
                            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40 animate-spin" />
                        )}
                    </div>
                </div>

                {/* Results */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                    {showResults ? (
                        tracks.length > 0 ? (
                            <div className="py-1">
                                <div className="px-4 py-2">
                                    <span className="text-[10px] uppercase tracking-wider text-white/30">
                                        Search Results ({tracks.length})
                                    </span>
                                </div>
                                {tracks.map((track) => (
                                    <TrackRow
                                        key={track.id}
                                        track={track}
                                        onSelect={handleSelect}
                                        colorClass={colorClass}
                                        bgClass={bgClass}
                                    />
                                ))}
                            </div>
                        ) : !isSearching ? (
                            <div className="flex flex-col items-center justify-center py-12 text-white/20">
                                <Music className="h-8 w-8 mb-2" />
                                <p className="text-sm">No tracks found</p>
                            </div>
                        ) : null
                    ) : (
                        /* Recommendations */
                        <div className="py-1">
                            <div className="px-4 py-2 flex items-center gap-2">
                                <Zap className="h-3.5 w-3.5 text-amber-400" />
                                <span className="text-[10px] uppercase tracking-wider text-white/30">
                                    Recommended for Mixing
                                </span>
                            </div>
                            {isLoadingRecs ? (
                                <div className="flex items-center justify-center py-8">
                                    <Loader2 className="h-5 w-5 text-white/30 animate-spin" />
                                </div>
                            ) : recommendations.length > 0 ? (
                                recommendations.map((track) => (
                                    <TrackRow
                                        key={track.id}
                                        track={track}
                                        onSelect={handleSelect}
                                        colorClass={colorClass}
                                        bgClass={bgClass}
                                        reason={track.reason}
                                        score={track.score}
                                        maxScore={track.maxScore}
                                    />
                                ))
                            ) : (
                                <div className="flex flex-col items-center justify-center py-12 text-white/20">
                                    <Music className="h-8 w-8 mb-2" />
                                    <p className="text-sm">Play a track to get recommendations</p>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Track Row ───────────────────────────────────────────────────────────

function TrackRow({
    track,
    onSelect,
    colorClass,
    bgClass,
    reason,
    score,
    maxScore,
}: {
    track: MixerTrack;
    onSelect: (track: MixerTrack) => void;
    colorClass: string;
    bgClass: string;
    reason?: string;
    score?: number;
    maxScore?: number;
}) {
    const { noteNotations } = useDAWSettings();
    return (
        <button
            onClick={() => onSelect(track)}
            className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/5 active:bg-white/10 transition-colors text-left cursor-pointer group"
        >
            {/* Artwork */}
            {track.artworkUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                <img
                    src={track.artworkUrl}
                    alt=""
                    className="w-10 h-10 rounded object-cover shrink-0"
                />
            ) : (
                <div className="w-10 h-10 rounded bg-white/10 flex items-center justify-center shrink-0">
                    <Music className="h-4 w-4 text-white/20" />
                </div>
            )}

            {/* Info */}
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate group-hover:text-white transition-colors">
                    {track.title || "Unknown Title"}
                </p>
                <div className="flex items-center gap-2 text-xs text-white/40">
                    <span className="truncate">{track.artist || "Unknown Artist"}</span>
                    {track.bpm && (
                        <>
                            <span className="text-white/10">·</span>
                            <span className="tabular-nums shrink-0">{track.bpm.toFixed(1)}</span>
                        </>
                    )}
                    {track.keyCamelot && (
                        <>
                            <span className="text-white/10">·</span>
                            <span className="shrink-0">{formatKey(track.keyCamelot, noteNotations)}</span>
                        </>
                    )}
                </div>
                {reason && (
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-amber-400/70">{reason}</span>
                        {score !== undefined && maxScore !== undefined && (
                            <div className="flex-1 max-w-[60px] h-1 rounded-full bg-white/5 overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-amber-400/50"
                                    style={{ width: `${(score / maxScore) * 100}%` }}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Duration */}
            <span className="text-xs text-white/30 tabular-nums shrink-0">
                {formatDuration(track.duration ?? null)}
            </span>

            {/* Load indicator */}
            <div className={cn(
                "px-2 py-1 rounded text-[10px] font-medium border opacity-0 group-hover:opacity-100 transition-opacity shrink-0",
                bgClass, colorClass
            )}>
                Load
            </div>
        </button>
    );
}
