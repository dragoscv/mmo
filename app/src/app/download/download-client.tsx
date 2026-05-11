"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import {
    Download, Search, Music, Video, FileAudio, Loader2, CheckCircle2,
    AlertCircle, Library, ExternalLink, X, ChevronDown, ChevronUp,
    Globe, Clock, User, Play, HardDrive, FolderOpen, Settings2,
    Trash2, History, Sparkles, Image as ImageIcon, MicVocal, Tag,
    ListMusic, CheckSquare, Square, CheckCheck, XSquare, FolderPlus, Plus,
    Link as LinkIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    ProviderSearchPanel,
} from "@/components/provider-search-panel";
import {
    LatestDownloadsList,
    useLatestDownloads,
} from "@/components/latest-downloads-list";
import { DownloadSidebar } from "@/components/download-sidebar";
import { getTrackById, getTracks } from "@/actions/tracks";

// ─── Types ───────────────────────────────────────────────────────────────

interface MediaFormat {
    formatId: string;
    ext: string;
    resolution: string;
    filesize: number | null;
    filesizeApprox: number | null;
    acodec: string;
    vcodec: string;
    abr: number | null;
    vbr: number | null;
    fps: number | null;
    tbr: number | null;
    quality: string;
    type: "audio" | "video" | "audio+video";
}

interface MediaInfo {
    id: string;
    title: string;
    description: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    uploaderUrl: string;
    webpage_url: string;
    extractor: string;
    formats: MediaFormat[];
}

interface DownloadProgress {
    percent: number;
    totalSize: string;
    speed: string;
    eta: string;
}

interface PlaylistEntry {
    id: string;
    title: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    url: string;
}

interface PlaylistInfo {
    _type: "playlist";
    id: string;
    title: string;
    description: string;
    uploader: string;
    uploaderUrl: string;
    webpage_url: string;
    extractor: string;
    thumbnail: string;
    entryCount: number;
    entries: PlaylistEntry[];
}

interface BatchTrackResult {
    trackIndex: number;
    title: string;
    file: string;
    downloadId: number;
    error?: string;
    addedTrackId?: number;
    addError?: string;
}

interface DownloadHistoryItem {
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

interface FolderEntry {
    name: string;
    path: string;
    isDir: boolean;
}

type DownloadStatus = "idle" | "fetching-info" | "ready" | "downloading" | "complete" | "error" | "adding-to-library" | "added" | "batch-downloading" | "batch-complete" | "batch-adding";

// ─── Audio Quality Options ───────────────────────────────────────────────

const AUDIO_QUALITIES = [
    { value: "auto", label: "Auto (Highest)", desc: "Best available quality per track" },
    { value: "0", label: "Best (VBR)", desc: "Highest quality variable bitrate" },
    { value: "320", label: "320 kbps", desc: "CD quality" },
    { value: "256", label: "256 kbps", desc: "High quality" },
    { value: "192", label: "192 kbps", desc: "Good quality" },
    { value: "128", label: "128 kbps", desc: "Standard quality" },
];

const AUDIO_FORMATS = [
    { value: "auto", label: "Auto (Best)" },
    { value: "flac", label: "FLAC" },
    { value: "wav", label: "WAV" },
    { value: "opus", label: "Opus" },
    { value: "m4a", label: "M4A/AAC" },
    { value: "mp3", label: "MP3" },
];

const CONVERSION_FORMATS = [
    { value: "auto", label: "Auto (FLAC)" },
    { value: "flac", label: "FLAC" },
    { value: "wav", label: "WAV" },
    { value: "mp3", label: "MP3" },
    { value: "m4a", label: "M4A/AAC" },
    { value: "opus", label: "Opus" },
];

const CONVERSION_QUALITIES = [
    { value: "auto", label: "Auto (Best)", desc: "Lossless or highest available" },
    { value: "0", label: "Best (VBR)", desc: "Highest quality variable bitrate" },
    { value: "320", label: "320 kbps", desc: "CD quality" },
    { value: "256", label: "256 kbps", desc: "High quality" },
    { value: "192", label: "192 kbps", desc: "Good quality" },
    { value: "128", label: "128 kbps", desc: "Standard quality" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatFileSize(bytes: number | null): string {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getPlatformIcon(extractor: string): string {
    const e = extractor.toLowerCase();
    if (e.includes("youtube")) return "🎬";
    if (e.includes("soundcloud")) return "☁️";
    if (e.includes("spotify")) return "🎵";
    if (e.includes("bandcamp")) return "🎸";
    if (e.includes("vimeo")) return "🎥";
    if (e.includes("twitch")) return "🟣";
    if (e.includes("tiktok")) return "📱";
    if (e.includes("twitter") || e.includes("x")) return "𝕏";
    if (e.includes("instagram")) return "📷";
    if (e.includes("facebook")) return "📘";
    return "🌐";
}

function timeAgo(dateStr: string): string {
    const d = new Date(dateStr + "Z");
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

// ─── Folder Picker ───────────────────────────────────────────────────────

function FolderPicker({ currentPath, onSelect, onClose }: {
    currentPath: string;
    onSelect: (path: string) => void;
    onClose: () => void;
}) {
    const [dir, setDir] = useState(currentPath);
    const [entries, setEntries] = useState<FolderEntry[]>([]);
    const [parent, setParent] = useState<string | null>(null);
    const [drives, setDrives] = useState<string[] | undefined>();
    const [loading, setLoading] = useState(true);
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [creating, setCreating] = useState(false);

    const browse = useCallback(async (target?: string) => {
        setLoading(true);
        try {
            const res = await fetch("/api/download/browse-folder", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dir: target }),
            });
            const data = await res.json();
            if (res.ok) {
                setDir(data.current);
                setEntries(data.entries || []);
                setParent(data.parent);
                if (data.drives) setDrives(data.drives);
            }
        } catch { /* ignore */ }
        setLoading(false);
    }, []);

    const createFolder = useCallback(async () => {
        const name = newFolderName.trim();
        if (!name || !dir) return;
        setCreating(true);
        try {
            const res = await fetch("/api/download/browse-folder", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dir, name }),
            });
            if (res.ok) {
                const data = await res.json();
                setShowNewFolder(false);
                setNewFolderName("");
                browse(data.created);
            } else {
                const data = await res.json();
                toast.error(data.error || "Failed to create folder");
            }
        } catch {
            toast.error("Failed to create folder");
        }
        setCreating(false);
    }, [dir, newFolderName, browse]);

    useEffect(() => { browse(currentPath || undefined); }, [browse, currentPath]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <FolderOpen className="h-4 w-4 text-purple-500" />
                        Select Download Folder
                    </h3>
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Current path */}
                <div className="px-4 py-2 bg-muted/30 border-b border-border">
                    <p className="text-xs font-mono text-muted-foreground truncate">{dir}</p>
                </div>

                {/* Drives (Windows) */}
                {drives && drives.length > 0 && (
                    <div className="px-4 py-2 flex gap-1 border-b border-border">
                        {drives.map(d => (
                            <button
                                key={d}
                                onClick={() => browse(d)}
                                className={cn(
                                    "px-2 py-0.5 rounded text-xs font-mono cursor-pointer transition-colors",
                                    dir.startsWith(d) ? "bg-purple-500/20 text-purple-400" : "bg-muted text-muted-foreground hover:bg-accent"
                                )}
                            >
                                {d}
                            </button>
                        ))}
                    </div>
                )}

                {/* Folder list */}
                <div className="max-h-72 overflow-y-auto">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                    ) : (
                        <>
                            {parent && (
                                <button
                                    onClick={() => browse(parent)}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
                                >
                                    <FolderOpen className="h-3.5 w-3.5" />
                                    ..
                                </button>
                            )}
                            {entries.length === 0 && (
                                <p className="text-xs text-muted-foreground/50 text-center py-6">No subfolders</p>
                            )}
                            {entries.map(e => (
                                <button
                                    key={e.path}
                                    onClick={() => browse(e.path)}
                                    className="w-full flex items-center gap-2 px-4 py-2 text-xs text-foreground/80 hover:bg-accent transition-colors cursor-pointer"
                                >
                                    <FolderOpen className="h-3.5 w-3.5 text-yellow-500/70" />
                                    {e.name}
                                </button>
                            ))}
                        </>
                    )}
                </div>

                {/* New Folder */}
                {showNewFolder && (
                    <div className="flex items-center gap-2 px-4 py-2.5 border-t border-border bg-muted/20">
                        <FolderPlus className="h-3.5 w-3.5 text-purple-400 shrink-0" />
                        <input
                            type="text"
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") createFolder(); if (e.key === "Escape") { setShowNewFolder(false); setNewFolderName(""); } }}
                            placeholder="Folder name"
                            autoFocus
                            className="flex-1 px-2 py-1 rounded-md bg-muted/50 border border-border text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-purple-500/40"
                        />
                        <button
                            onClick={createFolder}
                            disabled={!newFolderName.trim() || creating}
                            className="px-2.5 py-1 rounded-md bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
                        </button>
                        <button
                            onClick={() => { setShowNewFolder(false); setNewFolderName(""); }}
                            className="p-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}

                {/* Actions */}
                <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
                    <button
                        onClick={onClose}
                        className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                        Cancel
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowNewFolder(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-accent border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        >
                            <Plus className="h-3 w-3" />
                            New Folder
                        </button>
                        <button
                            onClick={() => onSelect(dir)}
                            className="px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors cursor-pointer"
                        >
                            Select This Folder
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─── Component ───────────────────────────────────────────────────────────

export function DownloadClient() {
    useRenderCount("Page:/download");
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();
    const initialUrl = searchParams.get("url") || "";
    const autoDownload = searchParams.get("auto") === "1";
    const initialTab = searchParams.get("tab") === "search" ? "search" : "url";
    const initialSearchQuery = searchParams.get("q") || "";
    const initialExpanded = useMemo(() => {
        const raw = searchParams.get("expanded");
        return raw
            ? new Set(raw.split(",").map(s => s.trim()).filter(Boolean))
            : new Set<string>();
        // Parse once on mount; subsequent changes are pushed via router.replace.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const [url, setUrl] = useState(initialUrl);
    const [status, setStatus] = useState<DownloadStatus>("idle");
    // Input mode: "url" = paste URL, "search" = search across providers
    const [inputMode, setInputMode] = useState<"url" | "search">(
        initialUrl ? "url" : (initialTab === "search" ? "search" : "url")
    );
    // Live mirror of the search query so we can sync it into the URL.
    const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
    const [expandedProviders, setExpandedProviders] = useState<Set<string>>(initialExpanded);

    // Sync `tab`, `q`, `expanded` to the URL (without adding history entries).
    // Skips updating when nothing actually changed to avoid pointless replaces.
    useEffect(() => {
        const params = new URLSearchParams(searchParams.toString());
        // Tab — only persist when it differs from the default.
        if (inputMode === "search") {
            params.set("tab", "search");
        } else {
            params.delete("tab");
        }
        // Search query — only when on the search tab.
        if (inputMode === "search" && searchQuery.trim()) {
            params.set("q", searchQuery.trim());
        } else {
            params.delete("q");
        }
        // Expanded providers (sorted for stability).
        if (inputMode === "search" && expandedProviders.size > 0) {
            params.set("expanded", [...expandedProviders].sort().join(","));
        } else {
            params.delete("expanded");
        }
        const next = params.toString();
        const current = searchParams.toString();
        if (next !== current) {
            router.replace(`${pathname}${next ? `?${next}` : ""}`, { scroll: false });
        }
    }, [inputMode, searchQuery, expandedProviders, pathname, router, searchParams]);
    // Latest-downloads side panel — accumulates tracks added in this session
    // (and seeds with a few recent rows from the library on mount).
    const latestDownloads = useLatestDownloads();
    const latestDownloadsSeededRef = useRef(false);
    const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
    const [progress, setProgress] = useState<DownloadProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloadedFile, setDownloadedFile] = useState<string | null>(null);
    const [downloadId, setDownloadId] = useState<number | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [showLogs, setShowLogs] = useState(false);
    const logsEndRef = useRef<HTMLDivElement>(null);
    const [showAllFormats, setShowAllFormats] = useState(false);
    const [addedTrackId, setAddedTrackId] = useState<number | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const autoTriggered = useRef(false);

    // Settings
    const [downloadFolder, setDownloadFolder] = useState("");
    const [audioQuality, setAudioQuality] = useState("auto");
    const [audioFormat, setAudioFormat] = useState("auto");
    const [showSettings, setShowSettings] = useState(false);
    const [showFolderPicker, setShowFolderPicker] = useState(false);
    const [conversionFormat, setConversionFormat] = useState("auto");
    const [conversionQuality, setConversionQuality] = useState("auto");
    const [parallelDownloads, setParallelDownloads] = useState(3);
    const [parallelConversions, setParallelConversions] = useState(2);

    // History
    const [history, setHistory] = useState<DownloadHistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // Right sidebar state — collapsible, with two tabs (Latest / History).
    // Default open on desktop; the user can toggle with the header buttons or
    // the sidebar's own close button.
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sidebarTab, setSidebarTab] = useState<"latest" | "history">("latest");

    // Analysis result display
    const [analysisResults, setAnalysisResults] = useState<Record<string, string> | null>(null);

    // Playlist
    const [playlistInfo, setPlaylistInfo] = useState<PlaylistInfo | null>(null);
    const [selectedTracks, setSelectedTracks] = useState<Set<string>>(new Set());
    const [autoAddToLibrary, setAutoAddToLibrary] = useState(true);
    const [batchCurrentIndex, setBatchCurrentIndex] = useState(-1);
    const [activeDownloads, setActiveDownloads] = useState<Set<number>>(new Set());
    const [batchResults, setBatchResults] = useState<BatchTrackResult[]>([]);
    const [duplicateMap, setDuplicateMap] = useState<Record<string, { trackId: number; reason: string }>>({});

    // Load settings from DB on mount
    useEffect(() => {
        fetch("/api/download/settings")
            .then(r => r.ok ? r.json() : null)
            .then(s => {
                if (s) {
                    if (s.downloadFolder) setDownloadFolder(s.downloadFolder);
                    if (s.audioQuality) setAudioQuality(s.audioQuality);
                    if (s.audioFormat) setAudioFormat(s.audioFormat);
                    if (s.conversionFormat) setConversionFormat(s.conversionFormat);
                    if (s.conversionQuality) setConversionQuality(s.conversionQuality);
                    if (s.parallelDownloads) setParallelDownloads(Number(s.parallelDownloads) || 3);
                    if (s.parallelConversions) setParallelConversions(Number(s.parallelConversions) || 2);
                }
            })
            .catch(() => { });
    }, []);

    // Seed the "Latest Downloads" panel once on mount with the most recently
    // added library tracks that came from a download (i.e. have a sourceUrl).
    useEffect(() => {
        if (latestDownloadsSeededRef.current) return;
        latestDownloadsSeededRef.current = true;
        getTracks({
            pageSize: 5,
            sort: "addedAt",
            order: "desc",
        })
            .then((res) => {
                const seeded = res.tracks.filter((t) => !!t.sourceUrl);
                if (seeded.length > 0) latestDownloads.setInitial(seeded);
            })
            .catch(() => {
                /* non-fatal */
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Helper: fetch a full Track row by id and prepend it to the latest list.
    const pushTrackToLatest = useCallback(async (trackId: number) => {
        try {
            const t = await getTrackById(trackId);
            if (t) latestDownloads.addTrack(t);
        } catch {
            /* non-fatal */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const pushTracksToLatest = useCallback(async (trackIds: number[]) => {
        if (trackIds.length === 0) return;
        try {
            const fetched = await Promise.all(
                trackIds.map((id) => getTrackById(id).catch(() => null))
            );
            const valid = fetched.filter((t): t is NonNullable<typeof t> => !!t);
            if (valid.length > 0) latestDownloads.addTracks(valid);
        } catch {
            /* non-fatal */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-fetch info when URL is provided via query param
    useEffect(() => {
        if (initialUrl && !autoTriggered.current) {
            autoTriggered.current = true;
            fetchInfo(initialUrl);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialUrl]);

    // Auto-scroll logs
    useEffect(() => {
        if (showLogs && logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [logs, showLogs]);

    const loadHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const res = await fetch("/api/download/history?limit=50");
            if (res.ok) {
                const data = await res.json();
                setHistory(data);
            }
        } catch { /* ignore */ }
        setHistoryLoading(false);
    }, []);

    const clearHistory = useCallback(async () => {
        await fetch("/api/download/history", { method: "DELETE" });
        setHistory([]);
        toast.success("History cleared");
    }, []);

    const deleteHistoryItem = useCallback(async (id: number) => {
        await fetch(`/api/download/history?id=${id}`, { method: "DELETE" });
        setHistory(prev => prev.filter(h => h.id !== id));
    }, []);

    // Auto-load history the first time the user opens the History tab.
    const historyLoadedRef = useRef(false);
    useEffect(() => {
        if (
            sidebarOpen &&
            sidebarTab === "history" &&
            !historyLoadedRef.current
        ) {
            historyLoadedRef.current = true;
            loadHistory();
        }
    }, [sidebarOpen, sidebarTab, loadHistory]);

    // Refresh history whenever a track is added during the session, so the
    // History tab stays in sync with new entries even if the user is busy
    // looking at "Latest".
    const refreshHistorySoon = useCallback(() => {
        if (!historyLoadedRef.current) return;
        // Tiny delay so the server has time to flush the row.
        setTimeout(() => {
            void loadHistory();
        }, 400);
    }, [loadHistory]);

    const saveSetting = useCallback(async (key: string, value: string) => {
        await fetch("/api/download/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value }),
        });
    }, []);

    const fetchInfo = useCallback(async (targetUrl?: string) => {
        const u = targetUrl || url;
        if (!u.trim()) return;

        setStatus("fetching-info");
        setError(null);
        setMediaInfo(null);
        setPlaylistInfo(null);
        setSelectedTracks(new Set());
        setDuplicateMap({});
        setBatchResults([]);
        setBatchCurrentIndex(-1);
        setActiveDownloads(new Set());
        setDownloadedFile(null);
        setDownloadId(null);
        setLogs([]);
        setAddedTrackId(null);
        setAnalysisResults(null);

        try {
            const res = await fetch("/api/download/info", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: u }),
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to fetch info");

            // Check if playlist response
            if (data._type === "playlist") {
                const playlist = data as PlaylistInfo;
                setPlaylistInfo(playlist);
                // Select all tracks by default
                const allIds = new Set(playlist.entries.map((e: PlaylistEntry) => e.id));
                setSelectedTracks(allIds);
                setStatus("ready");

                // Check for duplicates in background
                try {
                    const dupRes = await fetch("/api/download/check-duplicates", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            items: playlist.entries.map(e => ({
                                id: e.id,
                                title: e.title,
                                uploader: e.uploader,
                                url: e.url,
                            })),
                        }),
                    });
                    if (dupRes.ok) {
                        const dupData = await dupRes.json();
                        if (dupData.duplicates && Object.keys(dupData.duplicates).length > 0) {
                            setDuplicateMap(dupData.duplicates);
                            // Auto-uncheck duplicates
                            const dupIds = new Set(Object.keys(dupData.duplicates));
                            setSelectedTracks(prev => {
                                const next = new Set(prev);
                                for (const id of dupIds) next.delete(id);
                                return next;
                            });
                            toast.info(`${dupData.duplicateCount} track(s) already in library — auto-skipped`);
                        }
                    }
                } catch {
                    // Non-fatal: duplicate check failure doesn't block download
                }
            } else {
                const info = data as MediaInfo;
                setMediaInfo(info);
                setStatus("ready");

                // Check if already downloaded/in library
                try {
                    const dupRes = await fetch("/api/download/check-duplicates", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            items: [{ id: info.id, title: info.title, uploader: info.uploader, url: info.webpage_url }],
                        }),
                    });
                    if (dupRes.ok) {
                        const dupData = await dupRes.json();
                        const dup = dupData.duplicates?.[info.id];
                        if (dup) {
                            if (dup.trackId && dup.reason?.includes("in library")) {
                                // Already in library
                                setAddedTrackId(dup.trackId);
                                setDownloadedFile(dup.filePath || null);
                                setDownloadId(dup.downloadId || null);
                                setStatus("added");
                                toast.info("Already in library");
                            } else if (dup.filePath) {
                                // Downloaded but not in library
                                setDownloadedFile(dup.filePath);
                                setDownloadId(dup.downloadId || null);
                                setStatus("complete");
                                toast.info("Already downloaded — add to library?");
                            }
                            return;
                        }
                    }
                } catch {
                    // Non-fatal
                }

                if (autoDownload && targetUrl === initialUrl) {
                    startDownload(u, true, undefined, true);
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch media info");
            setStatus("error");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, autoDownload, initialUrl]);

    const startDownload = useCallback(async (targetUrl?: string, audioOnly: boolean = true, format?: string, convert?: boolean) => {
        const u = targetUrl || url;
        if (!u.trim()) return;

        setStatus("downloading");
        setProgress(null);
        setError(null);
        setLogs([]);
        setAnalysisResults(null);

        const controller = new AbortController();
        abortRef.current = controller;

        // When converting, resolve auto values to actual defaults
        const effectiveFormat = convert
            ? (conversionFormat === "auto" ? "flac" : conversionFormat)
            : audioFormat;
        const effectiveQuality = convert
            ? (conversionQuality === "auto" ? "0" : conversionQuality)
            : audioQuality;

        try {
            const res = await fetch("/api/download/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    url: u,
                    audioOnly,
                    format,
                    audioQuality: effectiveQuality,
                    audioFormat: effectiveFormat,
                    downloadFolder: downloadFolder || undefined,
                    mediaTitle: mediaInfo?.title,
                    mediaArtist: mediaInfo?.uploader,
                    mediaDuration: mediaInfo?.duration,
                    mediaThumbnail: mediaInfo?.thumbnail,
                    mediaExtractor: mediaInfo?.extractor,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Download failed");
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response stream");

            const decoder = new TextDecoder();
            let buffer = "";

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
                                setProgress({
                                    percent: event.percent,
                                    totalSize: event.totalSize,
                                    speed: event.speed,
                                    eta: event.eta,
                                });
                                break;
                            case "track_complete":
                                setDownloadedFile(event.file);
                                setDownloadId(event.downloadId || null);
                                setStatus("complete");
                                toast.success("Download complete!");
                                break;
                            case "already_exists":
                                setDownloadedFile(event.file);
                                setStatus("complete");
                                toast.info("File already downloaded");
                                break;
                            case "track_error":
                                setError(event.error || event.message);
                                setStatus("error");
                                toast.error(`Download failed: ${event.error || event.message}`);
                                break;
                            case "destination":
                                setDownloadedFile(event.file);
                                setLogs(prev => [...prev, `📁 ${event.file}`]);
                                break;
                            case "log":
                                setLogs(prev => [...prev, event.message]);
                                break;
                            case "warning":
                                setLogs(prev => [...prev, `⚠ ${event.message}`]);
                                break;
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
        } catch (err) {
            if ((err as Error).name === "AbortError") {
                setStatus("idle");
                toast.info("Download cancelled");
            } else {
                setError(err instanceof Error ? err.message : "Download failed");
                setStatus("error");
            }
        }
    }, [url, audioQuality, audioFormat, conversionFormat, conversionQuality, downloadFolder, mediaInfo]);

    const cancelDownload = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
    }, []);

    const addToLibrary = useCallback(async () => {
        if (!downloadedFile) return;

        setStatus("adding-to-library");
        setAnalysisResults(null);
        try {
            const res = await fetch("/api/download/add-to-library", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    filePath: downloadedFile,
                    downloadId,
                    sourceUrl: mediaInfo?.webpage_url,
                    sourcePlatform: mediaInfo?.extractor,
                    sourceId: mediaInfo?.id,
                }),
            });

            const data = await res.json();

            if (res.status === 409) {
                setAddedTrackId(data.trackId);
                setStatus("added");
                if (data.trackId) void pushTrackToLatest(data.trackId);
                toast.info("Track already in library");
                return;
            }

            if (!res.ok) throw new Error(data.error || "Failed to add to library");

            setAddedTrackId(data.trackId);
            setStatus("added");
            if (data.trackId) void pushTrackToLatest(data.trackId);
            toast.success("Added to library & analyzed!");

            // Show what was enriched from analysis
            if (data.track) {
                const enriched: Record<string, string> = {};
                if (data.track.artworkUrl) enriched["Artwork"] = "✓";
                if (data.track.genre) enriched["Genre"] = data.track.genre;
                if (data.track.bpm) enriched["BPM"] = String(data.track.bpm);
                if (data.track.year) enriched["Year"] = String(data.track.year);
                if (data.track.label) enriched["Label"] = data.track.label;
                if (data.track.album) enriched["Album"] = data.track.album;
                if (data.track.lyrics) enriched["Lyrics"] = `${data.track.lyrics.split("\n").length} lines`;
                if (data.track.isrc) enriched["ISRC"] = data.track.isrc;
                if (data.track.keyCamelot) enriched["Key"] = data.track.keyCamelot;
                if (Object.keys(enriched).length > 0) setAnalysisResults(enriched);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to add to library");
            setStatus("error");
        }
    }, [downloadedFile, downloadId]);

    const startBatchDownload = useCallback(async (convert?: boolean) => {
        if (!playlistInfo) return;
        const selected = playlistInfo.entries.filter(e => selectedTracks.has(e.id));
        if (selected.length === 0) {
            toast.error("No tracks selected");
            return;
        }

        setStatus("batch-downloading");
        setBatchResults([]);
        setBatchCurrentIndex(0);
        setActiveDownloads(new Set());
        setProgress(null);
        setLogs([]);
        setError(null);

        const controller = new AbortController();
        abortRef.current = controller;

        // Resolve conversion settings
        const effectiveFormat = convert
            ? (conversionFormat === "auto" ? "flac" : conversionFormat)
            : audioFormat;
        const effectiveQuality = convert
            ? (conversionQuality === "auto" ? "0" : conversionQuality)
            : audioQuality;

        try {
            const res = await fetch("/api/download/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tracks: selected.map(e => ({
                        url: e.url,
                        title: e.title,
                        uploader: e.uploader || playlistInfo.uploader,
                        duration: e.duration,
                        thumbnail: e.thumbnail,
                    })),
                    audioOnly: true,
                    audioQuality: effectiveQuality,
                    audioFormat: effectiveFormat,
                    downloadFolder: downloadFolder || undefined,
                    mediaExtractor: playlistInfo.extractor,
                    autoAddToLibrary,
                    parallelDownloads,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Batch download failed");
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response stream");

            const decoder = new TextDecoder();
            let buffer = "";

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
                            case "track_started":
                                setBatchCurrentIndex(event.trackIndex);
                                setActiveDownloads(prev => new Set(prev).add(event.trackIndex));
                                break;
                            case "progress":
                                setProgress({
                                    percent: event.percent,
                                    totalSize: event.totalSize,
                                    speed: event.speed,
                                    eta: event.eta,
                                });
                                break;
                            case "track_complete":
                                setActiveDownloads(prev => {
                                    const next = new Set(prev);
                                    next.delete(event.trackIndex);
                                    return next;
                                });
                                setBatchResults(prev => [...prev, {
                                    trackIndex: event.trackIndex,
                                    title: event.title || selected[event.trackIndex]?.title || "Unknown",
                                    file: event.file,
                                    downloadId: event.downloadId,
                                }]);
                                break;
                            case "track_error":
                                setActiveDownloads(prev => {
                                    const next = new Set(prev);
                                    next.delete(event.trackIndex);
                                    return next;
                                });
                                setBatchResults(prev => [...prev, {
                                    trackIndex: event.trackIndex,
                                    title: event.title || selected[event.trackIndex]?.title || "Unknown",
                                    file: "",
                                    downloadId: 0,
                                    error: event.error,
                                }]);
                                break;
                            case "batch_complete": {
                                const completed = event.completed || 0;
                                const failed = event.failed || 0;
                                if (failed === 0) {
                                    toast.success(`Downloaded ${completed} tracks`);
                                } else {
                                    toast.warning(`Downloaded ${completed}/${completed + failed} tracks (${failed} failed)`);
                                }

                                // Auto-add to library if enabled
                                if (autoAddToLibrary && event.results) {
                                    const successResults = (event.results as BatchTrackResult[]).filter((r: { error?: string }) => !r.error);
                                    if (successResults.length > 0) {
                                        setStatus("batch-adding");
                                        try {
                                            const addRes = await fetch("/api/download/add-to-library", {
                                                method: "POST",
                                                headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({
                                                    files: successResults.map(r => {
                                                        const entry = selected[r.trackIndex];
                                                        return {
                                                            filePath: r.file,
                                                            downloadId: r.downloadId,
                                                            sourceUrl: entry?.url,
                                                            sourcePlatform: playlistInfo.extractor,
                                                            sourceId: entry?.id,
                                                        };
                                                    }),
                                                }),
                                            });
                                            const addData = await addRes.json();
                                            if (addRes.ok) {
                                                toast.success(`Added ${addData.added} tracks to library${addData.existing ? ` (${addData.existing} already existed)` : ""}`);
                                                // Update batch results with library IDs
                                                if (addData.results) {
                                                    const addedIds: number[] = [];
                                                    setBatchResults(prev => prev.map(r => {
                                                        const match = addData.results.find((ar: { filePath: string; trackId?: number; error?: string }) => ar.filePath === r.file);
                                                        if (match) {
                                                            if (match.trackId) addedIds.push(match.trackId);
                                                            return { ...r, addedTrackId: match.trackId, addError: match.error };
                                                        }
                                                        return r;
                                                    }));
                                                    if (addedIds.length > 0) void pushTracksToLatest(addedIds);
                                                }
                                            }
                                        } catch {
                                            toast.error("Failed to add tracks to library");
                                        }
                                    }
                                }

                                setStatus("batch-complete");
                                break;
                            }
                            case "log":
                                setLogs(prev => [...prev, `[${event.trackIndex + 1}] ${event.message}`]);
                                break;
                            case "warning":
                                setLogs(prev => [...prev, `[${event.trackIndex + 1}] ⚠ ${event.message}`]);
                                break;
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
        } catch (err) {
            if ((err as Error).name === "AbortError") {
                setStatus("ready");
                toast.info("Batch download cancelled");
            } else {
                setError(err instanceof Error ? err.message : "Batch download failed");
                setStatus("error");
            }
        }
    }, [playlistInfo, selectedTracks, audioQuality, audioFormat, conversionFormat, conversionQuality, downloadFolder, autoAddToLibrary, parallelDownloads]);

    const batchAddToLibrary = useCallback(async () => {
        const toAdd = batchResults.filter(r => !r.error && r.file && !r.addedTrackId);
        if (toAdd.length === 0) {
            toast.info("No tracks to add");
            return;
        }

        setStatus("batch-adding");
        try {
            const selected = playlistInfo?.entries.filter(e => selectedTracks.has(e.id)) || [];
            const res = await fetch("/api/download/add-to-library", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    files: toAdd.map(r => {
                        const entry = selected[r.trackIndex];
                        return {
                            filePath: r.file,
                            downloadId: r.downloadId,
                            sourceUrl: entry?.url,
                            sourcePlatform: playlistInfo?.extractor,
                            sourceId: entry?.id,
                        };
                    }),
                }),
            });
            const data = await res.json();
            if (res.ok) {
                toast.success(`Added ${data.added} tracks to library`);
                if (data.results) {
                    const addedIds: number[] = [];
                    setBatchResults(prev => prev.map(r => {
                        const match = data.results.find((ar: { filePath: string; trackId?: number; error?: string }) => ar.filePath === r.file);
                        if (match) {
                            if (match.trackId) addedIds.push(match.trackId);
                            return { ...r, addedTrackId: match.trackId, addError: match.error };
                        }
                        return r;
                    }));
                    if (addedIds.length > 0) void pushTracksToLatest(addedIds);
                }
            } else {
                toast.error(data.error || "Failed to add tracks");
            }
        } catch {
            toast.error("Failed to add tracks to library");
        }
        setStatus("batch-complete");
    }, [batchResults]);

    const reset = useCallback(() => {
        setStatus("idle");
        setMediaInfo(null);
        setPlaylistInfo(null);
        setSelectedTracks(new Set());
        setDuplicateMap({});
        setBatchResults([]);
        setBatchCurrentIndex(-1);
        setActiveDownloads(new Set());
        setProgress(null);
        setError(null);
        setDownloadedFile(null);
        setDownloadId(null);
        setLogs([]);
        setShowLogs(false);
        setAddedTrackId(null);
        setAnalysisResults(null);
    }, []);

    // Provider search panel handles inline downloads itself; we only need to
    // mirror successfully-added tracks into the "Latest Downloads" panel and
    // the download history. The view never switches away from "Search".
    const handleProviderTrackAdded = useCallback(
        (trackId: number) => {
            void pushTrackToLatest(trackId);
            refreshHistorySoon();
        },
        [pushTrackToLatest, refreshHistorySoon]
    );

    // Group formats
    const audioFormats = mediaInfo?.formats.filter(f => f.type === "audio")
        .sort((a, b) => (b.abr || 0) - (a.abr || 0)) || [];
    const videoFormats = mediaInfo?.formats.filter(f => f.type === "video" || f.type === "audio+video")
        .sort((a, b) => (b.tbr || 0) - (a.tbr || 0)) || [];

    // Resolve auto format/quality to display actual values
    const resolvedFormatLabel = (() => {
        const fmt = audioFormat === "auto" ? audioFormats[0]?.ext?.toUpperCase() : AUDIO_FORMATS.find(f => f.value === audioFormat)?.label;
        const qual = audioQuality === "auto"
            ? (audioFormats[0]?.abr ? `${Math.round(audioFormats[0].abr)}k` : null)
            : AUDIO_QUALITIES.find(q => q.value === audioQuality)?.label;
        const parts = [fmt, qual].filter(Boolean);
        return parts.length > 0 ? parts.join(" · ") : "Best";
    })();

    const resolvedConversionLabel = (() => {
        const fmt = conversionFormat === "auto" ? "FLAC" : CONVERSION_FORMATS.find(f => f.value === conversionFormat)?.label;
        const qual = conversionQuality === "auto" ? "Best" : CONVERSION_QUALITIES.find(q => q.value === conversionQuality)?.label;
        return [fmt, qual].filter(Boolean).join(" · ");
    })();

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="w-full max-w-[1400px] mx-auto px-4 sm:px-6 py-6 flex flex-col lg:flex-row gap-6">
                {/* Main column */}
                <div className="flex-1 min-w-0 space-y-6">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <div>
                            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                                <Download className="h-5 w-5 text-purple-500" />
                                Media Downloader
                            </h1>
                            <p className="text-sm text-muted-foreground mt-1">
                                Download audio from YouTube, SoundCloud, Spotify, and 1800+ sites
                            </p>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => {
                                    if (sidebarOpen && sidebarTab === "latest") {
                                        setSidebarOpen(false);
                                    } else {
                                        setSidebarOpen(true);
                                        setSidebarTab("latest");
                                    }
                                }}
                                className={cn(
                                    "p-2 rounded-lg text-xs transition-colors cursor-pointer",
                                    sidebarOpen && sidebarTab === "latest"
                                        ? "bg-purple-500/20 text-purple-400"
                                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                )}
                                title="Latest Downloads"
                            >
                                <Sparkles className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => {
                                    if (sidebarOpen && sidebarTab === "history") {
                                        setSidebarOpen(false);
                                    } else {
                                        setSidebarOpen(true);
                                        setSidebarTab("history");
                                    }
                                }}
                                className={cn(
                                    "p-2 rounded-lg text-xs transition-colors cursor-pointer",
                                    sidebarOpen && sidebarTab === "history"
                                        ? "bg-purple-500/20 text-purple-400"
                                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                )}
                                title="Download History"
                            >
                                <History className="h-4 w-4" />
                            </button>
                            <button
                                onClick={() => setShowSettings(!showSettings)}
                                className={cn(
                                    "p-2 rounded-lg text-xs transition-colors cursor-pointer",
                                    showSettings ? "bg-purple-500/20 text-purple-400" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                )}
                                title="Download Settings"
                            >
                                <Settings2 className="h-4 w-4" />
                            </button>
                        </div>
                    </div>

                    {/* Settings Panel */}
                    {showSettings && (
                        <div className="rounded-xl bg-card border border-border p-4 space-y-4">
                            <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-2">
                                <Settings2 className="h-3.5 w-3.5 text-purple-500" />
                                Download Settings
                            </h3>

                            {/* Download Folder */}
                            <div className="space-y-1.5">
                                <label className="text-xs text-muted-foreground font-medium">Download Folder</label>
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 px-3 py-2 rounded-lg bg-muted/30 border border-border text-xs font-mono text-muted-foreground truncate">
                                        {downloadFolder || "Default (app/data/downloads)"}
                                    </div>
                                    <button
                                        onClick={() => setShowFolderPicker(true)}
                                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent/80 border border-border text-xs text-foreground transition-colors cursor-pointer"
                                    >
                                        <FolderOpen className="h-3.5 w-3.5" />
                                        Browse
                                    </button>
                                    {downloadFolder && (
                                        <button
                                            onClick={() => {
                                                setDownloadFolder("");
                                                saveSetting("downloadFolder", "");
                                            }}
                                            className="p-2 rounded-lg text-muted-foreground hover:text-red-400 transition-colors cursor-pointer"
                                            title="Reset to default"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Audio Quality + Format */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <Label className="text-xs text-muted-foreground">Audio Quality</Label>
                                    <Select
                                        value={audioQuality}
                                        onChange={(e) => {
                                            setAudioQuality(e.target.value);
                                            saveSetting("audioQuality", e.target.value);
                                        }}
                                        size="sm"
                                    >
                                        {AUDIO_QUALITIES.map(q => (
                                            <option key={q.value} value={q.value}>
                                                {q.label}
                                            </option>
                                        ))}
                                    </Select>
                                </div>
                                <div className="space-y-1.5">
                                    <Label className="text-xs text-muted-foreground">Audio Format</Label>
                                    <Select
                                        value={audioFormat}
                                        onChange={(e) => {
                                            setAudioFormat(e.target.value);
                                            saveSetting("audioFormat", e.target.value);
                                        }}
                                        size="sm"
                                    >
                                        {AUDIO_FORMATS.map(f => (
                                            <option key={f.value} value={f.value}>
                                                {f.label}
                                            </option>
                                        ))}
                                    </Select>
                                </div>
                            </div>

                            {/* Conversion Settings */}
                            <div className="pt-3 border-t border-border/50">
                                <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                                    <FileAudio className="h-3 w-3 text-blue-400" />
                                    Conversion Settings
                                </h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-muted-foreground">Convert Quality</Label>
                                        <Select
                                            value={conversionQuality}
                                            onChange={(e) => {
                                                setConversionQuality(e.target.value);
                                                saveSetting("conversionQuality", e.target.value);
                                            }}
                                            size="sm"
                                        >
                                            {CONVERSION_QUALITIES.map(q => (
                                                <option key={q.value} value={q.value}>
                                                    {q.label}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-muted-foreground">Convert Format</Label>
                                        <Select
                                            value={conversionFormat}
                                            onChange={(e) => {
                                                setConversionFormat(e.target.value);
                                                saveSetting("conversionFormat", e.target.value);
                                            }}
                                            size="sm"
                                        >
                                            {CONVERSION_FORMATS.map(f => (
                                                <option key={f.value} value={f.value}>
                                                    {f.label}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                </div>
                            </div>

                            {/* Parallel Processing Settings */}
                            <div className="pt-3 border-t border-border/50">
                                <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                                    <Sparkles className="h-3 w-3 text-orange-400" />
                                    Parallel Processing
                                </h4>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-muted-foreground">Parallel Downloads</Label>
                                        <Select
                                            value={String(parallelDownloads)}
                                            onChange={(e) => {
                                                const v = Number(e.target.value);
                                                setParallelDownloads(v);
                                                saveSetting("parallelDownloads", e.target.value);
                                            }}
                                            size="sm"
                                        >
                                            {[1, 2, 3, 4, 5, 6, 8].map(n => (
                                                <option key={n} value={n}>
                                                    {n === 1 ? "1 (Sequential)" : `${n} simultaneous`}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label className="text-xs text-muted-foreground">Parallel Conversions</Label>
                                        <Select
                                            value={String(parallelConversions)}
                                            onChange={(e) => {
                                                const v = Number(e.target.value);
                                                setParallelConversions(v);
                                                saveSetting("parallelConversions", e.target.value);
                                            }}
                                            size="sm"
                                        >
                                            {[1, 2, 3, 4, 5, 6, 8].map(n => (
                                                <option key={n} value={n}>
                                                    {n === 1 ? "1 (Sequential)" : `${n} simultaneous`}
                                                </option>
                                            ))}
                                        </Select>
                                    </div>
                                </div>
                            </div>

                            <p className="text-[10px] text-muted-foreground/40">
                                Settings are persisted and apply to all future downloads
                            </p>
                        </div>
                    )}

                    {/* History panel moved to right sidebar */}

                    {/* Input Mode Tabs */}
                    <div className="flex items-center gap-1 p-1 rounded-xl bg-muted/30 border border-border w-fit">
                        <button
                            type="button"
                            onClick={() => setInputMode("url")}
                            className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer",
                                inputMode === "url"
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <LinkIcon className="h-3.5 w-3.5" />
                            Paste URL
                        </button>
                        <button
                            type="button"
                            onClick={() => setInputMode("search")}
                            className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer",
                                inputMode === "search"
                                    ? "bg-card text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Search className="h-3.5 w-3.5" />
                            Search Providers
                        </button>
                    </div>

                    {/* Search Providers Panel */}
                    {inputMode === "search" && (
                        <ProviderSearchPanel
                            onTrackAdded={handleProviderTrackAdded}
                            initialQuery={initialSearchQuery}
                            onQueryChange={setSearchQuery}
                            initialExpanded={expandedProviders}
                            onExpandedChange={setExpandedProviders}
                            downloadSettings={{
                                downloadFolder,
                                audioQuality,
                                audioFormat,
                                conversionFormat,
                                conversionQuality,
                            }}
                        />
                    )}

                    {/* URL Input */}
                    {inputMode === "url" && (
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
                                <input
                                    type="url"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") fetchInfo(); }}
                                    placeholder="Paste URL from YouTube, SoundCloud, Spotify, etc."
                                    className="w-full pl-10 pr-10 py-3 rounded-xl bg-card border border-border text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-purple-500/30 focus:border-purple-500/50 transition-all text-sm"
                                    disabled={status === "downloading"}
                                />
                                {url && (
                                    <button
                                        onClick={() => { setUrl(""); reset(); }}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground cursor-pointer"
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                )}
                            </div>
                            <button
                                onClick={() => fetchInfo()}
                                disabled={!url.trim() || status === "fetching-info" || status === "downloading"}
                                className={cn(
                                    "px-5 py-3 rounded-xl font-medium text-sm transition-all cursor-pointer flex items-center gap-2",
                                    "bg-purple-500 hover:bg-purple-600 text-white",
                                    "disabled:opacity-40 disabled:cursor-not-allowed"
                                )}
                            >
                                {status === "fetching-info" ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Search className="h-4 w-4" />
                                )}
                                Analyze
                            </button>
                        </div>
                    )}

                    {/* Active quality indicator when not in settings */}
                    {!showSettings && (
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/50">
                            <span className="flex items-center gap-1">
                                <HardDrive className="h-3 w-3" />
                                {downloadFolder ? downloadFolder.split(/[\\/]/).pop() : "Default folder"}
                            </span>
                            <span>•</span>
                            <span>{AUDIO_FORMATS.find(f => f.value === audioFormat)?.label || "Auto"}</span>
                            <span>•</span>
                            <span>{AUDIO_QUALITIES.find(q => q.value === audioQuality)?.label || "Auto"}</span>
                            <span className="text-blue-400/50">|</span>
                            <span className="text-blue-400/50">Convert: {resolvedConversionLabel}</span>
                        </div>
                    )}

                    {/* Latest Downloads moved to right sidebar */}

                    {/* Error */}
                    {error && (
                        <div className="flex items-start gap-3 rounded-xl bg-red-500/10 border border-red-500/20 p-4">
                            <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium text-red-400">Error</p>
                                <p className="text-sm text-red-400/80 mt-0.5">{error}</p>
                            </div>
                        </div>
                    )}

                    {/* Media Info Card (single track) */}
                    {mediaInfo && !playlistInfo && (
                        <div className="rounded-xl bg-card border border-border overflow-hidden">
                            <div className="flex gap-4 p-4">
                                {/* Thumbnail */}
                                {mediaInfo.thumbnail && (
                                    <div className="shrink-0 w-48 h-28 rounded-lg overflow-hidden bg-muted">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img
                                            src={mediaInfo.thumbnail}
                                            alt={mediaInfo.title}
                                            className="w-full h-full object-cover"
                                        />
                                    </div>
                                )}

                                {/* Info */}
                                <div className="flex-1 min-w-0">
                                    <h2 className="text-base font-semibold text-foreground truncate" title={mediaInfo.title}>
                                        {getPlatformIcon(mediaInfo.extractor)} {mediaInfo.title}
                                    </h2>
                                    <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                        <span className="flex items-center gap-1">
                                            <User className="h-3 w-3" />
                                            {mediaInfo.uploader || "Unknown"}
                                        </span>
                                        {mediaInfo.duration > 0 && (
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                {formatDuration(mediaInfo.duration)}
                                            </span>
                                        )}
                                        <span className="flex items-center gap-1 text-purple-400">
                                            <Globe className="h-3 w-3" />
                                            {mediaInfo.extractor}
                                        </span>
                                    </div>
                                    {mediaInfo.description && (
                                        <p className="text-xs text-muted-foreground/60 mt-2 line-clamp-2">
                                            {mediaInfo.description}
                                        </p>
                                    )}

                                    {/* Quick Actions */}
                                    <div className="flex items-center gap-2 mt-3 flex-wrap">
                                        {status === "added" ? (
                                            <>
                                                <div className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-medium">
                                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                                    Already in Library{addedTrackId ? ` (ID: ${addedTrackId})` : ""}
                                                </div>
                                            </>
                                        ) : status === "complete" && downloadedFile ? (
                                            <>
                                                <button
                                                    onClick={addToLibrary}
                                                    disabled={status !== "complete"}
                                                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    <Library className="h-3.5 w-3.5" />
                                                    Add to Library &amp; Analyze
                                                </button>
                                            </>
                                        ) : status === "adding-to-library" ? (
                                            <>
                                                <div className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs font-medium">
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                    Adding &amp; Analyzing...
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    onClick={() => startDownload(undefined, true, undefined, true)}
                                                    disabled={status === "downloading"}
                                                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    <FileAudio className="h-3.5 w-3.5" />
                                                    Download &amp; Convert ({resolvedConversionLabel})
                                                </button>
                                                <button
                                                    onClick={() => startDownload(undefined, true)}
                                                    disabled={status === "downloading"}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-accent border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    <Download className="h-3.5 w-3.5" />
                                                    Original ({resolvedFormatLabel})
                                                </button>
                                            </>
                                        )}
                                        <a
                                            href={mediaInfo.webpage_url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-accent border border-border text-xs text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            <ExternalLink className="h-3 w-3" />
                                            Open source
                                        </a>
                                    </div>
                                </div>
                            </div>

                            {/* Formats */}
                            <div className="border-t border-border">
                                <button
                                    onClick={() => setShowAllFormats(!showAllFormats)}
                                    className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                    <span className="font-medium">
                                        Available formats ({audioFormats.length} audio, {videoFormats.length} video)
                                    </span>
                                    {showAllFormats ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                                </button>

                                {showAllFormats && (
                                    <div className="px-4 pb-4 space-y-3">
                                        {audioFormats.length > 0 && (
                                            <div>
                                                <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1.5 flex items-center gap-1.5">
                                                    <FileAudio className="h-3 w-3" /> Audio Formats
                                                </h3>
                                                <div className="grid gap-1">
                                                    {audioFormats.map((f) => (
                                                        <div key={f.formatId} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors group">
                                                            <div className="flex items-center gap-3 text-xs">
                                                                <span className="font-mono text-muted-foreground/60 w-10">{f.ext}</span>
                                                                <span className="text-foreground/80">{f.acodec}</span>
                                                                {f.abr && <span className="text-muted-foreground">{f.abr}kbps</span>}
                                                                <span className="text-muted-foreground/50">{formatFileSize(f.filesize || f.filesizeApprox)}</span>
                                                            </div>
                                                            <button
                                                                onClick={() => startDownload(undefined, false, f.formatId)}
                                                                disabled={status === "downloading"}
                                                                className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-all cursor-pointer disabled:opacity-40"
                                                            >
                                                                <Download className="h-2.5 w-2.5" />
                                                                Download
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {videoFormats.length > 0 && (
                                            <div>
                                                <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-1.5 flex items-center gap-1.5">
                                                    <Video className="h-3 w-3" /> Video Formats
                                                </h3>
                                                <div className="grid gap-1">
                                                    {videoFormats.slice(0, 10).map((f) => (
                                                        <div key={f.formatId} className="flex items-center justify-between py-1.5 px-2.5 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors group">
                                                            <div className="flex items-center gap-3 text-xs">
                                                                <span className="font-mono text-muted-foreground/60 w-10">{f.ext}</span>
                                                                <span className="text-foreground/80">{f.resolution}</span>
                                                                {f.fps && <span className="text-muted-foreground">{f.fps}fps</span>}
                                                                <span className="text-muted-foreground/50">{f.vcodec !== "none" ? f.vcodec : ""}</span>
                                                                <span className="text-muted-foreground/50">{formatFileSize(f.filesize || f.filesizeApprox)}</span>
                                                            </div>
                                                            <button
                                                                onClick={() => startDownload(undefined, false, f.formatId)}
                                                                disabled={status === "downloading"}
                                                                className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-all cursor-pointer disabled:opacity-40"
                                                            >
                                                                <Download className="h-2.5 w-2.5" />
                                                                Download
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Playlist Card */}
                    {playlistInfo && (
                        <div className="rounded-xl bg-card border border-border overflow-hidden">
                            {/* Playlist Header */}
                            <div className="flex gap-4 p-4 border-b border-border">
                                {playlistInfo.thumbnail && (
                                    <div className="shrink-0 w-24 h-24 rounded-lg overflow-hidden bg-muted">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={playlistInfo.thumbnail} alt={playlistInfo.title} className="w-full h-full object-cover" />
                                    </div>
                                )}
                                <div className="flex-1 min-w-0">
                                    <h2 className="text-base font-semibold text-foreground flex items-center gap-2 truncate">
                                        <ListMusic className="h-4 w-4 text-purple-500 shrink-0" />
                                        {getPlatformIcon(playlistInfo.extractor)} {playlistInfo.title}
                                    </h2>
                                    <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                                        <span className="flex items-center gap-1">
                                            <User className="h-3 w-3" />
                                            {playlistInfo.uploader || "Unknown"}
                                        </span>
                                        <span className="flex items-center gap-1 text-purple-400">
                                            <Globe className="h-3 w-3" />
                                            {playlistInfo.extractor}
                                        </span>
                                        <span className="flex items-center gap-1">
                                            <Music className="h-3 w-3" />
                                            {playlistInfo.entryCount} tracks
                                        </span>
                                    </div>
                                    {playlistInfo.description && (
                                        <p className="text-xs text-muted-foreground/60 mt-2 line-clamp-2">{playlistInfo.description}</p>
                                    )}
                                </div>
                            </div>

                            {/* Controls bar */}
                            <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-b border-border">
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={() => setSelectedTracks(new Set(playlistInfo.entries.map(e => e.id)))}
                                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                    >
                                        <CheckCheck className="h-3.5 w-3.5 text-green-400" />
                                        Select All
                                    </button>
                                    {Object.keys(duplicateMap).length > 0 && (
                                        <button
                                            onClick={() => {
                                                const dupIds = new Set(Object.keys(duplicateMap));
                                                setSelectedTracks(new Set(playlistInfo.entries.filter(e => !dupIds.has(e.id)).map(e => e.id)));
                                            }}
                                            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                        >
                                            <Sparkles className="h-3.5 w-3.5 text-blue-400" />
                                            New Only
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setSelectedTracks(new Set())}
                                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                    >
                                        <XSquare className="h-3.5 w-3.5 text-red-400" />
                                        Deselect All
                                    </button>
                                    <span className="text-[10px] text-muted-foreground/50">
                                        {selectedTracks.size} / {playlistInfo.entries.length} selected
                                        {Object.keys(duplicateMap).length > 0 && (
                                            <span className="text-blue-400 ml-1">
                                                ({Object.keys(duplicateMap).length} in library)
                                            </span>
                                        )}
                                    </span>
                                </div>

                                <label className="flex items-center gap-2 cursor-pointer">
                                    <Checkbox
                                        checked={autoAddToLibrary}
                                        onChange={e => setAutoAddToLibrary(e.target.checked)}
                                        className="h-3.5 w-3.5"
                                    />
                                    <span className="text-xs text-muted-foreground">Auto-add to library</span>
                                </label>
                            </div>

                            {/* Track list */}
                            <div className="max-h-96 overflow-y-auto divide-y divide-border/50">
                                {playlistInfo.entries.map((entry, idx) => {
                                    const isSelected = selectedTracks.has(entry.id);
                                    const batchResult = batchResults.find(r => r.trackIndex === idx);
                                    const isDownloading = status === "batch-downloading" && activeDownloads.has(idx);
                                    const duplicate = duplicateMap[entry.id];
                                    return (
                                        <div
                                            key={`${entry.id}-${idx}`}
                                            className={cn(
                                                "flex items-center gap-3 px-4 py-2 transition-colors group",
                                                isSelected ? "bg-purple-500/5" : "bg-transparent",
                                                isDownloading && "bg-purple-500/10",
                                                batchResult?.error && "bg-red-500/5",
                                                batchResult && !batchResult.error && "bg-green-500/5",
                                                duplicate && !isSelected && "opacity-50",
                                            )}
                                        >
                                            {/* Checkbox */}
                                            <button
                                                onClick={() => {
                                                    setSelectedTracks(prev => {
                                                        const next = new Set(prev);
                                                        if (next.has(entry.id)) next.delete(entry.id);
                                                        else next.add(entry.id);
                                                        return next;
                                                    });
                                                }}
                                                disabled={status === "batch-downloading" || status === "batch-adding"}
                                                className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer shrink-0 disabled:opacity-40"
                                            >
                                                {isSelected ? (
                                                    <CheckSquare className="h-4 w-4 text-purple-500" />
                                                ) : (
                                                    <Square className="h-4 w-4" />
                                                )}
                                            </button>

                                            {/* Index */}
                                            <span className="text-[10px] text-muted-foreground/40 w-5 text-right shrink-0">
                                                {idx + 1}
                                            </span>

                                            {/* Thumbnail */}
                                            {entry.thumbnail ? (
                                                <div className="w-8 h-8 rounded shrink-0 overflow-hidden bg-muted">
                                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                                    <img src={entry.thumbnail} alt="" className="w-full h-full object-cover" />
                                                </div>
                                            ) : (
                                                <div className="w-8 h-8 rounded shrink-0 bg-muted flex items-center justify-center">
                                                    <Music className="h-3 w-3 text-muted-foreground/30" />
                                                </div>
                                            )}

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-xs font-medium text-foreground truncate">{entry.title || "Unknown"}</p>
                                                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                                                    {entry.uploader && <span>{entry.uploader}</span>}
                                                    {entry.duration > 0 && <span>{formatDuration(entry.duration)}</span>}
                                                </div>
                                            </div>

                                            {/* Status indicator */}
                                            <div className="shrink-0 text-right">
                                                {duplicate && !isDownloading && !batchResult && (
                                                    <span className="flex items-center gap-1 text-[10px] text-blue-400 justify-end" title={duplicate.reason}>
                                                        <Library className="h-3 w-3" />
                                                        In Library
                                                    </span>
                                                )}
                                                {isDownloading && (
                                                    <span className="flex items-center gap-1 text-[10px] text-purple-400 justify-end">
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                        {progress ? `${progress.percent.toFixed(0)}%` : "..."}
                                                    </span>
                                                )}
                                                {batchResult && !batchResult.error && (
                                                    <span className="flex items-center gap-1 text-[10px] text-green-400 justify-end">
                                                        <CheckCircle2 className="h-3 w-3" />
                                                        {batchResult.addedTrackId ? `#${batchResult.addedTrackId}` : "Done"}
                                                    </span>
                                                )}
                                                {batchResult?.error && (
                                                    <span className="flex items-center gap-1 text-[10px] text-red-400 justify-end" title={batchResult.error}>
                                                        <AlertCircle className="h-3 w-3" />
                                                        Failed
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Actions */}
                            <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
                                {status === "batch-downloading" ? (
                                    <div className="flex items-center gap-3 flex-1">
                                        <div className="flex-1">
                                            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                                                <span>{batchResults.length} / {selectedTracks.size}{activeDownloads.size > 0 && ` · ${activeDownloads.size} active`}</span>
                                                {progress && <span>{progress.speed}</span>}
                                            </div>
                                            <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                                                <div
                                                    className="h-full bg-purple-500 rounded-full transition-all duration-300"
                                                    style={{ width: `${(batchResults.length / selectedTracks.size) * 100}%` }}
                                                />
                                            </div>
                                        </div>
                                        <button
                                            onClick={cancelDownload}
                                            className="text-xs text-muted-foreground hover:text-red-400 transition-colors cursor-pointer"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                ) : status === "batch-adding" ? (
                                    <div className="flex items-center gap-2 text-xs text-purple-400">
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Adding tracks to library & analyzing...
                                    </div>
                                ) : status === "batch-complete" ? (
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-2 text-xs">
                                            <CheckCircle2 className="h-4 w-4 text-green-400" />
                                            <span className="text-green-400">{batchResults.filter(r => !r.error).length} downloaded</span>
                                            {batchResults.some(r => r.error) && (
                                                <span className="text-red-400">{batchResults.filter(r => r.error).length} failed</span>
                                            )}
                                            {batchResults.some(r => r.addedTrackId) && (
                                                <span className="text-blue-400">{batchResults.filter(r => r.addedTrackId).length} in library</span>
                                            )}
                                        </div>
                                        {!autoAddToLibrary && batchResults.some(r => !r.error && !r.addedTrackId) && (
                                            <button
                                                onClick={batchAddToLibrary}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-xs font-medium transition-colors cursor-pointer"
                                            >
                                                <Library className="h-3.5 w-3.5" />
                                                Add All to Library
                                            </button>
                                        )}
                                        <button
                                            onClick={() => { setUrl(""); reset(); }}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-accent border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                        >
                                            <Play className="h-3 w-3" />
                                            New Download
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => startBatchDownload(true)}
                                            disabled={selectedTracks.size === 0}
                                            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-sm font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            <FileAudio className="h-4 w-4" />
                                            Convert {selectedTracks.size} ({resolvedConversionLabel})
                                        </button>
                                        <button
                                            onClick={() => startBatchDownload()}
                                            disabled={selectedTracks.size === 0}
                                            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-card hover:bg-accent border border-border text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            <Download className="h-4 w-4" />
                                            Original {selectedTracks.size}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Download Progress */}
                    {status === "downloading" && (
                        <div className="rounded-xl bg-card border border-border p-4 space-y-3">
                            <div className="flex items-center justify-between">
                                <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                                    <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                                    Downloading...
                                </h3>
                                <button
                                    onClick={cancelDownload}
                                    className="text-xs text-muted-foreground hover:text-red-400 transition-colors cursor-pointer"
                                >
                                    Cancel
                                </button>
                            </div>

                            {progress && (
                                <>
                                    <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                                        <div
                                            className="h-full bg-purple-500 rounded-full transition-all duration-300"
                                            style={{ width: `${Math.min(100, progress.percent)}%` }}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>{progress.percent.toFixed(1)}%</span>
                                        <span>{progress.speed} · {progress.totalSize}</span>
                                        <span>ETA {progress.eta}</span>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {/* Complete */}
                    {(status === "complete" || status === "adding-to-library" || status === "added") && downloadedFile && (
                        <div className="rounded-xl bg-card border border-green-500/20 p-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-5 w-5 text-green-500" />
                                <h3 className="text-sm font-medium text-foreground">Download Complete</h3>
                            </div>

                            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
                                <HardDrive className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate font-mono">{downloadedFile}</span>
                            </div>

                            <div className="flex items-center gap-2">
                                {status === "added" ? (
                                    <div className="flex items-center gap-2 text-xs text-green-400">
                                        <CheckCircle2 className="h-4 w-4" />
                                        <span>Added to library & analyzed{addedTrackId ? ` (ID: ${addedTrackId})` : ""}</span>
                                    </div>
                                ) : (
                                    <button
                                        onClick={addToLibrary}
                                        disabled={status === "adding-to-library"}
                                        className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-purple-500 hover:bg-purple-600 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                                    >
                                        {status === "adding-to-library" ? (
                                            <>
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                Adding & Analyzing...
                                            </>
                                        ) : (
                                            <>
                                                <Library className="h-3.5 w-3.5" />
                                                Add to Library & Analyze
                                            </>
                                        )}
                                    </button>
                                )}
                                <button
                                    onClick={() => { setUrl(""); reset(); }}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-card hover:bg-accent border border-border text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                                >
                                    <Play className="h-3 w-3" />
                                    Download Another
                                </button>
                            </div>

                            {/* Analysis results */}
                            {analysisResults && Object.keys(analysisResults).length > 0 && (
                                <div className="mt-2 rounded-lg bg-purple-500/5 border border-purple-500/10 p-3">
                                    <h4 className="text-[10px] uppercase tracking-wider text-purple-400/80 font-semibold mb-2 flex items-center gap-1.5">
                                        <Sparkles className="h-3 w-3" />
                                        Analysis Results
                                    </h4>
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                        {Object.entries(analysisResults).map(([key, val]) => (
                                            <div key={key} className="flex items-center gap-1.5 text-xs">
                                                {key === "Artwork" && <ImageIcon className="h-3 w-3 text-green-400" />}
                                                {key === "Genre" && <Tag className="h-3 w-3 text-blue-400" />}
                                                {key === "BPM" && <Music className="h-3 w-3 text-orange-400" />}
                                                {key === "Lyrics" && <MicVocal className="h-3 w-3 text-pink-400" />}
                                                {key === "Key" && <Music className="h-3 w-3 text-cyan-400" />}
                                                {!["Artwork", "Genre", "BPM", "Lyrics", "Key"].includes(key) && <Sparkles className="h-3 w-3 text-purple-400" />}
                                                <span className="text-muted-foreground">{key}:</span>
                                                <span className="text-foreground font-medium truncate">{val}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {status === "adding-to-library" && (
                                <p className="text-[10px] text-muted-foreground/50">
                                    Fetching metadata from MusicBrainz, iTunes, Deezer, LRCLIB...
                                </p>
                            )}
                        </div>
                    )}

                    {/* Logs */}
                    {logs.length > 0 && (
                        <div>
                            <button
                                onClick={() => setShowLogs(!showLogs)}
                                className="flex items-center gap-1.5 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
                            >
                                {showLogs ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                Logs ({logs.length})
                            </button>
                            {showLogs && (
                                <div className="mt-2 rounded-lg bg-black/50 border border-border p-3 max-h-48 overflow-y-auto font-mono text-[10px] text-muted-foreground/60 space-y-0.5">
                                    {logs.map((log, i) => (
                                        <div key={i}>{log}</div>
                                    ))}
                                    <div ref={logsEndRef} />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Supported Platforms */}
                    {status === "idle" && !mediaInfo && !playlistInfo && (
                        <div className="rounded-xl bg-card/50 border border-border/50 p-6 text-center space-y-4">
                            <div className="text-3xl">🎧</div>
                            <div>
                                <h3 className="text-sm font-medium text-foreground">Supported Platforms</h3>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Paste a URL from any of these platforms to download audio
                                </p>
                            </div>
                            <div className="flex flex-wrap justify-center gap-2">
                                {[
                                    "YouTube", "YouTube Music", "SoundCloud", "Spotify",
                                    "Bandcamp", "Vimeo", "TikTok", "Twitter/X",
                                    "Instagram", "Facebook", "Twitch", "Mixcloud",
                                    "Dailymotion", "Deezer", "1800+ more",
                                ].map(p => (
                                    <span key={p} className="px-2.5 py-1 rounded-full bg-muted text-[10px] text-muted-foreground border border-border/50">
                                        {p}
                                    </span>
                                ))}
                            </div>
                            <p className="text-[10px] text-muted-foreground/40">
                                Requires <code className="text-purple-400/60">yt-dlp</code> installed on this machine
                            </p>
                        </div>
                    )}
                </div>
                {/* End of main column */}

                {/* Right Sidebar — Latest Downloads & Download History */}
                {sidebarOpen && (
                    <DownloadSidebar
                        latestTracks={latestDownloads.tracks}
                        freshIds={latestDownloads.freshIds}
                        onRemoveLatest={latestDownloads.removeTrack}
                        history={history}
                        historyLoading={historyLoading}
                        onClearHistory={clearHistory}
                        onDeleteHistoryItem={deleteHistoryItem}
                        onRedownload={(historyUrl) => {
                            setUrl(historyUrl);
                            setInputMode("url");
                            fetchInfo(historyUrl);
                        }}
                        activeTab={sidebarTab}
                        onTabChange={setSidebarTab}
                        onClose={() => setSidebarOpen(false)}
                    />
                )}

                {/* Folder Picker Modal */}
                {showFolderPicker && (
                    <FolderPicker
                        currentPath={downloadFolder}
                        onSelect={(path) => {
                            setDownloadFolder(path);
                            saveSetting("downloadFolder", path);
                            setShowFolderPicker(false);
                            toast.success(`Download folder set to ${path}`);
                        }}
                        onClose={() => setShowFolderPicker(false)}
                    />
                )}
            </div>
        </div>
    );
}
