"use client";

import { useState, useEffect, useCallback, useRef, memo } from "react";
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
    Music,
    FolderOpen,
    AudioWaveform,
    Clock,
    X,
    Check,
    FileAudio,
    Loader2,
} from "lucide-react";

interface SamplePickerModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    slotIndex: number;
}

export const SamplePickerModal = memo(function SamplePickerModal({
    open,
    onOpenChange,
    slotIndex,
}: SamplePickerModalProps) {
    const mixer = useMixer();
    const [tab, setTab] = useState<"library" | "file">("library");
    const [tracks, setTracks] = useState<Track[]>([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [loading, setLoading] = useState(false);
    const [loadingSlot, setLoadingSlot] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Fetch tracks from library
    const fetchTracks = useCallback(async (query: string) => {
        setLoading(true);
        try {
            const result = await getTracks({
                search: query || undefined,
                pageSize: 100,
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
        if (open && tab === "library") {
            fetchTracks(search);
            setTimeout(() => searchRef.current?.focus(), 100);
        }
    }, [open, tab]);

    // Debounced search
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
        if (!open || tab !== "library") return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => fetchTracks(search), 300);
        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [search, open, tab, fetchTracks]);

    // Load track from library into sampler slot
    const loadFromLibrary = useCallback(async (track: Track) => {
        setLoadingSlot(true);
        try {
            await mixer.loadSample(slotIndex, `/api/audio/${track.id}`, track.title || track.filename);
            onOpenChange(false);
        } finally {
            setLoadingSlot(false);
        }
    }, [mixer, slotIndex, onOpenChange]);

    // Load file from disk
    const loadFromFile = useCallback(async (file: File) => {
        if (!file.type.startsWith("audio/") && !file.name.match(/\.(wav|mp3|ogg|flac|aac|m4a|webm|aiff?)$/i)) {
            return;
        }
        setLoadingSlot(true);
        try {
            const success = await mixer.loadSampleFromFile(slotIndex, file);
            if (success) {
                onOpenChange(false);
            }
        } finally {
            setLoadingSlot(false);
        }
    }, [mixer, slotIndex, onOpenChange]);

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) loadFromFile(file);
        // Reset so the same file can be picked again
        e.target.value = "";
    }, [loadFromFile]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) loadFromFile(file);
    }, [loadFromFile]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(true);
    }, []);

    const handleDragLeave = useCallback(() => {
        setDragOver(false);
    }, []);

    // Keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (tab !== "library") return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(tracks.length - 1, prev + 1));
            const el = listRef.current?.children[Math.min(tracks.length - 1, selectedIndex + 1)] as HTMLElement;
            el?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(0, prev - 1));
            const el = listRef.current?.children[Math.max(0, selectedIndex - 1)] as HTMLElement;
            el?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
            e.preventDefault();
            const track = tracks[selectedIndex];
            if (track) loadFromLibrary(track);
        }
    }, [tab, tracks, selectedIndex, loadFromLibrary]);

    // Reset state on open
    useEffect(() => {
        if (open) {
            setSearch("");
            setSelectedIndex(0);
            setTab("library");
            setLoadingSlot(false);
            setDragOver(false);
        }
    }, [open]);

    const slot = mixer.samplerSlots[slotIndex];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[520px] max-h-[75vh] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[80]"
                overlayClassName="z-[79]"
                onKeyDown={handleKeyDown}
            >
                {/* Header */}
                <div className="p-3 pb-2 border-b border-white/[0.06]">
                    <DialogTitle className="flex items-center justify-between text-sm font-semibold text-white/90 mb-2">
                        <div className="flex items-center gap-2">
                            <div className="h-6 w-6 rounded-md bg-orange-500/20 flex items-center justify-center">
                                <Music className="h-3.5 w-3.5 text-orange-400" />
                            </div>
                            <span>Load Sample → Pad {slotIndex + 1}</span>
                        </div>
                        {slot?.buffer && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400/70">
                                {slot.name}
                            </span>
                        )}
                    </DialogTitle>

                    {/* Tabs */}
                    <div className="flex gap-1 mb-2">
                        <button
                            onClick={() => setTab("library")}
                            className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer",
                                tab === "library"
                                    ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                                    : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] border border-white/[0.06]"
                            )}
                        >
                            <Disc3 className="h-3.5 w-3.5" />
                            Library
                        </button>
                        <button
                            onClick={() => setTab("file")}
                            className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[11px] font-medium transition-all cursor-pointer",
                                tab === "file"
                                    ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                                    : "bg-white/[0.03] text-white/40 hover:bg-white/[0.06] border border-white/[0.06]"
                            )}
                        >
                            <FolderOpen className="h-3.5 w-3.5" />
                            From File
                        </button>
                    </div>

                    {/* Search (library tab only) */}
                    {tab === "library" && (
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                            <input
                                ref={searchRef}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search tracks to use as sample..."
                                className="w-full pl-8 pr-3 py-2 rounded-md bg-white/5 border border-white/[0.08] text-xs text-white/90 placeholder-white/25 outline-none focus:border-orange-500/30 transition-colors"
                            />
                        </div>
                    )}
                </div>

                {/* Loading overlay */}
                {loadingSlot && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                        <div className="flex flex-col items-center gap-2">
                            <Loader2 className="h-6 w-6 text-orange-400 animate-spin" />
                            <span className="text-xs text-white/60">Loading sample...</span>
                        </div>
                    </div>
                )}

                {/* Library Tab */}
                {tab === "library" && (
                    <>
                        <div className="flex items-center justify-between px-3 py-1 border-b border-white/[0.04]">
                            <span className="text-[10px] text-white/30">{total} tracks available</span>
                            <span className="text-[9px] text-white/20">↑↓ Navigate · ↵ Load</span>
                        </div>
                        <div ref={listRef} className="overflow-y-auto max-h-[45vh]">
                            {loading && tracks.length === 0 ? (
                                <div className="flex items-center justify-center py-12 text-white/20 text-xs gap-2">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Loading tracks...
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
                                        onClick={() => loadFromLibrary(track)}
                                        onMouseEnter={() => setSelectedIndex(i)}
                                        className={cn(
                                            "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer",
                                            i === selectedIndex
                                                ? "bg-orange-500/10"
                                                : "hover:bg-white/[0.04]",
                                            i !== tracks.length - 1 && "border-b border-white/[0.03]"
                                        )}
                                    >
                                        {/* Artwork */}
                                        <div className="h-8 w-8 rounded overflow-hidden bg-white/5 shrink-0">
                                            {track.artworkUrl ? (
                                                <img src={track.artworkUrl} alt="" className="h-full w-full object-cover" />
                                            ) : (
                                                <div className="h-full w-full flex items-center justify-center">
                                                    <AudioWaveform className="h-3.5 w-3.5 text-white/15" />
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
                                        <div className="flex items-center gap-1 shrink-0">
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
                                            {track.duration && (
                                                <span className="text-[9px] px-1 py-0.5 rounded bg-white/5 text-white/25 tabular-nums flex items-center gap-0.5">
                                                    <Clock className="h-2.5 w-2.5" />
                                                    {Math.floor(track.duration / 60)}:{(track.duration % 60).toString().padStart(2, "0")}
                                                </span>
                                            )}
                                        </div>

                                        {/* Load indicator */}
                                        {i === selectedIndex && (
                                            <Check className="h-3.5 w-3.5 text-orange-400/60 shrink-0" />
                                        )}
                                    </button>
                                ))
                            )}
                        </div>
                    </>
                )}

                {/* File Tab */}
                {tab === "file" && (
                    <div className="p-4">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="audio/*,.wav,.mp3,.ogg,.flac,.aac,.m4a,.webm,.aif,.aiff"
                            onChange={handleFileSelect}
                            className="hidden"
                        />

                        {/* Drag & drop zone */}
                        <div
                            onDrop={handleDrop}
                            onDragOver={handleDragOver}
                            onDragLeave={handleDragLeave}
                            onClick={() => fileInputRef.current?.click()}
                            className={cn(
                                "relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-all",
                                dragOver
                                    ? "border-orange-400 bg-orange-500/10 scale-[1.02]"
                                    : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
                            )}
                        >
                            <div className={cn(
                                "h-14 w-14 rounded-full flex items-center justify-center transition-colors",
                                dragOver ? "bg-orange-500/20" : "bg-white/5"
                            )}>
                                <FileAudio className={cn(
                                    "h-7 w-7 transition-colors",
                                    dragOver ? "text-orange-400" : "text-white/30"
                                )} />
                            </div>
                            <div className="text-center">
                                <p className={cn(
                                    "text-sm font-medium transition-colors",
                                    dragOver ? "text-orange-300" : "text-white/60"
                                )}>
                                    {dragOver ? "Drop audio file here" : "Click to browse or drag & drop"}
                                </p>
                                <p className="text-[10px] text-white/25 mt-1">
                                    WAV, MP3, OGG, FLAC, AAC, M4A, AIFF
                                </p>
                            </div>
                        </div>

                        {/* Quick tip */}
                        <div className="mt-3 flex items-start gap-2 rounded-lg bg-white/[0.02] border border-white/[0.06] p-2.5">
                            <Upload className="h-3.5 w-3.5 text-white/20 mt-0.5 shrink-0" />
                            <div>
                                <p className="text-[10px] text-white/40">
                                    Load any audio file as a one-shot or looping sample.
                                    Use short clips for best results. Shift+click the pad to clear it later.
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
});
