"use client";

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { usePlayer } from "./player-context";
import { usePersonalization, getMixerBackgroundStyle } from "@/hooks/use-personalization";
import { Artwork } from "./artwork";
import { FavoriteButton } from "./favorite-button";
import { VisualizationControls } from "./visualization-controls";
import { formatDuration, formatBytes, GENRE_COLORS, cn, formatKey } from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { getRecommendedTracks } from "@/actions/recommendations";
import { toggleFavorite } from "@/actions/tracks";
import {
    getAllVisualizations,
    getVisualizationById,
    getRandomVisualization,
    getCategories,
    getVisualizationsByCategory,
    searchVisualizations,
    loadVizSettings,
    saveVizSettings,
} from "@/lib/visualizations/registry";
import type { VisualizationDef } from "@/lib/visualizations/types";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Shuffle,
    Repeat,
    Repeat1,
    ChevronDown,
    Volume2,
    VolumeX,
    ListMusic,
    Music,
    Mic2,
    X,
    Plus,
    MoreHorizontal,
    Disc3,
    Sparkles,
    History,
    Heart,
    Image as ImageIcon,
    AudioWaveform,
    Search,
    Grid3X3,
    ChevronRight,
    SlidersHorizontal,
    Film,
} from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { WaveformSeekbar, type WaveformMode } from "./waveform-seekbar";
import { Equalizer } from "./equalizer";
import { useEQ } from "./eq-context";
import { PerformanceInline, SessionRestoreIndicator } from "./performance-stats";
import { TrackContextMenu } from "./track-actions";
import { SortableUpNext } from "./sortable-up-next";
import { motion, AnimatePresence } from "framer-motion";

// Dynamic imports for heavy components (code-split, no SSR)
const VisualizationCanvas = dynamic(
    () => import("./visualization-canvas").then(m => ({ default: m.VisualizationCanvas })),
    { ssr: false }
);
const MixerView = dynamic(
    () => import("./mixer-view").then(m => ({ default: m.MixerView })),
    { ssr: false, loading: () => <div className="flex-1 flex items-center justify-center text-white/30">Loading mixer...</div> }
);
import type { Track } from "@/db/schema";

// Genre-based gradient colors
const GENRE_GRADIENTS: Record<string, string> = {
    Techno: "from-purple-900/40 via-zinc-900/60",
    House: "from-blue-900/40 via-zinc-900/60",
    "Drum & Bass": "from-orange-900/40 via-zinc-900/60",
    Trance: "from-cyan-900/40 via-zinc-900/60",
    Pop: "from-pink-900/40 via-zinc-900/60",
    Rock: "from-red-900/40 via-zinc-900/60",
    Electronic: "from-violet-900/40 via-zinc-900/60",
    Reggae: "from-green-900/40 via-zinc-900/60",
    "Hip-Hop": "from-amber-900/40 via-zinc-900/60",
    Dance: "from-fuchsia-900/40 via-zinc-900/60",
};

function getGenreGradient(genre?: string | null): string {
    if (!genre) return "from-zinc-900/60 via-zinc-900/80";
    for (const [key, val] of Object.entries(GENRE_GRADIENTS)) {
        if (genre.toLowerCase().includes(key.toLowerCase())) return val;
    }
    return "from-purple-900/30 via-zinc-900/60";
}

interface RecommendedTrack {
    id: number;
    title: string | null;
    artist: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    genre: string | null;
    duration: number | null;
    score: number;
    reason: string;
}

type TabType = "queue" | "recommended" | "lyrics";
type LeftView = "artwork" | "visualization" | "equalizer" | "mixer" | "video";

export function NowPlaying() {
    const player = usePlayer();
    const personalization = usePersonalization();
    const { noteNotations } = useDAWSettings();
    const searchParams = useSearchParams();
    const [activeTab, setActiveTab] = useState<TabType>("queue");
    const [leftView, setLeftView] = useState<LeftView>("mixer");
    const [recommendations, setRecommendations] = useState<RecommendedTrack[]>([]);
    const [isClosing, setIsClosing] = useState(false);
    const [hasMounted, setHasMounted] = useState(false);

    // Restore leftView from localStorage / URL after mount to avoid hydration mismatch.
    // Reading window/localStorage during render would crash on the server, so the
    // setState-in-effect lint rule is intentionally suppressed here.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only hydration flag
        setHasMounted(true);
        const urlView = new URLSearchParams(window.location.search).get("view");
        if (urlView === "mixer" || urlView === "artwork" || urlView === "visualization" || urlView === "equalizer" || urlView === "video") {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only browser hydration
            setLeftView(urlView);
            return;
        }
        const saved = localStorage.getItem("mmo-np-left-view");
        if (saved === "artwork" || saved === "visualization" || saved === "equalizer" || saved === "mixer" || saved === "video") {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only browser hydration
            setLeftView(saved);
        }
    }, []);

    // Persist leftView
    useEffect(() => {
        if (hasMounted) localStorage.setItem("mmo-np-left-view", leftView);
    }, [leftView, hasMounted]);

    // Handle requestedView from player context (e.g. keyboard shortcut Shift+M).
    // The view is owned by external player state — mirroring it locally on change
    // is the established pattern; setState-in-effect is intentional.
    useEffect(() => {
        if (player.requestedView) {
            const v = player.requestedView;
            if (v === "artwork" || v === "visualization" || v === "equalizer" || v === "mixer" || v === "video") {
                // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror external player state
                setLeftView(v);
            }
            player.clearRequestedView();
        }
    }, [player.requestedView, player.clearRequestedView]);

    // When a video becomes the active media, surface the Video left view automatically.
    useEffect(() => {
        if (player.currentVideo) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror external media state
            setLeftView("video");
        }
    }, [player.currentVideo?.fileId]);

    // Handle ?view= URL query param — open now playing with the requested view.
    // Same rationale as above: external (URL) state propagates into local view.
    useEffect(() => {
        const urlView = searchParams.get("view");
        if (urlView && (urlView === "mixer" || urlView === "artwork" || urlView === "visualization" || urlView === "equalizer" || urlView === "video")) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror external URL state
            setLeftView(urlView);
            if (!player.isNowPlayingOpen) {
                player.openNowPlaying();
            }
        }
    }, [searchParams]);

    const [historyCollapsed, setHistoryCollapsed] = useState(true);
    const [, startTransition] = useTransition();

    // Visualization state
    const allViz = getAllVisualizations();
    const categories = useMemo(() => getCategories(), []);
    const [vizSettings, setVizSettings] = useState(() => loadVizSettings());
    const [currentVizIdx, setCurrentVizIdx] = useState(0);
    const [vizFps, setVizFps] = useState(0);
    const [isTheater, setIsTheater] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [showVizBrowser, setShowVizBrowser] = useState(false);
    const [vizBrowseCategory, setVizBrowseCategory] = useState<string | null>(null);
    const [vizSearchQuery, setVizSearchQuery] = useState("");
    const [waveformMode, setWaveformMode] = useState<WaveformMode>("classic");

    // Restore waveformMode from localStorage after mount
    useEffect(() => {
        const saved = localStorage.getItem("waveform-mode");
        // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-only browser hydration
        if (saved === "rgb") setWaveformMode("rgb");
    }, []);
    const [mobilePanel, setMobilePanel] = useState(false);
    const vizContainerRef = useRef<HTMLDivElement>(null);
    const mobilePanelRef = useRef<HTMLDivElement>(null);
    const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

    const currentViz = allViz[currentVizIdx] || allViz[0];
    const isVizFavorite = vizSettings.favorites.includes(currentViz?.id || "");

    // React Compiler memoizes these automatically; manual useCallback wrappers
    // were stripped because the rule kept reporting "Compilation Skipped".
    const nextViz = () => {
        setCurrentVizIdx(i => (i + 1) % allViz.length);
    };

    const prevViz = () => {
        setCurrentVizIdx(i => (i - 1 + allViz.length) % allViz.length);
    };

    const randomViz = () => {
        const rand = getRandomVisualization(currentViz?.id);
        const idx = allViz.findIndex(v => v.id === rand.id);
        if (idx >= 0) setCurrentVizIdx(idx);
    };

    const toggleVizFavorite = () => {
        setVizSettings(prev => {
            const id = currentViz?.id;
            if (!id) return prev;
            const favs = prev.favorites.includes(id)
                ? prev.favorites.filter(f => f !== id)
                : [...prev.favorites, id];
            const next = { ...prev, favorites: favs };
            saveVizSettings(next);
            return next;
        });
    };

    const toggleVizStats = () => {
        setVizSettings(prev => {
            const next = { ...prev, showStats: !prev.showStats };
            saveVizSettings(next);
            return next;
        });
    };

    const toggleTheater = () => {
        setIsTheater(prev => !prev);
    };

    const toggleFullscreen = async () => {
        try {
            if (!document.fullscreenElement) {
                const el = vizContainerRef.current;
                if (el) {
                    await el.requestFullscreen();
                    setIsFullscreen(true);
                }
            } else {
                await document.exitFullscreen();
                setIsFullscreen(false);
            }
        } catch {
            // Fullscreen not supported or denied
        }
    };

    // Listen for fullscreen changes (e.g. user presses Escape)
    useEffect(() => {
        const handler = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener("fullscreenchange", handler);
        return () => document.removeEventListener("fullscreenchange", handler);
    }, []);

    // Browsable visualizations for the side panel
    const browsedViz = (() => {
        if (vizSearchQuery) return searchVisualizations(vizSearchQuery);
        if (vizBrowseCategory) return getVisualizationsByCategory(vizBrowseCategory);
        return allViz;
    })();

    const selectViz = (viz: VisualizationDef) => {
        const idx = allViz.findIndex(v => v.id === viz.id);
        if (idx >= 0) setCurrentVizIdx(idx);
    };

    const { currentTrack, isPlaying, currentTime, duration, volume, queue, queueIndex, playHistory } = player;

    // Fetch recommendations when current track changes
    useEffect(() => {
        if (!currentTrack) return;
        startTransition(async () => {
            const recs = await getRecommendedTracks(
                currentTrack.id,
                currentTrack.genre,
                currentTrack.bpm,
                currentTrack.keyCamelot
            );
            setRecommendations(recs);
        });
    }, [currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // Mobile swipe gestures:
    // - Horizontal: left to open queue panel, right to close it
    // - Vertical: swipe down to close Now Playing
    const handleTouchStart = (e: React.TouchEvent) => {
        const touch = e.touches[0];
        touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (!touchStartRef.current) return;
        const touch = e.changedTouches[0];
        const dx = touch.clientX - touchStartRef.current.x;
        const dy = touch.clientY - touchStartRef.current.y;
        const dt = Date.now() - touchStartRef.current.time;
        touchStartRef.current = null;

        if (dt > 500) return;

        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);

        // Vertical swipe down → close Now Playing
        if (dy > 80 && absDy > absDx && !mobilePanel) {
            setIsClosing(true);
            setTimeout(() => {
                player.closeNowPlaying();
                setIsClosing(false);
            }, 280);
            return;
        }

        // Horizontal swipes → queue panel
        if (absDx < 50 || absDy > absDx) return;
        if (dx < -50 && !mobilePanel) setMobilePanel(true);
        if (dx > 50 && mobilePanel) setMobilePanel(false);
    };

    if (!hasMounted || !player.isNowPlayingOpen) return null;

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const gradient = getGenreGradient(currentTrack?.genre);
    const upNext = queue.slice(queueIndex + 1);

    function handleClose() {
        setIsClosing(true);
        setTimeout(() => {
            player.closeNowPlaying();
            setIsClosing(false);
        }, 280);
    }

    function handleAddRecommendation(rec: RecommendedTrack) {
        player.addToQueue({
            id: rec.id,
            title: rec.title,
            artist: rec.artist,
            bpm: rec.bpm,
            keyCamelot: rec.keyCamelot,
            genre: rec.genre,
            duration: rec.duration,
        } as Track);
    }

    function handlePlayRecommendation(rec: RecommendedTrack) {
        const track = {
            id: rec.id,
            title: rec.title,
            artist: rec.artist,
            bpm: rec.bpm,
            keyCamelot: rec.keyCamelot,
            genre: rec.genre,
            duration: rec.duration,
        } as Track;
        player.addToQueue(track);
        const newIndex = player.queue.findIndex((t) => t.id === rec.id);
        if (newIndex >= 0) {
            player.playFromQueue(newIndex);
        } else {
            player.playFromQueue(player.queueIndex + 1);
        }
    }

    return (
        <div
            data-nowplaying
            className={cn(
                "fixed inset-0 z-[60] flex flex-col",
                isClosing
                    ? "animate-[slideDown_300ms_ease-in_forwards]"
                    : "animate-[slideUp_300ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            )}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
        >
            {/* Background - genre gradient for non-mixer views, personalized for mixer, video for video mode */}
            {leftView === "mixer" ? (
                <div className="absolute inset-0" style={getMixerBackgroundStyle(personalization)} />
            ) : leftView === "video" ? (
                <div className="absolute inset-0 bg-black">
                    {player.currentVideo ? (
                        <div
                            id="np-video-tab-mount"
                            className="absolute inset-0"
                            style={{ viewTransitionName: `np-video-${player.currentVideo.fileId}` }}
                        />
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-white/30">
                            <div className="text-center">
                                <Film className="h-14 w-14 mx-auto mb-4 opacity-40" />
                                <p className="text-sm font-medium">No video playing</p>
                                <p className="text-xs mt-1">Open a movie or episode from the Watch tab to start.</p>
                            </div>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <div className={cn("absolute inset-0 bg-gradient-to-b to-[#0a0a0a]", gradient)} />
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-xl" />
                </>
            )}

            {/* Content */}
            <div className={cn("relative flex flex-col h-full", leftView === "video" && "pointer-events-none")}>
                {/* Top scrim — fades dark over the video so the top bar stays readable */}
                {leftView === "video" && (
                    <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/80 via-black/40 to-transparent pointer-events-none" />
                )}
                {/* Top Bar */}
                <div className={cn("relative flex items-center justify-between px-4 sm:px-6 py-3", leftView === "video" && "pointer-events-auto")}>
                    <button
                        onClick={handleClose}
                        className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer shrink-0"
                    >
                        <ChevronDown className="h-5 w-5" />
                        <span className="hidden sm:inline">Now Playing</span>
                    </button>

                    {/* View Switcher — absolute-centered to full header width */}
                    <div className={cn(
                        "absolute left-1/2 -translate-x-1/2 flex items-center gap-0.5 rounded-lg p-0.5 animate-[fadeIn_400ms_100ms_both]",
                        leftView === "video" ? "bg-black/60 backdrop-blur-md ring-1 ring-white/10" : "bg-white/5"
                    )}>
                        <button
                            onClick={() => setLeftView("artwork")}
                            className={cn(
                                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                leftView === "artwork"
                                    ? "bg-white/10 text-white"
                                    : "text-white/40 hover:text-white/70"
                            )}
                        >
                            <ImageIcon className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Artwork</span>
                        </button>
                        {player.currentVideo && (
                            <button
                                onClick={() => setLeftView("video")}
                                className={cn(
                                    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                    leftView === "video"
                                        ? "bg-white/10 text-white"
                                        : "text-white/40 hover:text-white/70"
                                )}
                            >
                                <Film className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Video</span>
                            </button>
                        )}
                        <button
                            onClick={() => setLeftView("visualization")}
                            className={cn(
                                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                leftView === "visualization"
                                    ? "bg-white/10 text-white"
                                    : "text-white/40 hover:text-white/70"
                            )}
                        >
                            <AudioWaveform className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Visualizer</span>
                        </button>
                        <EQTabButton leftView={leftView} onClick={() => setLeftView("equalizer")} />
                        <button
                            onClick={() => setLeftView("mixer")}
                            className={cn(
                                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                leftView === "mixer"
                                    ? "bg-white/10 text-white"
                                    : "text-white/40 hover:text-white/70"
                            )}
                        >
                            <Disc3 className="h-3.5 w-3.5" />
                            <span className="hidden sm:inline">Mixer</span>
                        </button>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                        {/* Episode prev/next (video mode only) */}
                        {leftView === "video" && player.currentVideo && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => player.prevVideo()}
                                    disabled={player.videoQueueIndex <= 0}
                                    className="px-2.5 py-1.5 rounded-md bg-black/50 backdrop-blur hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white/90 transition-colors"
                                    title="Previous in queue"
                                >
                                    ◀ Prev
                                </button>
                                <button
                                    type="button"
                                    onClick={() => player.nextVideo()}
                                    disabled={player.videoQueueIndex >= player.videoQueue.length - 1}
                                    className="px-2.5 py-1.5 rounded-md bg-black/50 backdrop-blur hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed text-xs text-white/90 transition-colors"
                                    title="Next episode in queue"
                                >
                                    Next ▶
                                </button>
                            </>
                        )}
                        {/* Session restore indicator */}
                        {leftView === "mixer" && <SessionRestoreIndicator className="hidden md:flex" />}
                        {/* Performance stats inline */}
                        {personalization.performanceStatsPosition === "on" && leftView === "mixer" && (
                            <PerformanceInline className="hidden md:flex" />
                        )}
                        {/* Queue toggle (always visible in mixer/video, mobile-only otherwise) */}
                        <button
                            onClick={() => setMobilePanel((v) => !v)}
                            className={cn(
                                "p-2 rounded-lg transition-colors cursor-pointer",
                                leftView !== "mixer" && leftView !== "video" && "lg:hidden",
                                mobilePanel ? "bg-purple-500/20 text-purple-400" : "hover:bg-white/10"
                            )}
                        >
                            <ListMusic className="h-4 w-4" />
                        </button>
                        <button className="p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer">
                            <MoreHorizontal className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className={cn("flex-1 flex gap-6 pb-4 overflow-hidden", leftView === "mixer" || leftView === "video" ? "px-0" : "px-4 sm:px-6", leftView === "video" && "pointer-events-none")}>
                    {/* Left Side - Artwork/Visualization + Controls */}
                    <div className={cn("flex-1 flex flex-col w-full", leftView === "mixer" || leftView === "video" ? "" : "items-center justify-center max-w-2xl mx-auto")}>
                        {leftView === "artwork" && currentTrack && (
                            <AnimatePresence mode="wait">
                                <motion.div
                                    key={currentTrack.id}
                                    initial={{ opacity: 0, scale: 0.96, y: 8 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.96, y: -8 }}
                                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                                    className="flex flex-col items-center w-full"
                                >
                                    {/* Artwork with waveform overlay */}
                                    <TrackContextMenu track={currentTrack} onMutate={() => { }}>
                                        <div className="relative mb-8">
                                            {currentTrack.artworkUrl ? (
                                                <div className="relative animate-[pulseGlow_3s_ease-in-out_infinite] rounded-2xl">
                                                    // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                                                    <img
                                                        src={currentTrack.artworkUrl}
                                                        alt={currentTrack.title || "Artwork"}
                                                        className="w-52 h-52 sm:w-64 sm:h-64 lg:w-72 lg:h-72 rounded-2xl object-cover shadow-2xl"
                                                    />
                                                    {/* Waveform overlay on artwork */}
                                                    <div className="absolute inset-0 rounded-2xl overflow-hidden">
                                                        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/60 to-transparent" />
                                                        <div className="absolute left-2 right-2 bottom-0 h-[45%] overflow-hidden">
                                                            <WaveformSeekbar
                                                                trackId={currentTrack.id}
                                                                progress={duration > 0 ? currentTime / duration : 0}
                                                                duration={duration}
                                                                isPlaying={isPlaying}
                                                                onSeek={(t) => player.seek(t)}
                                                                overlay
                                                                mode={waveformMode}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="relative w-52 h-52 sm:w-64 sm:h-64 lg:w-72 lg:h-72 rounded-2xl bg-gradient-to-br from-purple-500/30 to-blue-500/30 flex items-center justify-center shadow-2xl animate-[pulseGlow_3s_ease-in-out_infinite]">
                                                    <Disc3
                                                        className={cn(
                                                            "h-24 w-24 text-white/20",
                                                            isPlaying && "animate-[vinylSpin_3s_linear_infinite]"
                                                        )}
                                                    />
                                                    {/* Waveform overlay on placeholder */}
                                                    <div className="absolute inset-0 rounded-2xl overflow-hidden">
                                                        <div className="absolute left-2 right-2 bottom-0 h-[45%] overflow-hidden">
                                                            <WaveformSeekbar
                                                                trackId={currentTrack.id}
                                                                progress={duration > 0 ? currentTime / duration : 0}
                                                                duration={duration}
                                                                isPlaying={isPlaying}
                                                                onSeek={(t) => player.seek(t)}
                                                                overlay
                                                                mode={waveformMode}
                                                            />
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </TrackContextMenu>

                                    {/* Track Info */}
                                    <div className="text-center mb-6 w-full">
                                        <div className="flex items-center justify-center gap-3 px-4">
                                            <h2 className="text-2xl font-bold truncate">
                                                {currentTrack.title || currentTrack.filename}
                                            </h2>
                                            <FavoriteButton
                                                isFavorite={!!currentTrack.isFavorite}
                                                onChange={(val) => {
                                                    toggleFavorite(currentTrack.id);
                                                }}
                                                size="lg"
                                            />
                                        </div>
                                        <p className="text-lg text-[var(--muted-foreground)] mt-1 truncate px-4">
                                            {currentTrack.artist || "Unknown Artist"}
                                        </p>
                                        {currentTrack.album && (
                                            <p className="text-sm text-[var(--muted-foreground)]/60 mt-0.5 truncate px-4">
                                                {currentTrack.album}
                                                {currentTrack.year ? ` · ${currentTrack.year}` : ""}
                                            </p>
                                        )}
                                        {/* Metadata badges */}
                                        <div className="flex items-center justify-center gap-3 mt-3">
                                            {currentTrack.bpm && (
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                                                    {Math.round(currentTrack.bpm)} BPM
                                                </span>
                                            )}
                                            {currentTrack.keyCamelot && (
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                                                    {formatKey(currentTrack.keyCamelot, noteNotations)}
                                                </span>
                                            )}
                                            {currentTrack.genre && (
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                                                    {currentTrack.genre}
                                                </span>
                                            )}
                                        </div>
                                        {/* Technical info row */}
                                        <div className="flex items-center justify-center gap-2 mt-2">
                                            {currentTrack.bitrate && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 tabular-nums">
                                                    {currentTrack.bitrate} kbps
                                                </span>
                                            )}
                                            {currentTrack.format && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 uppercase">
                                                    {currentTrack.format}
                                                </span>
                                            )}
                                            {currentTrack.sampleRate && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40 tabular-nums">
                                                    {(currentTrack.sampleRate / 1000).toFixed(1)} kHz
                                                </span>
                                            )}
                                            {currentTrack.fileSize && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40">
                                                    {formatBytes(currentTrack.fileSize)}
                                                </span>
                                            )}
                                            {currentTrack.label && (
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-white/40">
                                                    {currentTrack.label}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Waveform Seekbar */}
                                    <div className="w-full mb-4">
                                        <WaveformSeekbar
                                            trackId={currentTrack.id}
                                            progress={duration > 0 ? currentTime / duration : 0}
                                            duration={duration}
                                            isPlaying={isPlaying}
                                            onSeek={(t) => player.seek(t)}
                                            className="h-20"
                                            mode={waveformMode}
                                        />
                                        <div className="flex justify-between items-center mt-1.5">
                                            <span className="text-xs text-white/50 tabular-nums">
                                                {formatDuration(Math.floor(currentTime))}
                                            </span>
                                            <button
                                                onClick={() => setWaveformMode(m => {
                                                    const next = m === "classic" ? "rgb" : "classic";
                                                    localStorage.setItem("waveform-mode", next);
                                                    return next;
                                                })}
                                                className={cn(
                                                    "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium transition-all",
                                                    waveformMode === "rgb"
                                                        ? "bg-gradient-to-r from-red-500/20 via-green-500/20 to-blue-500/20 text-white/90 ring-1 ring-white/20"
                                                        : "bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60"
                                                )}
                                            >
                                                <AudioWaveform className="h-3 w-3" />
                                                {waveformMode === "rgb" ? "RGB" : "Classic"}
                                            </button>
                                            <span className="text-xs text-white/50 tabular-nums">
                                                {formatDuration(Math.floor(duration))}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Controls */}
                                    <div className="flex items-center justify-center gap-6 mb-4">
                                        <button
                                            onClick={player.toggleShuffle}
                                            className={cn(
                                                "p-2 rounded-full transition-colors cursor-pointer",
                                                player.shuffle ? "text-purple-400" : "text-white/50 hover:text-white"
                                            )}
                                            title={player.shuffle ? "Shuffle: On" : "Shuffle: Off"}
                                        >
                                            <Shuffle className="h-5 w-5" />
                                        </button>

                                        <button
                                            onClick={player.prev}
                                            className="p-2 text-white/80 hover:text-white transition-colors cursor-pointer"
                                        >
                                            <SkipBack className="h-6 w-6" />
                                        </button>

                                        <button
                                            onClick={player.togglePlay}
                                            className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black hover:scale-105 active:scale-95 transition-transform cursor-pointer shadow-lg"
                                        >
                                            {isPlaying ? (
                                                <Pause className="h-6 w-6" />
                                            ) : (
                                                <Play className="h-6 w-6 ml-1" />
                                            )}
                                        </button>

                                        <button
                                            onClick={player.next}
                                            className="p-2 text-white/80 hover:text-white transition-colors cursor-pointer"
                                        >
                                            <SkipForward className="h-6 w-6" />
                                        </button>

                                        <button
                                            onClick={player.toggleRepeat}
                                            className={cn(
                                                "p-2 rounded-full transition-colors cursor-pointer",
                                                player.repeat !== "off" ? "text-purple-400" : "text-white/50 hover:text-white"
                                            )}
                                            title={`Repeat: ${player.repeat}`}
                                        >
                                            {player.repeat === "one" ? (
                                                <Repeat1 className="h-5 w-5" />
                                            ) : (
                                                <Repeat className="h-5 w-5" />
                                            )}
                                        </button>
                                    </div>

                                    {/* Secondary Controls */}
                                    <div className="flex items-center justify-center gap-4">
                                        <div className="flex items-center gap-2 w-28">
                                            <button
                                                onClick={() => player.setVolume(volume > 0 ? 0 : 0.8)}
                                                className="text-white/50 hover:text-white transition-colors cursor-pointer"
                                            >
                                                {volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                                            </button>
                                            <input
                                                type="range"
                                                min={0}
                                                max={1}
                                                step={0.01}
                                                value={volume}
                                                onChange={(e) => player.setVolume(parseFloat(e.target.value))}
                                                className="w-full h-1 accent-white cursor-pointer"
                                            />
                                        </div>
                                    </div>                            </motion.div>
                            </AnimatePresence>
                        )}
                        {leftView === "artwork" && !currentTrack && (
                            <div className="flex flex-col items-center justify-center flex-1 gap-4 animate-[fadeIn_400ms_ease-out]">
                                <div className="w-52 h-52 sm:w-64 sm:h-64 lg:w-72 lg:h-72 rounded-2xl bg-gradient-to-br from-purple-500/10 to-fuchsia-500/10 flex items-center justify-center shadow-2xl border border-white/5">
                                    <Disc3 className="h-24 w-24 text-white/10" />
                                </div>
                                <div className="text-center space-y-2">
                                    <h2 className="text-xl font-semibold text-white/40">No Track Playing</h2>
                                    <p className="text-sm text-white/20">Select a track from your library to start playing</p>
                                </div>
                            </div>
                        )}
                        {leftView === "visualization" && (
                            /* Visualization View */
                            <div
                                ref={vizContainerRef}
                                className={cn(
                                    "relative rounded-2xl overflow-hidden animate-[scaleIn_400ms_cubic-bezier(0.16,1,0.3,1)] bg-black",
                                    isTheater
                                        ? "fixed inset-0 z-[70] rounded-none"
                                        : "w-full flex-1 min-h-0 mb-4"
                                )}
                            >
                                {currentViz && (
                                    <>
                                        <VisualizationCanvas
                                            visualization={currentViz}
                                            sensitivity={vizSettings.sensitivity}
                                            quality={vizSettings.quality}
                                            showStats={vizSettings.showStats}
                                            onFpsUpdate={setVizFps}
                                        />
                                        <VisualizationControls
                                            current={currentViz}
                                            isFavorite={isVizFavorite}
                                            showStats={vizSettings.showStats}
                                            isTheater={isTheater}
                                            isFullscreen={isFullscreen}
                                            onPrev={prevViz}
                                            onNext={nextViz}
                                            onRandom={randomViz}
                                            onToggleFavorite={toggleVizFavorite}
                                            onToggleStats={toggleVizStats}
                                            onToggleTheater={toggleTheater}
                                            onToggleFullscreen={toggleFullscreen}
                                            onOpenBrowser={() => setShowVizBrowser(prev => !prev)}
                                            fps={vizFps}
                                        />
                                    </>
                                )}
                                {/* Viz Browser Panel (slides in from right) */}
                                {showVizBrowser && (
                                    <VizBrowserPanel
                                        allViz={browsedViz}
                                        categories={categories}
                                        selectedCategory={vizBrowseCategory}
                                        searchQuery={vizSearchQuery}
                                        currentVizId={currentViz?.id}
                                        favorites={vizSettings.favorites}
                                        onSelectCategory={setVizBrowseCategory}
                                        onSearch={setVizSearchQuery}
                                        onSelect={selectViz}
                                        onClose={() => setShowVizBrowser(false)}
                                    />
                                )}
                                {/* Media Controls Bar overlaid on visualization */}
                                <VizMediaBar
                                    track={currentTrack}
                                    isPlaying={isPlaying}
                                    currentTime={currentTime}
                                    duration={duration}
                                    volume={volume}
                                    onTogglePlay={player.togglePlay}
                                    onNext={player.next}
                                    onPrev={player.prev}
                                    onSeek={player.seek}
                                    onSetVolume={player.setVolume}
                                />
                            </div>
                        )}
                        {leftView === "equalizer" && (
                            /* Equalizer View */
                            <div className="w-full flex-1 flex flex-col min-h-0 mb-4 animate-[scaleIn_400ms_cubic-bezier(0.16,1,0.3,1)]">
                                <div className="flex-1 min-h-0 overflow-y-auto">
                                    <Equalizer getAnalyser={player.getAnalyserNode} />
                                </div>
                                {/* Media Controls */}
                                <div className="shrink-0 pt-4 space-y-3">
                                    {/* Track info */}
                                    <div className="text-center">
                                        <p className="text-sm font-semibold truncate px-4">
                                            {currentTrack?.title || currentTrack?.filename || "No Track"}
                                        </p>
                                        <p className="text-xs text-white/50 truncate px-4">
                                            {currentTrack?.artist || "Unknown Artist"}
                                        </p>
                                    </div>
                                    {/* Progress bar */}
                                    <div className="px-2">
                                        <div
                                            className="h-1 rounded-full bg-white/10 cursor-pointer group"
                                            onClick={(e) => {
                                                const rect = e.currentTarget.getBoundingClientRect();
                                                const pct = (e.clientX - rect.left) / rect.width;
                                                player.seek(Math.max(0, Math.min(1, pct)) * duration);
                                            }}
                                        >
                                            <div
                                                className="h-full rounded-full bg-purple-500 transition-[width] duration-200"
                                                style={{ width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }}
                                            />
                                        </div>
                                        <div className="flex justify-between mt-1">
                                            <span className="text-[10px] text-white/40 tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
                                            <span className="text-[10px] text-white/40 tabular-nums">{formatDuration(Math.floor(duration))}</span>
                                        </div>
                                    </div>
                                    {/* Buttons */}
                                    <div className="flex items-center justify-center gap-5">
                                        <button onClick={player.toggleShuffle} className={cn("p-1.5 rounded-full transition-colors cursor-pointer", player.shuffle ? "text-purple-400" : "text-white/40 hover:text-white/70")}>
                                            <Shuffle className="h-4 w-4" />
                                        </button>
                                        <button onClick={player.prev} className="p-1.5 text-white/70 hover:text-white transition-colors cursor-pointer">
                                            <SkipBack className="h-5 w-5" />
                                        </button>
                                        <button onClick={player.togglePlay} className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black hover:scale-105 active:scale-95 transition-transform cursor-pointer shadow-lg">
                                            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 ml-0.5" />}
                                        </button>
                                        <button onClick={player.next} className="p-1.5 text-white/70 hover:text-white transition-colors cursor-pointer">
                                            <SkipForward className="h-5 w-5" />
                                        </button>
                                        <button onClick={player.toggleRepeat} className={cn("p-1.5 rounded-full transition-colors cursor-pointer", player.repeat !== "off" ? "text-purple-400" : "text-white/40 hover:text-white/70")}>
                                            {player.repeat === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {leftView === "mixer" && (
                            <div
                                className={cn(
                                    "w-full flex-1 flex flex-col min-h-0",
                                    !personalization.reducedAnimations && "animate-[scaleIn_400ms_cubic-bezier(0.16,1,0.3,1)]"
                                )}
                                style={{ fontSize: `${personalization.textScale * 100}%` }}
                            >
                                <MixerView />
                            </div>
                        )}

                        {/* leftView === "video" intentionally renders nothing in the main flow.
                            The canonical <VideoPlayer> portals into the absolute background mount
                            and provides its own title, controls, and bookmark panel. */}
                    </div>

                    {/* Right Side - Queue / Recommended / Lyrics */}
                    {!isTheater && (
                        <>
                            {/* Backdrop */}
                            <div
                                className={cn(
                                    "fixed inset-0 z-[65] bg-black/60 transition-opacity duration-300",
                                    leftView !== "mixer" && leftView !== "video" && "lg:hidden",
                                    mobilePanel ? "opacity-100" : "opacity-0 pointer-events-none"
                                )}
                                onClick={() => setMobilePanel(false)}
                            />
                            <div
                                ref={mobilePanelRef}
                                onTouchStart={handleTouchStart}
                                onTouchEnd={handleTouchEnd}
                                className={cn(
                                    // Base: off-screen slide panel
                                    "fixed inset-y-0 right-0 z-[66] w-[85vw] max-w-md",
                                    "flex flex-col bg-[#0a0a0a]/95 backdrop-blur-2xl border-l border-white/10",
                                    "transition-transform duration-300 ease-out",
                                    "overflow-hidden",
                                    // Slide in/out
                                    mobilePanel ? "translate-x-0" : "translate-x-full",
                                    // Desktop (non-mixer, non-video): static sidebar, always visible
                                    leftView !== "mixer" && leftView !== "video" && [
                                        "lg:relative lg:inset-auto lg:z-auto lg:w-96 lg:shrink-0 lg:max-w-none",
                                        "lg:translate-x-0 lg:transition-none",
                                        "lg:bg-black/30 lg:backdrop-blur-none lg:rounded-2xl lg:border lg:border-white/5",
                                        "lg:animate-[fadeIn_400ms_300ms_both]",
                                    ]
                                )}
                            >
                                {/* Handle bar (visible when panel is overlay) */}
                                <div className={cn("flex justify-center pt-3 pb-1", leftView !== "mixer" && leftView !== "video" && "lg:hidden")}>
                                    <div className="w-8 h-1 rounded-full bg-white/20" />
                                </div>
                                {/* Tabs */}
                                <div className="flex border-b border-white/10">
                                    <button
                                        onClick={() => setActiveTab("queue")}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors cursor-pointer",
                                            activeTab === "queue"
                                                ? "text-white border-b-2 border-purple-400"
                                                : "text-white/50 hover:text-white/80"
                                        )}
                                    >
                                        <ListMusic className="h-4 w-4" />
                                        Queue
                                    </button>
                                    <button
                                        onClick={() => setActiveTab("recommended")}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors cursor-pointer",
                                            activeTab === "recommended"
                                                ? "text-white border-b-2 border-purple-400"
                                                : "text-white/50 hover:text-white/80"
                                        )}
                                    >
                                        <Sparkles className="h-4 w-4" />
                                        Recommended
                                    </button>
                                    <button
                                        onClick={() => setActiveTab("lyrics")}
                                        className={cn(
                                            "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors cursor-pointer",
                                            activeTab === "lyrics"
                                                ? "text-white border-b-2 border-purple-400"
                                                : "text-white/50 hover:text-white/80"
                                        )}
                                    >
                                        <Mic2 className="h-4 w-4" />
                                        Lyrics
                                    </button>
                                </div>

                                {/* Tab Content */}
                                <div className="flex-1 overflow-y-auto overscroll-contain">
                                    {activeTab === "queue" ? (
                                        <div className="p-2">
                                            {/* Previously Played */}
                                            {playHistory.length > 0 && (
                                                <>
                                                    <button
                                                        onClick={() => setHistoryCollapsed((v) => !v)}
                                                        className="flex items-center justify-between w-full px-3 py-2 cursor-pointer hover:bg-white/5 rounded-lg transition-colors"
                                                    >
                                                        <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold flex items-center gap-1.5">
                                                            <History className="h-3 w-3" />
                                                            Previously Played · {playHistory.length}
                                                        </p>
                                                        <ChevronRight
                                                            className={cn(
                                                                "h-3 w-3 text-white/30 transition-transform duration-200",
                                                                !historyCollapsed && "rotate-90"
                                                            )}
                                                        />
                                                    </button>
                                                    <AnimatePresence mode="popLayout" initial={false}>
                                                        {(historyCollapsed
                                                            ? [playHistory[0]]
                                                            : playHistory.slice(0, 20).toReversed()
                                                        ).map((track, idx) => (
                                                            <motion.div
                                                                key={`history-${track.id}`}
                                                                layout
                                                                initial={{ opacity: 0, y: 12 }}
                                                                animate={{ opacity: 0.6, y: 0 }}
                                                                exit={{ opacity: 0, y: -20, scale: 0.95, transition: { duration: 0.25 } }}
                                                                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                                                            >
                                                                <TrackContextMenu track={track} onMutate={() => { }}>
                                                                    <div
                                                                        className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group cursor-pointer hover:!opacity-100"
                                                                        onClick={() => player.play(track)}
                                                                    >
                                                                        <span className="text-xs text-white/20 w-5 text-center tabular-nums">
                                                                            {historyCollapsed ? 1 : playHistory.slice(0, 20).length - idx}
                                                                        </span>
                                                                        <div className="min-w-0 flex-1">
                                                                            <p className="text-sm truncate">{track.title || track.filename}</p>
                                                                            <p className="text-xs text-white/40 truncate">
                                                                                {track.artist || "Unknown"}
                                                                            </p>
                                                                        </div>
                                                                        {track.isFavorite && (
                                                                            <Heart className="h-3 w-3 fill-rose-500 text-rose-500 shrink-0" />
                                                                        )}
                                                                        <span className="text-xs text-white/30 tabular-nums shrink-0">
                                                                            {formatDuration(track.duration)}
                                                                        </span>
                                                                    </div>
                                                                </TrackContextMenu>
                                                            </motion.div>
                                                        ))}
                                                    </AnimatePresence>
                                                </>
                                            )}

                                            {/* Now Playing */}
                                            <div className="px-3 py-2">
                                                <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
                                                    Now Playing
                                                </p>
                                            </div>
                                            {currentTrack ? (
                                                <AnimatePresence mode="wait" initial={false}>
                                                    <motion.div
                                                        key={`now-${currentTrack.id}`}
                                                        initial={{ opacity: 0, y: 20, scale: 0.97 }}
                                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                                        exit={{ opacity: 0, y: -16, scale: 0.97 }}
                                                        transition={{ duration: 0.35, ease: [0.34, 1.56, 0.64, 1] }}
                                                    >
                                                        <TrackContextMenu track={currentTrack} onMutate={() => { }}>
                                                            <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20">
                                                                {/* Waveform indicator */}
                                                                <div className="flex items-end gap-0.5 h-4 w-4 shrink-0">
                                                                    {[0, 1, 2].map((i) => (
                                                                        <div
                                                                            key={i}
                                                                            className={cn(
                                                                                "w-1 bg-purple-400 rounded-full",
                                                                                isPlaying && "animate-[waveform_0.8s_ease-in-out_infinite]"
                                                                            )}
                                                                            style={{
                                                                                height: isPlaying ? undefined : "4px",
                                                                                animationDelay: `${i * 0.15}s`,
                                                                            }}
                                                                        />
                                                                    ))}
                                                                </div>
                                                                <div className="min-w-0 flex-1">
                                                                    <p className="text-sm font-medium truncate text-purple-300">
                                                                        {currentTrack.title || currentTrack.filename}
                                                                    </p>
                                                                    <p className="text-xs text-white/40 truncate">
                                                                        {currentTrack.artist || "Unknown"}
                                                                    </p>
                                                                </div>
                                                                {currentTrack.isFavorite && (
                                                                    <Heart className="h-3 w-3 fill-rose-500 text-rose-500 shrink-0" />
                                                                )}
                                                                <span className="text-xs text-white/30 tabular-nums shrink-0">
                                                                    {formatDuration(currentTrack.duration)}
                                                                </span>
                                                            </div>
                                                        </TrackContextMenu>
                                                    </motion.div>
                                                </AnimatePresence>
                                            ) : (
                                                <div className="flex items-center gap-3 px-3 py-3 rounded-lg bg-white/[0.03] border border-white/[0.06] mx-1">
                                                    <Disc3 className="h-4 w-4 text-white/15 shrink-0" />
                                                    <p className="text-xs text-white/25">No track loaded</p>
                                                </div>
                                            )}

                                            {/* Up Next */}
                                            {upNext.length > 0 && (
                                                <>
                                                    <div className="flex items-center justify-between px-3 py-2 mt-3">
                                                        <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
                                                            Up Next · {upNext.length} tracks
                                                        </p>
                                                        <button
                                                            onClick={player.clearQueue}
                                                            className="text-[10px] text-white/30 hover:text-white/60 transition-colors cursor-pointer"
                                                        >
                                                            Clear
                                                        </button>
                                                    </div>
                                                    <AnimatePresence mode="popLayout" initial={false}>
                                                        <motion.div
                                                            key="sortable-up-next"
                                                            initial={{ opacity: 0 }}
                                                            animate={{ opacity: 1 }}
                                                            exit={{ opacity: 0 }}
                                                        >
                                                            <SortableUpNext items={upNext.slice(0, 50)} startIndex={queueIndex + 1} />
                                                        </motion.div>
                                                    </AnimatePresence>
                                                </>
                                            )}

                                            {upNext.length === 0 && playHistory.length === 0 && (
                                                <div className="flex flex-col items-center justify-center py-12 text-white/30">
                                                    <ListMusic className="h-8 w-8 mb-3" />
                                                    <p className="text-sm">Queue is empty</p>
                                                    <p className="text-xs mt-1">Play tracks from the library to build a queue</p>
                                                </div>
                                            )}
                                        </div>
                                    ) : activeTab === "recommended" ? (
                                        <div className="p-2">
                                            {recommendations.length > 0 ? (
                                                <>
                                                    <div className="px-3 py-2">
                                                        <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
                                                            Based on · {currentTrack?.title || currentTrack?.filename || "current track"}
                                                        </p>
                                                    </div>
                                                    <div className="space-y-0.5">
                                                        <TooltipProvider delayDuration={300}>
                                                            {recommendations.map((rec) => (
                                                                <Tooltip key={rec.id}>
                                                                    <TooltipTrigger asChild>
                                                                        <TrackContextMenu track={{ id: rec.id, title: rec.title, artist: rec.artist, bpm: rec.bpm, keyCamelot: rec.keyCamelot, genre: rec.genre, duration: rec.duration } as Track} onMutate={() => { }}>
                                                                            <div
                                                                                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group"
                                                                            >
                                                                                <Music className="h-3.5 w-3.5 text-white/20 shrink-0" />
                                                                                <div className="min-w-0 flex-1">
                                                                                    <p className="text-sm truncate">{rec.title || "Unknown"}</p>
                                                                                    <p className="text-xs text-white/40 truncate">
                                                                                        {rec.artist || "Unknown"}
                                                                                    </p>
                                                                                    <p className="text-[10px] text-purple-400/70 leading-relaxed mt-0.5">
                                                                                        {rec.reason}
                                                                                        {rec.bpm ? ` · ${Math.round(rec.bpm)} BPM` : ""}
                                                                                        {rec.keyCamelot ? ` · ${formatKey(rec.keyCamelot, noteNotations)}` : ""}
                                                                                    </p>
                                                                                </div>
                                                                                <span className="text-xs text-white/30 tabular-nums shrink-0">
                                                                                    {formatDuration(rec.duration)}
                                                                                </span>
                                                                                <button
                                                                                    onClick={() => handlePlayRecommendation(rec)}
                                                                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all cursor-pointer"
                                                                                    title="Play now"
                                                                                >
                                                                                    <Play className="h-3.5 w-3.5 text-white/50 fill-white/50" />
                                                                                </button>
                                                                                <button
                                                                                    onClick={() => handleAddRecommendation(rec)}
                                                                                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all cursor-pointer"
                                                                                    title="Add to queue"
                                                                                >
                                                                                    <Plus className="h-3.5 w-3.5 text-white/50" />
                                                                                </button>
                                                                            </div>
                                                                        </TrackContextMenu>
                                                                    </TooltipTrigger>
                                                                    <TooltipContent
                                                                        side="left"
                                                                        sideOffset={8}
                                                                        className="max-w-xs bg-zinc-900 border border-white/10 text-white p-3 rounded-xl shadow-xl"
                                                                    >
                                                                        <p className="font-semibold text-sm">{rec.title || "Unknown"}</p>
                                                                        <p className="text-xs text-white/50 mt-0.5">{rec.artist || "Unknown"}</p>
                                                                        <div className="flex flex-wrap gap-1.5 mt-2">
                                                                            {rec.bpm && (
                                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                                                                                    {Math.round(rec.bpm)} BPM
                                                                                </span>
                                                                            )}
                                                                            {rec.keyCamelot && (
                                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                                                                                    {formatKey(rec.keyCamelot, noteNotations)}
                                                                                </span>
                                                                            )}
                                                                            {rec.genre && (
                                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                                                                                    {rec.genre}
                                                                                </span>
                                                                            )}
                                                                            {rec.duration != null && (
                                                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60">
                                                                                    {formatDuration(rec.duration)}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                        <p className="text-[11px] text-purple-300/90 leading-relaxed mt-2">
                                                                            {rec.reason}
                                                                        </p>
                                                                    </TooltipContent>
                                                                </Tooltip>
                                                            ))}
                                                        </TooltipProvider>
                                                    </div>
                                                </>
                                            ) : (
                                                <div className="flex flex-col items-center justify-center py-12 text-white/30">
                                                    <Sparkles className="h-8 w-8 mb-3" />
                                                    <p className="text-sm">No recommendations yet</p>
                                                    <p className="text-xs mt-1">
                                                        Play a track with BPM/key metadata for suggestions
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        /* Lyrics Tab */
                                        <div className="p-6 flex flex-col items-center justify-center h-full">
                                            {currentTrack?.lyrics || currentTrack?.comment ? (
                                                <div className="text-center space-y-4 max-w-sm">
                                                    <p className="text-sm text-white/70 whitespace-pre-line leading-relaxed">
                                                        {currentTrack?.lyrics || currentTrack?.comment}
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="text-center text-white/30">
                                                    <Mic2 className="h-12 w-12 mx-auto mb-4 opacity-40" />
                                                    <p className="text-sm font-medium">No lyrics available</p>
                                                    <p className="text-xs mt-1">
                                                        Use Reanalyze Library to fetch lyrics automatically
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

            </div>
        </div>
    );
}

/* ─── Viz Browser Side Panel ──────────────────────────────────────────── */

// ─── EQ Tab Button (uses EQ context for dot indicator) ───────────────────

function EQTabButton({ leftView, onClick }: { leftView: LeftView; onClick: () => void }) {
    const eq = useEQ();
    return (
        <button
            onClick={onClick}
            className={cn(
                "relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                leftView === "equalizer"
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/70"
            )}
        >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            EQ
            {eq.enabled && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.5)]" />
            )}
        </button>
    );
}

function VizBrowserPanel({
    allViz,
    categories,
    selectedCategory,
    searchQuery,
    currentVizId,
    favorites,
    onSelectCategory,
    onSearch,
    onSelect,
    onClose,
}: {
    allViz: VisualizationDef[];
    categories: string[];
    selectedCategory: string | null;
    searchQuery: string;
    currentVizId?: string;
    favorites: string[];
    onSelectCategory: (cat: string | null) => void;
    onSearch: (q: string) => void;
    onSelect: (viz: VisualizationDef) => void;
    onClose: () => void;
}) {
    return (
        <div className="absolute top-0 right-0 bottom-0 w-80 z-20 bg-black/90 backdrop-blur-xl border-l border-white/10 flex flex-col animate-[slideInRight_200ms_ease-out]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                <h3 className="text-sm font-semibold text-white">Visualizations</h3>
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            {/* Search */}
            <div className="px-3 py-2">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/30" />
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchQuery}
                        onChange={e => onSearch(e.target.value)}
                        className="w-full pl-8 pr-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-purple-500/50"
                    />
                </div>
            </div>

            {/* Category pills */}
            <div className="px-3 pb-2 flex flex-wrap gap-1">
                <button
                    onClick={() => { onSelectCategory(null); onSearch(""); }}
                    className={cn(
                        "px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer",
                        !selectedCategory && !searchQuery
                            ? "bg-purple-500/20 text-purple-300"
                            : "bg-white/5 text-white/40 hover:text-white/70"
                    )}
                >
                    All
                </button>
                {categories.map(cat => (
                    <button
                        key={cat}
                        onClick={() => { onSelectCategory(cat); onSearch(""); }}
                        className={cn(
                            "px-2 py-1 rounded text-[10px] font-medium transition-colors cursor-pointer",
                            selectedCategory === cat
                                ? "bg-purple-500/20 text-purple-300"
                                : "bg-white/5 text-white/40 hover:text-white/70"
                        )}
                    >
                        {cat}
                    </button>
                ))}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-2">
                <div className="space-y-0.5 pb-2">
                    {allViz.map(viz => (
                        <button
                            key={viz.id}
                            onClick={() => onSelect(viz)}
                            className={cn(
                                "w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors cursor-pointer",
                                viz.id === currentVizId
                                    ? "bg-purple-500/15 border border-purple-500/30"
                                    : "hover:bg-white/5 border border-transparent"
                            )}
                        >
                            <div className="min-w-0 flex-1">
                                <p className={cn(
                                    "text-xs font-medium truncate",
                                    viz.id === currentVizId ? "text-purple-300" : "text-white/80"
                                )}>
                                    {viz.name}
                                </p>
                                <p className="text-[10px] text-white/30 truncate">{viz.category}</p>
                            </div>
                            {favorites.includes(viz.id) && (
                                <Heart className="h-3 w-3 fill-rose-400 text-rose-400 shrink-0" />
                            )}
                            {viz.interactive && (
                                <span className="text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 shrink-0">
                                    ✦
                                </span>
                            )}
                            {viz.id === currentVizId && (
                                <div className="flex items-end gap-0.5 h-3 shrink-0">
                                    {[0, 1, 2].map(i => (
                                        <div
                                            key={i}
                                            className="w-0.5 bg-purple-400 rounded-full animate-[waveform_0.8s_ease-in-out_infinite]"
                                            style={{ animationDelay: `${i * 0.15}s` }}
                                        />
                                    ))}
                                </div>
                            )}
                        </button>
                    ))}
                    {allViz.length === 0 && (
                        <div className="py-8 text-center text-white/30 text-xs">
                            No visualizations match your search
                        </div>
                    )}
                </div>
            </div>

            {/* Count */}
            <div className="px-4 py-2 border-t border-white/10 text-[10px] text-white/30">
                {allViz.length} visualizations
            </div>
        </div>
    );
}

/* ─── Compact Media Bar for Visualization View ──────────────────────── */

function VizMediaBar({
    track,
    isPlaying,
    currentTime,
    duration,
    volume,
    onTogglePlay,
    onNext,
    onPrev,
    onSeek,
    onSetVolume,
}: {
    track: Track | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    onTogglePlay: () => void;
    onNext: () => void;
    onPrev: () => void;
    onSeek: (t: number) => void;
    onSetVolume: (v: number) => void;
}) {
    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

    return (
        <div className="absolute bottom-12 left-4 right-4 z-15 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-black/60 backdrop-blur-lg border border-white/10">
            {/* Track info */}
            <div className="flex items-center gap-2.5 min-w-0 w-40 shrink-0">
                <div className="relative h-8 w-8 rounded-md bg-white/10 flex items-center justify-center shrink-0 overflow-hidden">
                    {track?.artworkUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data/remote artwork; next/image cannot optimise unknown remotes
                        <img src={track.artworkUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <Disc3 className={cn("h-4 w-4 text-purple-400", isPlaying && "animate-[vinylSpin_3s_linear_infinite]")} />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-white truncate">{track?.title || track?.filename || "No Track"}</p>
                    <p className="text-[10px] text-white/40 truncate">{track?.artist || "Unknown"}</p>
                </div>
            </div>

            {/* Controls + progress */}
            <div className="flex flex-col items-center flex-1 gap-1">
                <div className="flex items-center gap-2">
                    <button onClick={onPrev} className="text-white/50 hover:text-white transition-colors cursor-pointer">
                        <SkipBack className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={onTogglePlay}
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-black hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                    >
                        {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
                    </button>
                    <button onClick={onNext} className="text-white/50 hover:text-white transition-colors cursor-pointer">
                        <SkipForward className="h-3.5 w-3.5" />
                    </button>
                </div>
                <div className="flex items-center gap-2 w-full">
                    <span className="text-[9px] text-white/40 w-8 text-right tabular-nums">{formatDuration(Math.floor(currentTime))}</span>
                    <div
                        className="relative flex-1 h-1 rounded-full bg-white/10 cursor-pointer group"
                        onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const pct = (e.clientX - rect.left) / rect.width;
                            onSeek(pct * duration);
                        }}
                    >
                        <div className="absolute h-full rounded-full bg-white/70 group-hover:bg-purple-400 transition-colors" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="text-[9px] text-white/40 w-8 tabular-nums">{formatDuration(Math.floor(duration))}</span>
                </div>
            </div>

            {/* Volume */}
            <div className="flex items-center gap-1.5 w-24 shrink-0">
                <button
                    onClick={() => onSetVolume(volume > 0 ? 0 : 0.8)}
                    className="text-white/40 hover:text-white transition-colors cursor-pointer"
                >
                    {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                </button>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={(e) => onSetVolume(parseFloat(e.target.value))}
                    className="w-full h-0.5 accent-white cursor-pointer"
                />
            </div>
        </div>
    );
}
