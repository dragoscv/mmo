"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getTracks } from "@/actions/tracks";
import type { Track } from "@/db/schema";
import { useMixer } from "./mixer-context";
import {
    Search,
    Upload,
    Disc3,
    ChevronUp,
    ChevronDown,
} from "lucide-react";

interface MixerBrowserModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    targetDeck: "A" | "B";
    onDeckChange: (deck: "A" | "B") => void;
}

export function MixerBrowserModal({
    open,
    onOpenChange,
    targetDeck,
    onDeckChange,
}: MixerBrowserModalProps) {
    const mixer = useMixer();
    const [tracks, setTracks] = useState<Track[]>([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [loading, setLoading] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    // Fetch tracks
    const fetchTracks = useCallback(async (query: string) => {
        setLoading(true);
        try {
            const result = await getTracks({
                search: query || undefined,
                pageSize: 200,
                sort: "title",
                order: "asc",
            });
            setTracks(result.tracks);
            setTotal(result.total);
            setSelectedIndex(0);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (open) {
            fetchTracks(search);
            // Focus search on open
            setTimeout(() => searchRef.current?.focus(), 100);
        }
    }, [open]);

    // Debounced search
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
    useEffect(() => {
        if (!open) return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => fetchTracks(search), 300);
        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [search, open, fetchTracks]);

    // Navigate with browse encoder (called from parent)
    const navigate = useCallback((direction: number) => {
        setSelectedIndex(prev => {
            const next = Math.max(0, Math.min(tracks.length - 1, prev + direction));
            // Scroll into view
            const el = listRef.current?.children[next] as HTMLElement;
            el?.scrollIntoView({ block: "nearest" });
            return next;
        });
    }, [tracks.length]);

    // Load selected track into target deck
    const loadSelected = useCallback(() => {
        const track = tracks[selectedIndex];
        if (track) {
            mixer.loadTrack(targetDeck, track);
            onOpenChange(false);
        }
    }, [tracks, selectedIndex, targetDeck, mixer, onOpenChange]);

    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            navigate(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            navigate(-1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            loadSelected();
        } else if (e.key === "Tab") {
            e.preventDefault();
            onDeckChange(targetDeck === "A" ? "B" : "A");
        }
    }, [navigate, loadSelected, targetDeck, onDeckChange]);

    // Expose navigate/load for MIDI
    useEffect(() => {
        if (!open) return;
        const handler = (e: CustomEvent) => {
            if (e.detail.action === "navigate") navigate(e.detail.direction);
            else if (e.detail.action === "load") loadSelected();
        };
        window.addEventListener("mixer-browser-action" as string, handler as EventListener);
        return () => window.removeEventListener("mixer-browser-action" as string, handler as EventListener);
    }, [open, navigate, loadSelected]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[560px] max-h-[80vh] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[80]"
                overlayClassName="z-[79]"
                onKeyDown={handleKeyDown}
            >
                <div className="p-3 pb-2 border-b border-white/[0.06]">
                    <DialogTitle className="flex items-center justify-between text-sm font-semibold text-white/90 mb-2">
                        <div className="flex items-center gap-2">
                            <Disc3 className="h-4 w-4" />
                            Load Track
                        </div>
                        <div className="flex gap-1">
                            <button
                                onClick={() => onDeckChange("A")}
                                className={cn(
                                    "px-2.5 py-1 rounded text-[10px] font-bold transition-colors cursor-pointer",
                                    targetDeck === "A"
                                        ? "bg-purple-500/30 text-purple-300"
                                        : "bg-white/5 text-white/30 hover:text-white/60"
                                )}
                            >
                                Deck A
                            </button>
                            <button
                                onClick={() => onDeckChange("B")}
                                className={cn(
                                    "px-2.5 py-1 rounded text-[10px] font-bold transition-colors cursor-pointer",
                                    targetDeck === "B"
                                        ? "bg-blue-500/30 text-blue-300"
                                        : "bg-white/5 text-white/30 hover:text-white/60"
                                )}
                            >
                                Deck B
                            </button>
                        </div>
                    </DialogTitle>
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                        <input
                            ref={searchRef}
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search tracks..."
                            className="w-full pl-8 pr-3 py-2 rounded-md bg-white/5 border border-white/[0.08] text-xs text-white/90 placeholder-white/25 outline-none focus:border-white/20"
                        />
                    </div>
                    <div className="flex items-center justify-between mt-2">
                        <span className="text-[10px] text-white/30">{total} tracks</span>
                        <div className="flex items-center gap-2 text-[9px] text-white/20">
                            <span className="flex items-center gap-0.5"><ChevronUp className="h-2.5 w-2.5" /><ChevronDown className="h-2.5 w-2.5" /> Navigate</span>
                            <span>↵ Load</span>
                            <span>Tab Deck</span>
                        </div>
                    </div>
                </div>

                <div ref={listRef} className="overflow-y-auto max-h-[55vh]">
                    {loading && tracks.length === 0 ? (
                        <div className="flex items-center justify-center py-12 text-white/20 text-xs">
                            Loading...
                        </div>
                    ) : tracks.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-white/20 text-xs gap-2">
                            <Search className="h-6 w-6 opacity-30" />
                            No tracks found
                        </div>
                    ) : (
                        tracks.map((track, i) => (
                            <button
                                key={track.id}
                                onClick={() => {
                                    setSelectedIndex(i);
                                    mixer.loadTrack(targetDeck, track);
                                    onOpenChange(false);
                                }}
                                onMouseEnter={() => setSelectedIndex(i)}
                                className={cn(
                                    "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer",
                                    i === selectedIndex
                                        ? "bg-white/10"
                                        : "hover:bg-white/[0.04]",
                                    i !== tracks.length - 1 && "border-b border-white/[0.03]"
                                )}
                            >
                                {/* Artwork */}
                                <div className="h-9 w-9 rounded overflow-hidden bg-white/5 shrink-0">
                                    {track.artworkUrl ? (
                                        <img src={track.artworkUrl} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                        <div className="h-full w-full flex items-center justify-center">
                                            <Disc3 className="h-4 w-4 text-white/15" />
                                        </div>
                                    )}
                                </div>

                                {/* Track info */}
                                <div className="flex-1 min-w-0">
                                    <div className="text-xs text-white/80 truncate">
                                        {track.title || track.filename}
                                    </div>
                                    <div className="text-[10px] text-white/35 truncate">
                                        {track.artist || "Unknown"}
                                    </div>
                                </div>

                                {/* Metadata badges */}
                                <div className="flex items-center gap-1.5 shrink-0">
                                    {track.bpm && (
                                        <span className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-white/30 tabular-nums">
                                            {Math.round(track.bpm)}
                                        </span>
                                    )}
                                    {track.keyCamelot && (
                                        <span className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-white/30">
                                            {track.keyCamelot}
                                        </span>
                                    )}
                                    {track.genre && (
                                        <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400/50 max-w-16 truncate">
                                            {track.genre}
                                        </span>
                                    )}
                                </div>

                                {/* Load indicator */}
                                {i === selectedIndex && (
                                    <Upload className={cn(
                                        "h-3.5 w-3.5 shrink-0",
                                        targetDeck === "A" ? "text-purple-400/60" : "text-blue-400/60"
                                    )} />
                                )}
                            </button>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
