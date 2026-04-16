"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Dialog,
    DialogContent,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDuration } from "@/lib/utils";
import { getTracks, getTrackById } from "@/actions/tracks";
import type { Track } from "@/db/schema";
import { useMixer } from "./mixer-context";
import type { DeckSide } from "@/lib/mixer-engine";
import { InlineDownloadModal, type TrackDownloadInfo } from "./inline-download-modal";
import {
    Search,
    Disc3,
    ChevronUp,
    ChevronDown,
    ChevronRight,
    Download,
    Loader2,
    Library,
    Music,
    Globe,
} from "lucide-react";

// ─── Provider Config ─────────────────────────────────────────────────────

interface ProviderConfig {
    id: string;
    label: string;
    icon: string;
    color: string;
    bgColor: string;
}

const PROVIDERS: ProviderConfig[] = [
    { id: "youtube", label: "YouTube", icon: "▶", color: "text-red-400", bgColor: "bg-red-500/10" },
    { id: "youtubeMusic", label: "YouTube Music", icon: "♫", color: "text-red-300", bgColor: "bg-red-500/10" },
    { id: "soundcloud", label: "SoundCloud", icon: "☁", color: "text-orange-400", bgColor: "bg-orange-500/10" },
    { id: "deezer", label: "Deezer", icon: "♪", color: "text-purple-400", bgColor: "bg-purple-500/10" },
    { id: "appleMusic", label: "Apple Music", icon: "🎵", color: "text-pink-400", bgColor: "bg-pink-500/10" },
    { id: "spotify", label: "Spotify", icon: "●", color: "text-green-400", bgColor: "bg-green-500/10" },
];

// ─── Types ───────────────────────────────────────────────────────────────

interface SearchResult {
    id: string;
    title: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    url: string;
    downloadUrl?: string;
    extractor: string;
    album?: string;
    viewCount?: number;
}

interface ProviderSearchResult {
    provider: string;
    results: SearchResult[];
    error?: string;
}

interface ProviderState {
    results: SearchResult[];
    loading: boolean;
    error?: string;
    collapsed: boolean;
    visibleCount: number;
}

// ─── Props ───────────────────────────────────────────────────────────────

interface MixerBrowserModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    targetDeck: DeckSide;
    onDeckChange: (deck: DeckSide) => void;
}

// ─── Initial visible count and load-more increment ──────────────────────

const INITIAL_VISIBLE = 5;
const LOAD_MORE_COUNT = 10;

export function MixerBrowserModal({
    open,
    onOpenChange,
    targetDeck,
    onDeckChange,
}: MixerBrowserModalProps) {
    const mixer = useMixer();

    // ── Local library state ──────────────────────────────────────────────
    const [tracks, setTracks] = useState<Track[]>([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [loading, setLoading] = useState(false);
    const [localCollapsed, setLocalCollapsed] = useState(false);
    const [localVisibleCount, setLocalVisibleCount] = useState(INITIAL_VISIBLE);
    const listRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    // ── Provider state ───────────────────────────────────────────────────
    const [enabledProviders, setEnabledProviders] = useState<Set<string>>(new Set());
    const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
    const [showProviderPicker, setShowProviderPicker] = useState(false);

    // ── Download modal state ─────────────────────────────────────────────
    const [downloadTrack, setDownloadTrack] = useState<TrackDownloadInfo | null>(null);
    const [downloadModalOpen, setDownloadModalOpen] = useState(false);

    // ── Fetch local library tracks ───────────────────────────────────────
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
            setLocalVisibleCount(INITIAL_VISIBLE);
        } finally {
            setLoading(false);
        }
    }, []);

    // ── Fetch from external providers ────────────────────────────────────
    const searchProviders = useCallback(async (query: string, providers: Set<string>) => {
        if (!query.trim() || providers.size === 0) return;

        const activeProviders = Array.from(providers);

        // Set loading state for all active providers
        setProviderStates(prev => {
            const next = { ...prev };
            for (const p of activeProviders) {
                next[p] = { ...next[p], loading: true, error: undefined, results: next[p]?.results || [], collapsed: next[p]?.collapsed ?? false, visibleCount: next[p]?.visibleCount ?? INITIAL_VISIBLE };
            }
            return next;
        });

        try {
            const res = await fetch("/api/download/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: query.trim(),
                    providers: activeProviders,
                    limit: 15,
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `Search failed: ${res.status}`);
            }

            const data = await res.json();
            const results: ProviderSearchResult[] = data.results || [];

            setProviderStates(prev => {
                const next = { ...prev };
                for (const r of results) {
                    next[r.provider] = {
                        results: r.results,
                        loading: false,
                        error: r.error,
                        collapsed: prev[r.provider]?.collapsed ?? false,
                        visibleCount: INITIAL_VISIBLE,
                    };
                }
                // Clear loading for providers that didn't return results
                for (const p of activeProviders) {
                    if (!results.find(r => r.provider === p)) {
                        next[p] = { ...next[p], loading: false };
                    }
                }
                return next;
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Search failed";
            setProviderStates(prev => {
                const next = { ...prev };
                for (const p of activeProviders) {
                    next[p] = { ...next[p], loading: false, error: message };
                }
                return next;
            });
        }
    }, []);

    // ── Open handler ─────────────────────────────────────────────────────
    useEffect(() => {
        if (open) {
            fetchTracks(search);
            setTimeout(() => searchRef.current?.focus(), 100);
        }
    }, [open]);

    // ── Debounced search ─────────────────────────────────────────────────
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const providerSearchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        if (!open) return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => fetchTracks(search), 300);
        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [search, open, fetchTracks]);

    // Provider search — longer debounce (600ms) since it's external
    useEffect(() => {
        if (!open || enabledProviders.size === 0 || !search.trim()) return;
        if (providerSearchTimerRef.current) clearTimeout(providerSearchTimerRef.current);
        providerSearchTimerRef.current = setTimeout(() => searchProviders(search, enabledProviders), 600);
        return () => { if (providerSearchTimerRef.current) clearTimeout(providerSearchTimerRef.current); };
    }, [search, open, enabledProviders, searchProviders]);

    // ── Keyboard navigation (local tracks only) ─────────────────────────
    const navigate = useCallback((direction: number) => {
        setSelectedIndex(prev => {
            const visibleTracks = localCollapsed ? 0 : Math.min(tracks.length, localVisibleCount);
            const next = Math.max(0, Math.min(visibleTracks - 1, prev + direction));
            const el = listRef.current?.querySelector(`[data-local-idx="${next}"]`) as HTMLElement;
            el?.scrollIntoView({ block: "nearest" });
            return next;
        });
    }, [tracks.length, localCollapsed, localVisibleCount]);

    const loadSelected = useCallback(() => {
        const visibleTracks = tracks.slice(0, localVisibleCount);
        const track = visibleTracks[selectedIndex];
        if (track) {
            mixer.loadTrack(targetDeck, track);
            onOpenChange(false);
        }
    }, [tracks, selectedIndex, localVisibleCount, targetDeck, mixer, onOpenChange]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") { e.preventDefault(); navigate(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); navigate(-1); }
        else if (e.key === "Enter") { e.preventDefault(); loadSelected(); }
        else if (e.key === "Tab") { e.preventDefault(); onDeckChange(targetDeck === "A" ? "B" : "A"); }
    }, [navigate, loadSelected, targetDeck, onDeckChange]);

    // ── MIDI handler ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        const handler = (e: CustomEvent) => {
            if (e.detail.action === "navigate") navigate(e.detail.direction);
            else if (e.detail.action === "load") loadSelected();
        };
        window.addEventListener("mixer-browser-action" as string, handler as EventListener);
        return () => window.removeEventListener("mixer-browser-action" as string, handler as EventListener);
    }, [open, navigate, loadSelected]);

    // ── Toggle provider ──────────────────────────────────────────────────
    const toggleProvider = useCallback((id: string) => {
        setEnabledProviders(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // ── Download handler ─────────────────────────────────────────────────
    const handleDownload = useCallback((result: SearchResult) => {
        setDownloadTrack({
            url: result.url,
            downloadUrl: result.downloadUrl,
            title: result.title,
            artist: result.uploader,
            duration: result.duration,
            thumbnail: result.thumbnail,
            extractor: result.extractor,
        });
        setDownloadModalOpen(true);
    }, []);

    const handleLoadToDeck = useCallback(async (trackId: number, deck: DeckSide) => {
        const track = await getTrackById(trackId);
        if (track) {
            mixer.loadTrack(deck, track);
            onOpenChange(false);
        }
    }, [mixer, onOpenChange]);

    // ── Provider section collapse toggle ─────────────────────────────────
    const toggleProviderCollapse = useCallback((id: string) => {
        setProviderStates(prev => ({
            ...prev,
            [id]: { ...prev[id], collapsed: !prev[id]?.collapsed },
        }));
    }, []);

    const loadMoreProvider = useCallback((id: string) => {
        setProviderStates(prev => ({
            ...prev,
            [id]: { ...prev[id], visibleCount: (prev[id]?.visibleCount || INITIAL_VISIBLE) + LOAD_MORE_COUNT },
        }));
    }, []);

    // ── Helper: count visible local tracks ───────────────────────────────
    const visibleLocalTracks = localCollapsed ? [] : tracks.slice(0, localVisibleCount);

    return (
        <>
            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    className="sm:max-w-[600px] max-h-[85vh] p-0 overflow-hidden bg-zinc-950 border-white/10 z-[80]"
                    overlayClassName="z-[79]"
                    onKeyDown={handleKeyDown}
                >
                    {/* Header */}
                    <div className="p-3 pb-2 border-b border-white/[0.06]">
                        <DialogTitle className="flex items-center justify-between text-sm font-semibold text-white/90 mb-2">
                            <div className="flex items-center gap-2">
                                <Disc3 className="h-4 w-4" />
                                Load Track
                            </div>
                            <div className="flex gap-1">
                                {(["A", "B", "C", "D"] as DeckSide[]).map(side => (
                                    <button
                                        key={side}
                                        onClick={() => onDeckChange(side)}
                                        className={cn(
                                            "px-2 py-1 rounded text-[10px] font-bold transition-colors cursor-pointer",
                                            targetDeck === side
                                                ? side === "A" || side === "C" ? "bg-purple-500/30 text-purple-300" : "bg-blue-500/30 text-blue-300"
                                                : "bg-white/5 text-white/30 hover:text-white/60"
                                        )}
                                    >
                                        {side}
                                    </button>
                                ))}
                            </div>
                        </DialogTitle>

                        {/* Search input */}
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                            <input
                                ref={searchRef}
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search local library & streaming providers..."
                                className="w-full pl-8 pr-3 py-2 rounded-md bg-white/5 border border-white/[0.08] text-xs text-white/90 placeholder-white/25 outline-none focus:border-white/20"
                            />
                        </div>

                        {/* Provider toggles */}
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            <button
                                onClick={() => setShowProviderPicker(p => !p)}
                                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] bg-white/5 text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors cursor-pointer border border-white/[0.06]"
                            >
                                <Globe className="h-3 w-3" />
                                Providers
                                <ChevronDown className={cn("h-2.5 w-2.5 transition-transform", showProviderPicker && "rotate-180")} />
                            </button>
                            {enabledProviders.size > 0 && (
                                <span className="text-[9px] text-white/25">
                                    {enabledProviders.size} active
                                </span>
                            )}
                            {/* Quick-toggle chips for enabled providers */}
                            {PROVIDERS.filter(p => enabledProviders.has(p.id)).map(p => (
                                <span key={p.id} className={cn("px-1.5 py-0.5 rounded text-[9px] font-medium", p.bgColor, p.color)}>
                                    {p.icon} {p.label}
                                </span>
                            ))}
                        </div>

                        {/* Provider picker dropdown */}
                        {showProviderPicker && (
                            <div className="mt-2 rounded-lg bg-white/[0.03] border border-white/[0.06] p-2 space-y-1">
                                <div className="flex items-center justify-between mb-1">
                                    <div className="text-[9px] uppercase tracking-wider text-white/20">Streaming Providers</div>
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            onClick={() => setEnabledProviders(new Set(PROVIDERS.map(p => p.id)))}
                                            className="text-[9px] text-purple-400/60 hover:text-purple-400 cursor-pointer transition-colors"
                                        >
                                            All
                                        </button>
                                        <span className="text-[9px] text-white/10">·</span>
                                        <button
                                            onClick={() => setEnabledProviders(new Set())}
                                            className="text-[9px] text-white/30 hover:text-white/60 cursor-pointer transition-colors"
                                        >
                                            None
                                        </button>
                                    </div>
                                </div>
                                {PROVIDERS.map(p => (
                                    <label
                                        key={p.id}
                                        className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-white/[0.04] cursor-pointer transition-colors"
                                    >
                                        <div className="relative">
                                            <input
                                                type="checkbox"
                                                checked={enabledProviders.has(p.id)}
                                                onChange={() => toggleProvider(p.id)}
                                                className="sr-only peer"
                                            />
                                            <div className={cn(
                                                "w-3.5 h-3.5 rounded border border-white/20 bg-white/5 flex items-center justify-center transition-colors",
                                                enabledProviders.has(p.id) && "bg-purple-500/30 border-purple-500/50"
                                            )}>
                                                {enabledProviders.has(p.id) && (
                                                    <svg className="w-2.5 h-2.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                    </svg>
                                                )}
                                            </div>
                                        </div>
                                        <span className={cn("text-[11px]", enabledProviders.has(p.id) ? p.color : "text-white/40")}>
                                            {p.icon} {p.label}
                                        </span>
                                    </label>
                                ))}
                                <p className="text-[8px] text-white/15 mt-1 px-1">
                                    Search results from external providers require downloading before loading to a deck
                                </p>
                            </div>
                        )}

                        <div className="flex items-center justify-between mt-2">
                            <span className="text-[10px] text-white/30">{total} tracks in library</span>
                            <div className="flex items-center gap-2 text-[9px] text-white/20">
                                <span className="flex items-center gap-0.5"><ChevronUp className="h-2.5 w-2.5" /><ChevronDown className="h-2.5 w-2.5" /> Navigate</span>
                                <span>↵ Load</span>
                                <span>Tab Deck</span>
                            </div>
                        </div>
                    </div>

                    {/* Results area */}
                    <div ref={listRef} className="overflow-y-auto max-h-[55vh]">
                        {/* ── Local Library Section ── */}
                        <div>
                            <button
                                onClick={() => setLocalCollapsed(c => !c)}
                                className="w-full flex items-center justify-between px-3 py-1.5 bg-white/[0.02] border-b border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <Library className="h-3 w-3 text-purple-400/60" />
                                    <span className="text-[10px] font-semibold text-white/60 uppercase tracking-wider">Library</span>
                                    <span className="text-[9px] text-white/25">{total} tracks</span>
                                </div>
                                <ChevronRight className={cn("h-3 w-3 text-white/20 transition-transform", !localCollapsed && "rotate-90")} />
                            </button>

                            {!localCollapsed && (
                                <>
                                    {loading && tracks.length === 0 ? (
                                        <div className="flex items-center justify-center py-8 text-white/20 text-xs">
                                            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
                                        </div>
                                    ) : visibleLocalTracks.length === 0 && search ? (
                                        <div className="flex items-center justify-center py-6 text-white/15 text-[10px] gap-1">
                                            <Search className="h-3 w-3" /> No local matches
                                        </div>
                                    ) : (
                                        <>
                                            {visibleLocalTracks.map((track, i) => (
                                                <button
                                                    key={track.id}
                                                    data-local-idx={i}
                                                    onClick={() => {
                                                        setSelectedIndex(i);
                                                        mixer.loadTrack(targetDeck, track);
                                                        onOpenChange(false);
                                                    }}
                                                    onMouseEnter={() => setSelectedIndex(i)}
                                                    className={cn(
                                                        "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors cursor-pointer",
                                                        i === selectedIndex ? "bg-white/10" : "hover:bg-white/[0.04]",
                                                        i !== visibleLocalTracks.length - 1 && "border-b border-white/[0.03]"
                                                    )}
                                                >
                                                    <div className="h-9 w-9 rounded overflow-hidden bg-white/5 shrink-0">
                                                        {track.artworkUrl ? (
                                                            <img src={track.artworkUrl} alt="" className="h-full w-full object-cover" />
                                                        ) : (
                                                            <div className="h-full w-full flex items-center justify-center">
                                                                <Disc3 className="h-4 w-4 text-white/15" />
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <div className="text-xs text-white/80 truncate">{track.title || track.filename}</div>
                                                        <div className="text-[10px] text-white/35 truncate">{track.artist || "Unknown"}</div>
                                                    </div>
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
                                                            <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-300/60 truncate max-w-[60px]">
                                                                {track.genre}
                                                            </span>
                                                        )}
                                                    </div>
                                                </button>
                                            ))}
                                            {tracks.length > localVisibleCount && (
                                                <button
                                                    onClick={() => setLocalVisibleCount(c => c + LOAD_MORE_COUNT)}
                                                    className="w-full py-2 text-[10px] text-purple-400/60 hover:text-purple-400 hover:bg-white/[0.03] transition-colors cursor-pointer"
                                                >
                                                    Show more ({tracks.length - localVisibleCount} remaining)
                                                </button>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </div>

                        {/* ── Provider Sections ── */}
                        {PROVIDERS.filter(p => enabledProviders.has(p.id)).map(provider => {
                            const state = providerStates[provider.id];
                            const results = state?.results || [];
                            const isCollapsed = state?.collapsed ?? false;
                            const visibleCount = state?.visibleCount || INITIAL_VISIBLE;
                            const visibleResults = results.slice(0, visibleCount);
                            const isLoading = state?.loading ?? false;

                            return (
                                <div key={provider.id}>
                                    {/* Provider header */}
                                    <button
                                        onClick={() => toggleProviderCollapse(provider.id)}
                                        className="w-full flex items-center justify-between px-3 py-1.5 bg-white/[0.02] border-y border-white/[0.04] cursor-pointer hover:bg-white/[0.04] transition-colors"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className={cn("text-xs", provider.color)}>{provider.icon}</span>
                                            <span className="text-[10px] font-semibold text-white/60 uppercase tracking-wider">{provider.label}</span>
                                            {isLoading ? (
                                                <Loader2 className="h-3 w-3 animate-spin text-white/20" />
                                            ) : (
                                                <span className="text-[9px] text-white/25">{results.length} results</span>
                                            )}
                                        </div>
                                        <ChevronRight className={cn("h-3 w-3 text-white/20 transition-transform", !isCollapsed && "rotate-90")} />
                                    </button>

                                    {!isCollapsed && (
                                        <>
                                            {isLoading && results.length === 0 ? (
                                                <div className="flex items-center justify-center py-6 text-white/20 text-[10px]">
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                                                    Searching {provider.label}...
                                                </div>
                                            ) : state?.error ? (
                                                <div className="px-3 py-4 text-[10px] text-red-400/60 text-center">
                                                    {state.error}
                                                </div>
                                            ) : results.length === 0 && search.trim() ? (
                                                <div className="px-3 py-4 text-[10px] text-white/15 text-center">
                                                    No results from {provider.label}
                                                </div>
                                            ) : (
                                                <>
                                                    {visibleResults.map((result) => (
                                                        <div
                                                            key={`${provider.id}-${result.id}`}
                                                            className="flex items-center gap-3 px-3 py-2 border-b border-white/[0.03] hover:bg-white/[0.04] transition-colors group"
                                                        >
                                                            {/* Thumbnail */}
                                                            <div className="h-9 w-9 rounded overflow-hidden bg-white/5 shrink-0">
                                                                {result.thumbnail ? (
                                                                    <img src={result.thumbnail} alt="" className="h-full w-full object-cover" />
                                                                ) : (
                                                                    <div className="h-full w-full flex items-center justify-center">
                                                                        <Music className="h-4 w-4 text-white/15" />
                                                                    </div>
                                                                )}
                                                            </div>

                                                            {/* Info */}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="text-xs text-white/80 truncate">{result.title}</div>
                                                                <div className="text-[10px] text-white/35 truncate">
                                                                    {result.uploader}
                                                                    {result.album && <span className="text-white/20"> · {result.album}</span>}
                                                                </div>
                                                            </div>

                                                            {/* Duration */}
                                                            {result.duration > 0 && (
                                                                <span className="text-[9px] text-white/25 tabular-nums shrink-0">
                                                                    {formatDuration(result.duration)}
                                                                </span>
                                                            )}

                                                            {/* Download button */}
                                                            <button
                                                                onClick={() => handleDownload(result)}
                                                                className="flex items-center gap-1 px-2 py-1 rounded text-[9px] font-medium bg-green-500/10 border border-green-500/20 text-green-400/70 hover:bg-green-500/20 hover:text-green-300 transition-colors cursor-pointer opacity-60 group-hover:opacity-100"
                                                                title="Download and add to library"
                                                            >
                                                                <Download className="h-3 w-3" />
                                                                <span className="hidden sm:inline">Get</span>
                                                            </button>
                                                        </div>
                                                    ))}
                                                    {results.length > visibleCount && (
                                                        <button
                                                            onClick={() => loadMoreProvider(provider.id)}
                                                            className={cn(
                                                                "w-full py-2 text-[10px] hover:bg-white/[0.03] transition-colors cursor-pointer",
                                                                provider.color,
                                                                "opacity-60 hover:opacity-100"
                                                            )}
                                                        >
                                                            Show more ({results.length - visibleCount} remaining)
                                                        </button>
                                                    )}
                                                </>
                                            )}
                                        </>
                                    )}
                                </div>
                            );
                        })}

                        {/* Empty state when no providers and no local tracks */}
                        {!loading && tracks.length === 0 && enabledProviders.size === 0 && !search && (
                            <div className="flex flex-col items-center justify-center py-12 text-white/20 text-xs gap-2">
                                <Search className="h-6 w-6 opacity-30" />
                                Search your library or enable providers
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

            {/* Download progress modal */}
            {downloadTrack && (
                <InlineDownloadModal
                    open={downloadModalOpen}
                    track={downloadTrack}
                    targetDeck={targetDeck}
                    onLoadToDeck={handleLoadToDeck}
                    onClose={() => {
                        setDownloadModalOpen(false);
                        setDownloadTrack(null);
                    }}
                />
            )}
        </>
    );
}
