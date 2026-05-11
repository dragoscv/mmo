"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
    Search,
    Loader2,
    Music,
    Globe,
    ChevronDown,
    ChevronRight,
    ListMusic,
    Download,
    Check,
    GitBranch,
    ExternalLink,
    Sparkles,
    AlertCircle,
    X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { SearchType } from "@/app/api/download/search/route";
import type { SearchDupeResult } from "@/app/api/download/search-duplicates/route";

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

const DEFAULT_PROVIDERS = new Set(["youtube", "soundcloud"]);
const PLAYLIST_CAPABLE_PROVIDERS = new Set(["youtube", "youtubeMusic", "soundcloud", "deezer", "spotify"]);

const INITIAL_VISIBLE = 5;
const LOAD_MORE_COUNT = 10;
/** Server-side limit hint for the *initial* search request. */
const INITIAL_SEARCH_LIMIT = 15;
/** Server's hard cap on per-provider results (must match the backend route). */
const MAX_SEARCH_LIMIT = 50;

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
    publishedAt?: string;
    isPlaylist?: boolean;
    trackCount?: number;
}

interface ProviderSearchResult {
    provider: string;
    results: SearchResult[];
    error?: string;
}

interface ProviderState {
    trackResults: SearchResult[];
    playlistResults: SearchResult[];
    loading: boolean;
    error?: string;
    collapsed: boolean;
    visibleCount: number;
    searchMode: SearchType;
}

/** Payload emitted when the user picks a result from the search panel. */
export interface ProviderPickPayload {
    /** Best URL to feed into the downloader pipeline. */
    url: string;
    /** Original public URL (for display / history). */
    originalUrl: string;
    title: string;
    uploader: string;
    duration: number;
    thumbnail: string;
    extractor: string;
    isPlaylist: boolean;
}

/** Per-result inline download state. */
type DownloadStatus =
    | "idle"
    | "downloading"
    | "adding"
    | "done"
    | "error";

interface DownloadState {
    status: DownloadStatus;
    percent?: number;
    speed?: string;
    eta?: string;
    error?: string;
    addedTrackId?: number;
}

/** Optional download settings forwarded from the parent page. */
export interface ProviderDownloadSettings {
    downloadFolder?: string;
    audioQuality?: string;
    audioFormat?: string;
    conversionFormat?: string;
    conversionQuality?: string;
}

const AUTO_ADD_LS_KEY = "providerSearch.autoAddToLibrary";
const SONGS_ONLY_LS_KEY = "providerSearch.songsOnly";
/** Max duration (in seconds) for a track when the "Songs only" filter is on.
 *  Anything longer is assumed to be a mix / podcast / DJ set and gets hidden. */
const SONGS_ONLY_MAX_SECONDS = 20 * 60;

function resultKey(result: SearchResult): string {
    return `${result.extractor || "x"}:${result.id}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Pretty relative date for search-result publish dates.
 *  Falls back to YYYY-MM if the input has no day component, or to the raw
 *  string if it doesn't parse. */
function formatPublished(raw?: string): string | null {
    if (!raw) return null;
    // Year-only (e.g. Spotify often returns "2018" for older albums)
    if (/^\d{4}$/.test(raw)) return raw;
    // Year-month
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const now = Date.now();
    const diffMs = now - d.getTime();
    const day = 86_400_000;
    if (diffMs < 0) {
        // Future date — just show the date
        return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
    if (diffMs < day) return "today";
    if (diffMs < 2 * day) return "yesterday";
    if (diffMs < 7 * day) return `${Math.floor(diffMs / day)}d ago`;
    if (diffMs < 30 * day) return `${Math.floor(diffMs / (7 * day))}w ago`;
    if (diffMs < 365 * day) return `${Math.floor(diffMs / (30 * day))}mo ago`;
    const years = Math.floor(diffMs / (365 * day));
    return years === 1 ? "1y ago" : `${years}y ago`;
}

// ─── Component ───────────────────────────────────────────────────────────

interface ProviderSearchPanelProps {
    /** Optional legacy callback. If provided, "Get" delegates back to the
     *  parent (e.g. for routing through the URL-paste flow). When omitted,
     *  the panel handles downloads inline with progress on each row. */
    onPick?: (payload: ProviderPickPayload) => void;
    /** Called once a track has been successfully added to the library
     *  (either via inline download or duplicate detection). */
    onTrackAdded?: (trackId: number) => void;
    /** Download settings forwarded from the parent. Used by inline downloads
     *  so they honor the user's persisted preferences. */
    downloadSettings?: ProviderDownloadSettings;
    /** Optional initial query (e.g. read from URL params). */
    initialQuery?: string;
    /** Notified whenever the user types in the query input (debounced via
     *  React state). Used by the parent to mirror the query into the URL. */
    onQueryChange?: (q: string) => void;
    /** Optional set of provider IDs that should start in the "expanded"
     *  state (i.e. with the "Show more" already applied). */
    initialExpanded?: ReadonlySet<string>;
    /** Notified when the set of expanded providers changes. */
    onExpandedChange?: (expanded: Set<string>) => void;
    /** Disable the search input (e.g. when the parent is in a busy state). */
    disabled?: boolean;
}

export function ProviderSearchPanel({
    onPick,
    onTrackAdded,
    downloadSettings,
    initialQuery = "",
    onQueryChange,
    initialExpanded,
    onExpandedChange,
    disabled = false,
}: ProviderSearchPanelProps) {
    const [query, setQuery] = useState(initialQuery);
    // Mirror query changes to the parent (e.g. for URL syncing).
    useEffect(() => {
        onQueryChange?.(query);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);
    const [enabledProviders, setEnabledProviders] = useState<Set<string>>(
        () => new Set(DEFAULT_PROVIDERS)
    );
    const [showProviderPicker, setShowProviderPicker] = useState(false);
    const [providerStates, setProviderStates] = useState<Record<string, ProviderState>>({});
    const [dupeResults, setDupeResults] = useState<Record<string, SearchDupeResult>>({});
    // Per-result inline download state (keyed by `${extractor}:${id}`).
    const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
    // Auto-download + add-to-library when the user clicks Get. Persisted.
    const [autoAddToLibrary, setAutoAddToLibrary] = useState<boolean>(() => {
        if (typeof window === "undefined") return true;
        const v = window.localStorage.getItem(AUTO_ADD_LS_KEY);
        return v === null ? true : v === "1";
    });
    useEffect(() => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(AUTO_ADD_LS_KEY, autoAddToLibrary ? "1" : "0");
    }, [autoAddToLibrary]);

    // "Songs only" filter — hides results longer than ~20 minutes (likely
    // mixes / DJ sets / podcasts). Persisted across sessions.
    const [songsOnly, setSongsOnly] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return window.localStorage.getItem(SONGS_ONLY_LS_KEY) === "1";
    });
    useEffect(() => {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(SONGS_ONLY_LS_KEY, songsOnly ? "1" : "0");
    }, [songsOnly]);

    const inputRef = useRef<HTMLInputElement>(null);
    const providerStatesRef = useRef(providerStates);
    const abortControllersRef = useRef<Record<string, AbortController>>({});
    // Stable ref to the latest initialExpanded set, so the search callback
    // always sees the current value without needing to be re-created.
    const initialExpandedRef = useRef(initialExpanded);
    useEffect(() => {
        initialExpandedRef.current = initialExpanded;
    }, [initialExpanded]);
    useEffect(() => {
        providerStatesRef.current = providerStates;
    }, [providerStates]);

    // ── Toggle a provider on/off ─────────────────────────────────────────
    const toggleProvider = useCallback((id: string) => {
        setEnabledProviders(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    // ── Duplicate detection against library ──────────────────────────────
    const checkDuplicates = useCallback(async (results: SearchResult[]) => {
        try {
            const items = results.map(r => ({
                id: r.id,
                title: r.title,
                uploader: r.uploader,
            }));
            const res = await fetch("/api/download/search-duplicates", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ items }),
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data.results) {
                setDupeResults(prev => ({ ...prev, ...data.results }));
            }
        } catch {
            // Non-critical
        }
    }, []);

    // ── Fire searches across providers ───────────────────────────────────
    const searchProviders = useCallback(
        async (
            q: string,
            providers: Set<string>,
            searchTypeOverride?: SearchType,
            limit: number = INITIAL_SEARCH_LIMIT,
        ) => {
            if (!q.trim() || providers.size === 0) return;

            const activeProviders = Array.from(providers);
            const currentStates = providerStatesRef.current;

            const providersByMode = new Map<SearchType, string[]>();
            for (const p of activeProviders) {
                const mode = searchTypeOverride || (currentStates[p]?.searchMode ?? "tracks");
                const list = providersByMode.get(mode) || [];
                list.push(p);
                providersByMode.set(mode, list);
            }

            // Mark providers as loading
            setProviderStates(prev => {
                const next = { ...prev };
                for (const p of activeProviders) {
                    const mode = searchTypeOverride || (prev[p]?.searchMode ?? "tracks");
                    next[p] = {
                        trackResults: prev[p]?.trackResults || [],
                        playlistResults: prev[p]?.playlistResults || [],
                        collapsed: prev[p]?.collapsed ?? false,
                        visibleCount: prev[p]?.visibleCount ?? INITIAL_VISIBLE,
                        searchMode: mode,
                        loading: true,
                        error: undefined,
                    };
                }
                return next;
            });

            for (const [searchType, modeProviders] of providersByMode) {
                try {
                    const res = await fetch("/api/download/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            query: q.trim(),
                            providers: modeProviders,
                            limit,
                            searchType,
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
                            const isPlaylist = searchType === "playlists";
                            const wasExpanded = initialExpandedRef.current?.has(r.provider) ?? false;
                            next[r.provider] = {
                                ...next[r.provider],
                                trackResults: isPlaylist
                                    ? prev[r.provider]?.trackResults || []
                                    : r.results,
                                playlistResults: isPlaylist
                                    ? r.results
                                    : prev[r.provider]?.playlistResults || [],
                                loading: false,
                                error: r.error,
                                collapsed: prev[r.provider]?.collapsed ?? false,
                                visibleCount: wasExpanded
                                    ? INITIAL_VISIBLE + LOAD_MORE_COUNT
                                    : INITIAL_VISIBLE,
                                searchMode: prev[r.provider]?.searchMode ?? "tracks",
                            };
                        }
                        for (const p of modeProviders) {
                            if (!results.find(r => r.provider === p)) {
                                next[p] = { ...next[p], loading: false };
                            }
                        }
                        return next;
                    });

                    if (searchType === "tracks") {
                        const allTrackResults = results.flatMap(r =>
                            r.results.filter(s => !s.isPlaylist)
                        );
                        if (allTrackResults.length > 0) {
                            checkDuplicates(allTrackResults);
                        }
                    }
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Search failed";
                    setProviderStates(prev => {
                        const next = { ...prev };
                        for (const p of modeProviders) {
                            next[p] = { ...next[p], loading: false, error: message };
                        }
                        return next;
                    });
                }
            }
             
        },
        [checkDuplicates]
    );

    // ── Debounced search on query/providers change ───────────────────────
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => {
        if (!query.trim() || enabledProviders.size === 0) return;
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => {
            searchProviders(query, enabledProviders);
        }, 500);
        return () => {
            if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        };
    }, [query, enabledProviders, searchProviders]);

    // ── Auto-focus on mount ──────────────────────────────────────────────
    useEffect(() => {
        const t = setTimeout(() => inputRef.current?.focus(), 50);
        return () => clearTimeout(t);
    }, []);

    // ── Section helpers ──────────────────────────────────────────────────
    const toggleCollapse = useCallback((id: string) => {
        setProviderStates(prev => ({
            ...prev,
            [id]: { ...prev[id], collapsed: !prev[id]?.collapsed },
        }));
    }, []);

    const loadMore = useCallback((id: string) => {
        const state = providerStatesRef.current[id];
        if (!state) return;

        const isPlaylistMode = state.searchMode === "playlists";
        const cached = isPlaylistMode ? state.playlistResults : state.trackResults;
        const currentVisible = state.visibleCount ?? INITIAL_VISIBLE;
        const targetVisible = currentVisible + LOAD_MORE_COUNT;

        // If we already have more cached than the user is seeing, just
        // reveal them. Otherwise refetch this single provider with a bigger
        // server-side limit (capped at MAX_SEARCH_LIMIT).
        if (cached.length > currentVisible) {
            setProviderStates(prev => ({
                ...prev,
                [id]: {
                    ...prev[id],
                    visibleCount: targetVisible,
                },
            }));
        } else if (cached.length < MAX_SEARCH_LIMIT && query.trim()) {
            const nextLimit = Math.min(
                MAX_SEARCH_LIMIT,
                Math.max(targetVisible, cached.length + LOAD_MORE_COUNT),
            );
            // Mark this provider as loading and fire a single-provider
            // refetch with the bigger limit.
            setProviderStates(prev => ({
                ...prev,
                [id]: {
                    ...prev[id],
                    loading: true,
                    visibleCount: targetVisible,
                },
            }));
            void searchProviders(query, new Set([id]), state.searchMode, nextLimit);
        } else {
            // Already at the server cap — just reveal whatever's left.
            setProviderStates(prev => ({
                ...prev,
                [id]: {
                    ...prev[id],
                    visibleCount: Math.min(targetVisible, cached.length),
                },
            }));
        }

        // Track expanded providers for URL syncing.
        if (onExpandedChange) {
            const current = new Set<string>();
            const states = providerStatesRef.current;
            for (const pid of Object.keys(states)) {
                if ((states[pid]?.visibleCount ?? INITIAL_VISIBLE) > INITIAL_VISIBLE) {
                    current.add(pid);
                }
            }
            current.add(id);
            onExpandedChange(current);
        }
    }, [onExpandedChange, query, searchProviders]);

    const toggleSearchMode = useCallback(
        (providerId: string, mode: SearchType) => {
            setProviderStates(prev => ({
                ...prev,
                [providerId]: {
                    ...prev[providerId],
                    searchMode: mode,
                    visibleCount: INITIAL_VISIBLE,
                    trackResults: prev[providerId]?.trackResults || [],
                    playlistResults: prev[providerId]?.playlistResults || [],
                    loading: prev[providerId]?.loading ?? false,
                    collapsed: prev[providerId]?.collapsed ?? false,
                },
            }));

            const state = providerStatesRef.current[providerId];
            const hasResults =
                mode === "playlists"
                    ? (state?.playlistResults?.length ?? 0) > 0
                    : (state?.trackResults?.length ?? 0) > 0;
            if (!hasResults && query.trim()) {
                searchProviders(query, new Set([providerId]), mode);
            }
        },
        [query, searchProviders]
    );

    // ── Pick / Download handler ──────────────────────────────────────────
    const handleDownload = useCallback(
        async (result: SearchResult) => {
            // Playlist results: still hand off to the /download page which
            // has the full multi-track UI (selection, batch progress).
            if (result.isPlaylist) {
                const url = `/download?url=${encodeURIComponent(result.url)}&auto=1`;
                window.open(url, "_blank", "noopener");
                return;
            }

            // Legacy: if parent supplied onPick, delegate (back-compat).
            if (onPick) {
                onPick({
                    url: result.downloadUrl || result.url,
                    originalUrl: result.url,
                    title: result.title,
                    uploader: result.uploader,
                    duration: result.duration,
                    thumbnail: result.thumbnail,
                    extractor: result.extractor,
                    isPlaylist: !!result.isPlaylist,
                });
                return;
            }

            const key = resultKey(result);
            // Don't double-fire while an active download is running for this row.
            const existing = downloads[key];
            if (
                existing &&
                (existing.status === "downloading" || existing.status === "adding")
            ) {
                return;
            }

            const downloadUrl = result.downloadUrl || result.url;
            const settings = downloadSettings || {};
            const audioFormat = settings.audioFormat || "auto";
            const audioQuality = settings.audioQuality || "auto";

            const controller = new AbortController();
            abortControllersRef.current[key] = controller;

            setDownloads(prev => ({
                ...prev,
                [key]: { status: "downloading", percent: 0 },
            }));

            try {
                const res = await fetch("/api/download/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        url: downloadUrl,
                        audioOnly: true,
                        audioQuality,
                        audioFormat,
                        downloadFolder: settings.downloadFolder || undefined,
                        mediaTitle: result.title,
                        mediaArtist: result.uploader,
                        mediaDuration: result.duration,
                        mediaThumbnail: result.thumbnail,
                        mediaExtractor: result.extractor,
                    }),
                    signal: controller.signal,
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error || `Download failed (${res.status})`);
                }

                const reader = res.body?.getReader();
                if (!reader) throw new Error("No response stream");

                const decoder = new TextDecoder();
                let buffer = "";
                let downloadedFile: string | null = null;
                let downloadId: number | null = null;
                let streamError: string | null = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.startsWith("data: ")) continue;
                        try {
                            const event = JSON.parse(line.slice(6));
                            switch (event.type) {
                                case "progress":
                                    setDownloads(prev => ({
                                        ...prev,
                                        [key]: {
                                            ...(prev[key] || { status: "downloading" }),
                                            status: "downloading",
                                            percent: event.percent,
                                            speed: event.speed,
                                            eta: event.eta,
                                        },
                                    }));
                                    break;
                                case "track_complete":
                                case "already_exists":
                                    downloadedFile = event.file;
                                    downloadId = event.downloadId ?? null;
                                    break;
                                case "track_error":
                                    streamError = event.error || event.message || "Download failed";
                                    break;
                                case "destination":
                                    if (!downloadedFile && event.file) {
                                        downloadedFile = event.file;
                                    }
                                    break;
                            }
                        } catch {
                            /* ignore malformed SSE chunks */
                        }
                    }
                }

                if (streamError) throw new Error(streamError);
                if (!downloadedFile) throw new Error("Download produced no file");

                if (autoAddToLibrary) {
                    setDownloads(prev => ({
                        ...prev,
                        [key]: {
                            ...(prev[key] || { status: "adding" }),
                            status: "adding",
                            percent: 100,
                        },
                    }));

                    const addRes = await fetch("/api/download/add-to-library", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            filePath: downloadedFile,
                            downloadId,
                            sourceUrl: result.url,
                            sourcePlatform: result.extractor,
                            sourceId: result.id,
                        }),
                    });
                    const addData = await addRes.json().catch(() => ({}));

                    if (!addRes.ok && addRes.status !== 409) {
                        throw new Error(addData.error || "Failed to add to library");
                    }

                    const trackId: number | undefined = addData.trackId;
                    setDownloads(prev => ({
                        ...prev,
                        [key]: {
                            status: "done",
                            percent: 100,
                            addedTrackId: trackId,
                        },
                    }));

                    if (trackId != null) {
                        // Mark the original search result as in-library so the
                        // "In Library" badge appears immediately.
                        setDupeResults(prev => ({
                            ...prev,
                            [result.id]: {
                                ...(prev[result.id] || {}),
                                inLibrary: true,
                                trackId,
                            } as SearchDupeResult,
                        }));
                        onTrackAdded?.(trackId);
                    }
                    toast.success(
                        addRes.status === 409
                            ? `"${result.title}" already in library`
                            : `Added "${result.title}" to library`
                    );
                } else {
                    setDownloads(prev => ({
                        ...prev,
                        [key]: { status: "done", percent: 100 },
                    }));
                    toast.success(`Downloaded "${result.title}"`);
                }
            } catch (err) {
                if ((err as Error).name === "AbortError") {
                    setDownloads(prev => {
                        const next = { ...prev };
                        delete next[key];
                        return next;
                    });
                    return;
                }
                const message = err instanceof Error ? err.message : "Download failed";
                setDownloads(prev => ({
                    ...prev,
                    [key]: { status: "error", error: message },
                }));
                toast.error(`Download failed: ${message}`);
            } finally {
                delete abortControllersRef.current[key];
            }
        },
        [onPick, downloads, downloadSettings, autoAddToLibrary, onTrackAdded]
    );

    const cancelDownload = useCallback((result: SearchResult) => {
        const key = resultKey(result);
        abortControllersRef.current[key]?.abort();
    }, []);

    const anyResults = Object.values(providerStates).some(
        s =>
            (s.trackResults?.length ?? 0) > 0 ||
            (s.playlistResults?.length ?? 0) > 0
    );
    const anyLoading = Object.values(providerStates).some(s => s.loading);

    return (
        <div className="space-y-3">
            {/* Search input */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Search across providers — artist, title, album..."
                    disabled={disabled}
                    className="w-full pl-10 pr-10 py-3 rounded-xl bg-card border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500/50 transition-all text-sm disabled:opacity-50"
                />
                {anyLoading && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-purple-400/60" />
                )}
            </div>

            {/* Provider toggle row */}
            <div className="flex items-center gap-1.5 flex-wrap">
                <button
                    type="button"
                    onClick={() => setShowProviderPicker(p => !p)}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer border border-border"
                >
                    <Globe className="h-3 w-3" />
                    Providers
                    <ChevronDown
                        className={cn(
                            "h-2.5 w-2.5 transition-transform",
                            showProviderPicker && "rotate-180"
                        )}
                    />
                </button>
                <span className="text-[10px] text-muted-foreground/60">
                    {enabledProviders.size} active
                </span>
                {PROVIDERS.filter(p => enabledProviders.has(p.id)).map(p => (
                    <span
                        key={p.id}
                        className={cn(
                            "px-1.5 py-0.5 rounded text-[10px] font-medium",
                            p.bgColor,
                            p.color
                        )}
                    >
                        {p.icon} {p.label}
                    </span>
                ))}

                {/* Songs only filter toggle */}
                <label
                    className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors"
                    title={`Hide results longer than ${SONGS_ONLY_MAX_SECONDS / 60} minutes (mixes, DJ sets, podcasts)`}
                >
                    <input
                        type="checkbox"
                        checked={songsOnly}
                        onChange={e => setSongsOnly(e.target.checked)}
                        className="sr-only peer"
                    />
                    <div
                        className={cn(
                            "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                            songsOnly
                                ? "bg-blue-500/30 border-blue-500/50"
                                : "bg-muted/40 border-border"
                        )}
                    >
                        {songsOnly && (
                            <svg
                                className="w-2.5 h-2.5 text-blue-300"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M5 13l4 4L19 7"
                                />
                            </svg>
                        )}
                    </div>
                    <span>Songs only</span>
                </label>

                {/* Auto add-to-library toggle */}
                <label
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] cursor-pointer select-none text-muted-foreground hover:text-foreground transition-colors"
                    title="Automatically download, analyze and add to library when you click Get"
                >
                    <input
                        type="checkbox"
                        checked={autoAddToLibrary}
                        onChange={(e) => setAutoAddToLibrary(e.target.checked)}
                        className="sr-only peer"
                    />
                    <div
                        className={cn(
                            "w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                            autoAddToLibrary
                                ? "bg-purple-500/30 border-purple-500/50"
                                : "bg-muted/40 border-border"
                        )}
                    >
                        {autoAddToLibrary && (
                            <svg
                                className="w-2.5 h-2.5 text-purple-300"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={3}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M5 13l4 4L19 7"
                                />
                            </svg>
                        )}
                    </div>
                    <Sparkles className="h-3 w-3 text-purple-400/80" />
                    <span>Auto-add to library</span>
                </label>
            </div>

            {/* Provider picker dropdown */}
            {showProviderPicker && (
                <div className="rounded-lg bg-card border border-border p-3 space-y-1">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
                            Streaming Providers
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() =>
                                    setEnabledProviders(new Set(PROVIDERS.map(p => p.id)))
                                }
                                className="text-[10px] text-purple-400 hover:text-purple-300 cursor-pointer transition-colors"
                            >
                                All
                            </button>
                            <span className="text-[10px] text-muted-foreground/30">·</span>
                            <button
                                type="button"
                                onClick={() => setEnabledProviders(new Set())}
                                className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
                            >
                                None
                            </button>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                        {PROVIDERS.map(p => (
                            <label
                                key={p.id}
                                className="flex items-center gap-2 py-1 px-1.5 rounded hover:bg-accent cursor-pointer transition-colors"
                            >
                                <input
                                    type="checkbox"
                                    checked={enabledProviders.has(p.id)}
                                    onChange={() => toggleProvider(p.id)}
                                    className="sr-only peer"
                                />
                                <div
                                    className={cn(
                                        "w-3.5 h-3.5 rounded border border-border bg-muted/40 flex items-center justify-center transition-colors",
                                        enabledProviders.has(p.id) &&
                                        "bg-purple-500/30 border-purple-500/50"
                                    )}
                                >
                                    {enabledProviders.has(p.id) && (
                                        <svg
                                            className="w-2.5 h-2.5 text-purple-400"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={3}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M5 13l4 4L19 7"
                                            />
                                        </svg>
                                    )}
                                </div>
                                <span
                                    className={cn(
                                        "text-[11px]",
                                        enabledProviders.has(p.id)
                                            ? p.color
                                            : "text-muted-foreground"
                                    )}
                                >
                                    {p.icon} {p.label}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>
            )}

            {/* Results */}
            {query.trim() && enabledProviders.size === 0 && (
                <div className="rounded-xl bg-muted/20 border border-border px-4 py-6 text-center text-xs text-muted-foreground">
                    Enable at least one provider to search.
                </div>
            )}

            {!query.trim() && (
                <div className="rounded-xl bg-muted/20 border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground/70 flex flex-col items-center gap-2">
                    <Search className="h-5 w-5 opacity-40" />
                    Start typing to search YouTube, SoundCloud, Deezer and more.
                </div>
            )}

            {query.trim() && enabledProviders.size > 0 && (
                <div className="rounded-xl bg-card border border-border overflow-hidden divide-y divide-border">
                    {PROVIDERS.filter(p => enabledProviders.has(p.id)).map(provider => {
                        const state = providerStates[provider.id];
                        const searchMode = state?.searchMode ?? "tracks";
                        const allResults =
                            searchMode === "playlists"
                                ? state?.playlistResults || []
                                : state?.trackResults || [];
                        // Apply "Songs only" filter to track lists. Playlists
                        // ignore the filter (their `duration` is always 0).
                        const results = (songsOnly && searchMode === "tracks")
                            ? allResults.filter(r =>
                                !r.duration || r.duration <= SONGS_ONLY_MAX_SECONDS
                            )
                            : allResults;
                        const hiddenCount = allResults.length - results.length;
                        const isCollapsed = state?.collapsed ?? false;
                        const visibleCount = state?.visibleCount || INITIAL_VISIBLE;
                        const visibleResults = results.slice(0, visibleCount);
                        const isLoading = state?.loading ?? false;
                        const canSearchPlaylists = PLAYLIST_CAPABLE_PROVIDERS.has(
                            provider.id
                        );

                        return (
                            <div key={provider.id}>
                                {/* Header */}
                                <div className="flex items-center justify-between px-3 py-2 bg-muted/20">
                                    <button
                                        type="button"
                                        onClick={() => toggleCollapse(provider.id)}
                                        className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                                    >
                                        <span className={cn("text-sm", provider.color)}>
                                            {provider.icon}
                                        </span>
                                        <span className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wider">
                                            {provider.label}
                                        </span>
                                        {isLoading ? (
                                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                        ) : (
                                            <span className="text-[10px] text-muted-foreground">
                                                {results.length} results
                                                {hiddenCount > 0 && (
                                                    <span
                                                        className="ml-1 text-blue-400/70"
                                                        title={`${hiddenCount} long item${hiddenCount === 1 ? "" : "s"} hidden by Songs only filter`}
                                                    >
                                                        (+{hiddenCount} hidden)
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                        <ChevronRight
                                            className={cn(
                                                "h-3 w-3 text-muted-foreground/60 transition-transform",
                                                !isCollapsed && "rotate-90"
                                            )}
                                        />
                                    </button>

                                    {canSearchPlaylists && (
                                        <div className="flex items-center bg-muted/40 rounded-md overflow-hidden border border-border">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    toggleSearchMode(provider.id, "tracks")
                                                }
                                                className={cn(
                                                    "flex items-center gap-1 px-2 py-0.5 text-[10px] transition-colors cursor-pointer",
                                                    searchMode === "tracks"
                                                        ? "bg-purple-500/20 text-purple-300"
                                                        : "text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                <Music className="h-2.5 w-2.5" />
                                                Songs
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    toggleSearchMode(provider.id, "playlists")
                                                }
                                                className={cn(
                                                    "flex items-center gap-1 px-2 py-0.5 text-[10px] transition-colors cursor-pointer",
                                                    searchMode === "playlists"
                                                        ? "bg-purple-500/20 text-purple-300"
                                                        : "text-muted-foreground hover:text-foreground"
                                                )}
                                            >
                                                <ListMusic className="h-2.5 w-2.5" />
                                                Playlists
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {!isCollapsed && (
                                    <>
                                        {isLoading && results.length === 0 ? (
                                            <div className="flex items-center justify-center py-6 text-muted-foreground text-[11px]">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                                                Searching {provider.label}...
                                            </div>
                                        ) : state?.error ? (
                                            <div className="px-3 py-4 text-[11px] text-red-400/70 text-center">
                                                {state.error}
                                            </div>
                                        ) : results.length === 0 ? (
                                            <div className="px-3 py-4 text-[11px] text-muted-foreground/60 text-center">
                                                No {searchMode === "playlists" ? "playlists" : "results"} from {provider.label}
                                            </div>
                                        ) : (
                                            <>
                                                {visibleResults.map(result => {
                                                    const dupe = dupeResults[result.id];
                                                    const isInLibrary = !!dupe?.inLibrary;
                                                    const isVariant =
                                                        !!dupe?.isVariantOf && !isInLibrary;
                                                    const dlKey = resultKey(result);
                                                    const dl = downloads[dlKey];
                                                    const isDownloading = dl?.status === "downloading";
                                                    const isAdding = dl?.status === "adding";
                                                    const isDone = dl?.status === "done";
                                                    const isErrored = dl?.status === "error";
                                                    const isBusy = isDownloading || isAdding;

                                                    return (
                                                        <div
                                                            key={`${provider.id}-${result.id}`}
                                                            className={cn(
                                                                "relative flex items-center gap-3 px-3 py-2 hover:bg-accent/40 transition-colors group",
                                                                (isInLibrary || isDone) && !isBusy && "opacity-70"
                                                            )}
                                                        >
                                                            {/* Thumbnail */}
                                                            <div className="h-10 w-10 rounded overflow-hidden bg-muted shrink-0 relative">
                                                                {result.thumbnail ? (
                                                                    // eslint-disable-next-line @next/next/no-img-element
                                                                    <img
                                                                        src={result.thumbnail}
                                                                        alt=""
                                                                        className="h-full w-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="h-full w-full flex items-center justify-center">
                                                                        {result.isPlaylist ? (
                                                                            <ListMusic className="h-4 w-4 text-muted-foreground/40" />
                                                                        ) : (
                                                                            <Music className="h-4 w-4 text-muted-foreground/40" />
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {result.isPlaylist &&
                                                                    result.trackCount != null && (
                                                                        <div className="absolute bottom-0 right-0 bg-black/70 rounded-tl px-1 text-[8px] text-white/80">
                                                                            {result.trackCount}
                                                                        </div>
                                                                    )}
                                                                {isDone && (
                                                                    <motion.div
                                                                        initial={{ opacity: 0, scale: 0.5 }}
                                                                        animate={{ opacity: 1, scale: 1 }}
                                                                        className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center shadow-lg shadow-green-500/40"
                                                                    >
                                                                        <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
                                                                    </motion.div>
                                                                )}
                                                            </div>

                                                            {/* Info */}
                                                            <div className="flex-1 min-w-0">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="text-xs text-foreground truncate">
                                                                        {result.title}
                                                                    </span>
                                                                    {isInLibrary && (
                                                                        <span className="flex items-center gap-0.5 shrink-0 px-1 py-0.5 rounded text-[9px] font-medium bg-green-500/15 text-green-400 border border-green-500/20">
                                                                            <Check className="h-2 w-2" />
                                                                            In Library
                                                                        </span>
                                                                    )}
                                                                    {isVariant && (
                                                                        <span
                                                                            className="flex items-center gap-0.5 shrink-0 px-1 py-0.5 rounded text-[9px] font-medium bg-blue-500/15 text-blue-400 border border-blue-500/20"
                                                                            title={`Variant of: ${dupe.isVariantOf!.title}`}
                                                                        >
                                                                            <GitBranch className="h-2 w-2" />
                                                                            Variant
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div className="text-[11px] text-muted-foreground truncate">
                                                                    {result.uploader}
                                                                    {result.album && (
                                                                        <span className="text-muted-foreground/60">
                                                                            {" · "}
                                                                            {result.album}
                                                                        </span>
                                                                    )}
                                                                    {formatPublished(result.publishedAt) && (
                                                                        <span
                                                                            className="text-muted-foreground/60"
                                                                            title={result.publishedAt}
                                                                        >
                                                                            {" · "}
                                                                            {formatPublished(result.publishedAt)}
                                                                        </span>
                                                                    )}
                                                                    {result.isPlaylist &&
                                                                        result.trackCount != null && (
                                                                            <span className="text-muted-foreground/60">
                                                                                {" · "}
                                                                                {result.trackCount} tracks
                                                                            </span>
                                                                        )}
                                                                </div>
                                                            </div>

                                                            {!result.isPlaylist &&
                                                                result.duration > 0 && (
                                                                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                                                                        {formatDuration(result.duration)}
                                                                    </span>
                                                                )}

                                                            {/* Action / inline status */}
                                                            <div className="shrink-0 flex items-center gap-1">
                                                                <AnimatePresence mode="wait" initial={false}>
                                                                    {result.isPlaylist ? (
                                                                        <motion.button
                                                                            key="open"
                                                                            type="button"
                                                                            onClick={() => handleDownload(result)}
                                                                            initial={{ opacity: 0, y: -4 }}
                                                                            animate={{ opacity: 1, y: 0 }}
                                                                            exit={{ opacity: 0, y: 4 }}
                                                                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-colors cursor-pointer"
                                                                        >
                                                                            <ExternalLink className="h-3 w-3" />
                                                                            Open
                                                                        </motion.button>
                                                                    ) : isDone ? (
                                                                        <motion.span
                                                                            key="done"
                                                                            initial={{ opacity: 0, scale: 0.85 }}
                                                                            animate={{ opacity: 1, scale: 1 }}
                                                                            exit={{ opacity: 0, scale: 0.85 }}
                                                                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-green-500/15 border border-green-500/30 text-green-400"
                                                                        >
                                                                            <Check className="h-3 w-3" strokeWidth={3} />
                                                                            {dl?.addedTrackId ? "Added" : "Done"}
                                                                        </motion.span>
                                                                    ) : isAdding ? (
                                                                        <motion.span
                                                                            key="adding"
                                                                            initial={{ opacity: 0 }}
                                                                            animate={{ opacity: 1 }}
                                                                            exit={{ opacity: 0 }}
                                                                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-purple-500/10 border border-purple-500/20 text-purple-300"
                                                                        >
                                                                            <Loader2 className="h-3 w-3 animate-spin" />
                                                                            Analyzing…
                                                                        </motion.span>
                                                                    ) : isDownloading ? (
                                                                        <motion.div
                                                                            key="downloading"
                                                                            initial={{ opacity: 0 }}
                                                                            animate={{ opacity: 1 }}
                                                                            exit={{ opacity: 0 }}
                                                                            className="flex items-center gap-1.5"
                                                                        >
                                                                            <span className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-purple-500/10 border border-purple-500/20 text-purple-300 tabular-nums">
                                                                                <Loader2 className="h-3 w-3 animate-spin" />
                                                                                {Math.round(dl?.percent ?? 0)}%
                                                                            </span>
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => cancelDownload(result)}
                                                                                title="Cancel download"
                                                                                className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
                                                                            >
                                                                                <X className="h-3 w-3" />
                                                                            </button>
                                                                        </motion.div>
                                                                    ) : isErrored ? (
                                                                        <motion.button
                                                                            key="error"
                                                                            type="button"
                                                                            onClick={() => handleDownload(result)}
                                                                            initial={{ opacity: 0 }}
                                                                            animate={{ opacity: 1 }}
                                                                            exit={{ opacity: 0 }}
                                                                            title={dl?.error || "Retry"}
                                                                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
                                                                        >
                                                                            <AlertCircle className="h-3 w-3" />
                                                                            Retry
                                                                        </motion.button>
                                                                    ) : (
                                                                        <motion.button
                                                                            key="get"
                                                                            type="button"
                                                                            onClick={() => handleDownload(result)}
                                                                            initial={{ opacity: 0 }}
                                                                            animate={{ opacity: 1 }}
                                                                            exit={{ opacity: 0 }}
                                                                            className={cn(
                                                                                "flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer opacity-80 group-hover:opacity-100",
                                                                                isInLibrary
                                                                                    ? "bg-muted text-muted-foreground border border-border hover:bg-accent"
                                                                                    : "bg-purple-500/10 border border-purple-500/20 text-purple-300 hover:bg-purple-500/20"
                                                                            )}
                                                                        >
                                                                            <Download className="h-3 w-3" />
                                                                            {isInLibrary ? "Re-Get" : "Get"}
                                                                        </motion.button>
                                                                    )}
                                                                </AnimatePresence>
                                                            </div>

                                                            {/* Inline progress bar across the bottom of the row */}
                                                            <AnimatePresence>
                                                                {(isDownloading || isAdding) && (
                                                                    <motion.div
                                                                        key="bar"
                                                                        initial={{ opacity: 0, scaleX: 0 }}
                                                                        animate={{ opacity: 1, scaleX: 1 }}
                                                                        exit={{ opacity: 0 }}
                                                                        style={{ originX: 0 }}
                                                                        className="absolute left-0 right-0 bottom-0 h-0.5 bg-purple-500/10 overflow-hidden"
                                                                    >
                                                                        <motion.div
                                                                            className="h-full bg-gradient-to-r from-purple-500 via-fuchsia-500 to-purple-400"
                                                                            animate={{
                                                                                width: isAdding
                                                                                    ? "100%"
                                                                                    : `${Math.max(2, Math.min(100, dl?.percent ?? 0))}%`,
                                                                            }}
                                                                            transition={{ duration: 0.25, ease: "easeOut" }}
                                                                        />
                                                                        {isAdding && (
                                                                            <motion.div
                                                                                className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent"
                                                                                animate={{ x: ["-100%", "100%"] }}
                                                                                transition={{
                                                                                    duration: 1.2,
                                                                                    repeat: Infinity,
                                                                                    ease: "linear",
                                                                                }}
                                                                            />
                                                                        )}
                                                                    </motion.div>
                                                                )}
                                                            </AnimatePresence>
                                                        </div>
                                                    );
                                                })}
                                                {(results.length > visibleCount ||
                                                    (results.length < MAX_SEARCH_LIMIT && !state?.loading)) && (
                                                        <button
                                                            type="button"
                                                            onClick={() => loadMore(provider.id)}
                                                            disabled={state?.loading}
                                                            className={cn(
                                                                "w-full py-2 text-[11px] hover:bg-accent/40 transition-colors cursor-pointer disabled:opacity-50",
                                                                provider.color,
                                                                "opacity-70 hover:opacity-100"
                                                            )}
                                                        >
                                                            {state?.loading
                                                                ? "Loading more…"
                                                                : results.length > visibleCount
                                                                    ? `Show more (${results.length - visibleCount} remaining)`
                                                                    : "Load more from " + provider.label}
                                                        </button>
                                                    )}
                                            </>
                                        )}
                                    </>
                                )}
                            </div>
                        );
                    })}

                    {/* Bottom hint when nothing has loaded yet */}
                    {!anyResults && !anyLoading && query.trim() && (
                        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground/60">
                            No results yet — try a different query.
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
