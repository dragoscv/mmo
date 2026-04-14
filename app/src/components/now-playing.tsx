"use client";

import { useState, useEffect, useTransition, useCallback, useRef, useMemo } from "react";
import { usePlayer } from "./player-context";
import { Artwork } from "./artwork";
import { FavoriteButton } from "./favorite-button";
import { VisualizationCanvas } from "./visualization-canvas";
import { VisualizationControls } from "./visualization-controls";
import { formatDuration, GENRE_COLORS, cn } from "@/lib/utils";
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
    Image,
    AudioWaveform,
    Search,
    Grid3X3,
    ChevronRight,
} from "lucide-react";
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
type LeftView = "artwork" | "visualization";

export function NowPlaying() {
    const player = usePlayer();
    const [activeTab, setActiveTab] = useState<TabType>("queue");
    const [leftView, setLeftView] = useState<LeftView>("artwork");
    const [recommendations, setRecommendations] = useState<RecommendedTrack[]>([]);
    const [isClosing, setIsClosing] = useState(false);
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
    const vizContainerRef = useRef<HTMLDivElement>(null);

    const currentViz = allViz[currentVizIdx] || allViz[0];
    const isVizFavorite = vizSettings.favorites.includes(currentViz?.id || "");

    const nextViz = useCallback(() => {
        setCurrentVizIdx(i => (i + 1) % allViz.length);
    }, [allViz.length]);

    const prevViz = useCallback(() => {
        setCurrentVizIdx(i => (i - 1 + allViz.length) % allViz.length);
    }, [allViz.length]);

    const randomViz = useCallback(() => {
        const rand = getRandomVisualization(currentViz?.id);
        const idx = allViz.findIndex(v => v.id === rand.id);
        if (idx >= 0) setCurrentVizIdx(idx);
    }, [allViz, currentViz?.id]);

    const toggleVizFavorite = useCallback(() => {
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
    }, [currentViz?.id]);

    const toggleVizStats = useCallback(() => {
        setVizSettings(prev => {
            const next = { ...prev, showStats: !prev.showStats };
            saveVizSettings(next);
            return next;
        });
    }, []);

    const toggleTheater = useCallback(() => {
        setIsTheater(prev => !prev);
    }, []);

    const toggleFullscreen = useCallback(async () => {
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
    }, []);

    // Listen for fullscreen changes (e.g. user presses Escape)
    useEffect(() => {
        const handler = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener("fullscreenchange", handler);
        return () => document.removeEventListener("fullscreenchange", handler);
    }, []);

    // Browsable visualizations for the side panel
    const browsedViz = useMemo(() => {
        if (vizSearchQuery) return searchVisualizations(vizSearchQuery);
        if (vizBrowseCategory) return getVisualizationsByCategory(vizBrowseCategory);
        return allViz;
    }, [vizSearchQuery, vizBrowseCategory, allViz]);

    const selectViz = useCallback((viz: VisualizationDef) => {
        const idx = allViz.findIndex(v => v.id === viz.id);
        if (idx >= 0) setCurrentVizIdx(idx);
    }, [allViz]);

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

    if (!currentTrack || !player.isNowPlayingOpen) return null;

    const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
    const gradient = getGenreGradient(currentTrack.genre);
    const upNext = queue.slice(queueIndex + 1);

    function handleClose() {
        setIsClosing(true);
        setTimeout(() => {
            player.closeNowPlaying();
            setIsClosing(false);
        }, 280);
    }

    function handleAddRecommendation(rec: RecommendedTrack) {
        // Create a minimal Track object for queue
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

    return (
        <div
            className={cn(
                "fixed inset-0 z-[60] flex flex-col",
                isClosing
                    ? "animate-[slideDown_300ms_ease-in_forwards]"
                    : "animate-[slideUp_300ms_cubic-bezier(0.16,1,0.3,1)_forwards]"
            )}
        >
            {/* Background - gradient based on genre */}
            <div className={cn("absolute inset-0 bg-gradient-to-b to-[#0a0a0a]", gradient)} />
            <div className="absolute inset-0 bg-black/40 backdrop-blur-xl" />

            {/* Content */}
            <div className="relative flex flex-col h-full">
                {/* Top Bar */}
                <div className="flex items-center justify-between px-6 py-4">
                    <button
                        onClick={handleClose}
                        className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                    >
                        <ChevronDown className="h-5 w-5" />
                        <span>Now Playing</span>
                    </button>
                    <div className="flex items-center gap-2">
                        <button className="p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer">
                            <MoreHorizontal className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex gap-6 px-6 pb-4 overflow-hidden">
                    {/* Left Side - Artwork/Visualization + Controls */}
                    <div className="flex-1 flex flex-col items-center justify-center max-w-lg mx-auto">
                        {/* View Switcher */}
                        <div className="flex items-center gap-1 mb-4 bg-white/5 rounded-lg p-1 animate-[fadeIn_400ms_100ms_both]">
                            <button
                                onClick={() => setLeftView("artwork")}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                    leftView === "artwork"
                                        ? "bg-white/10 text-white"
                                        : "text-white/40 hover:text-white/70"
                                )}
                            >
                                <Image className="h-3.5 w-3.5" />
                                Artwork
                            </button>
                            <button
                                onClick={() => setLeftView("visualization")}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer",
                                    leftView === "visualization"
                                        ? "bg-white/10 text-white"
                                        : "text-white/40 hover:text-white/70"
                                )}
                            >
                                <AudioWaveform className="h-3.5 w-3.5" />
                                Visualizer
                            </button>
                        </div>

                        {leftView === "artwork" ? (
                            <>
                                {/* Artwork */}
                                <div className="relative mb-8 animate-[scaleIn_400ms_cubic-bezier(0.16,1,0.3,1)]">
                                    {currentTrack.artworkUrl ? (
                                        <div className="relative animate-[pulseGlow_3s_ease-in-out_infinite] rounded-2xl">
                                            <img
                                                src={currentTrack.artworkUrl}
                                                alt={currentTrack.title || "Artwork"}
                                                className="w-72 h-72 rounded-2xl object-cover shadow-2xl"
                                            />
                                        </div>
                                    ) : (
                                        <div className="w-72 h-72 rounded-2xl bg-gradient-to-br from-purple-500/30 to-blue-500/30 flex items-center justify-center shadow-2xl animate-[pulseGlow_3s_ease-in-out_infinite]">
                                            <Disc3
                                                className={cn(
                                                    "h-24 w-24 text-white/20",
                                                    isPlaying && "animate-[vinylSpin_3s_linear_infinite]"
                                                )}
                                            />
                                        </div>
                                    )}
                                </div>

                                {/* Track Info */}
                                <div className="text-center mb-6 w-full animate-[fadeIn_400ms_200ms_both]">
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
                                                {currentTrack.keyCamelot}
                                                {currentTrack.keyMusical ? ` · ${currentTrack.keyMusical}` : ""}
                                            </span>
                                        )}
                                        {currentTrack.genre && (
                                            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                                                {currentTrack.genre}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {/* Progress Bar */}
                                <div className="w-full mb-4 animate-[fadeIn_400ms_300ms_both]">
                                    <div
                                        className="relative w-full h-1.5 rounded-full bg-white/10 cursor-pointer group"
                                        onClick={(e) => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            const pct = (e.clientX - rect.left) / rect.width;
                                            player.seek(pct * duration);
                                        }}
                                    >
                                        <div
                                            className="absolute h-full rounded-full bg-white group-hover:bg-purple-400 transition-colors"
                                            style={{ width: `${progress}%` }}
                                        />
                                        <div
                                            className="absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full bg-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                                            style={{ left: `${progress}%`, marginLeft: "-8px" }}
                                        />
                                    </div>
                                    <div className="flex justify-between mt-1.5">
                                        <span className="text-xs text-white/50 tabular-nums">
                                            {formatDuration(Math.floor(currentTime))}
                                        </span>
                                        <span className="text-xs text-white/50 tabular-nums">
                                            {formatDuration(Math.floor(duration))}
                                        </span>
                                    </div>
                                </div>

                                {/* Controls */}
                                <div className="flex items-center justify-center gap-6 mb-4 animate-[fadeIn_400ms_400ms_both]">
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
                                <div className="flex items-center justify-center gap-4 animate-[fadeIn_400ms_500ms_both]">
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
                                </div>                            </>
                        ) : (
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
                    </div>

                    {/* Right Side - Queue / Recommended / Lyrics */}
                    {!isTheater && (
                        <div className="w-96 shrink-0 flex flex-col bg-black/30 rounded-2xl border border-white/5 overflow-hidden animate-[fadeIn_400ms_300ms_both]">
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
                            <div className="flex-1 overflow-y-auto">
                                {activeTab === "queue" ? (
                                    <div className="p-2">
                                        {/* Previously Played */}
                                        {playHistory.length > 0 && (
                                            <>
                                                <div className="flex items-center justify-between px-3 py-2">
                                                    <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold flex items-center gap-1.5">
                                                        <History className="h-3 w-3" />
                                                        Previously Played · {playHistory.length}
                                                    </p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    {playHistory.slice(0, 20).map((track, idx) => (
                                                        <div
                                                            key={`history-${track.id}-${idx}`}
                                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group cursor-pointer opacity-60 hover:opacity-100"
                                                            onClick={() => player.play(track)}
                                                        >
                                                            <span className="text-xs text-white/20 w-5 text-center tabular-nums">
                                                                {idx + 1}
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
                                                    ))}
                                                </div>
                                            </>
                                        )}

                                        {/* Now Playing */}
                                        <div className="px-3 py-2">
                                            <p className="text-[10px] uppercase tracking-wider text-white/40 font-semibold">
                                                Now Playing
                                            </p>
                                        </div>
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
                                                <div className="space-y-0.5">
                                                    {upNext.slice(0, 50).map((track, idx) => (
                                                        <div
                                                            key={`${track.id}-${idx}`}
                                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group cursor-pointer"
                                                            onClick={() => player.playFromQueue(queueIndex + 1 + idx)}
                                                        >
                                                            <span className="text-xs text-white/30 w-5 text-center tabular-nums">
                                                                {idx + 1}
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
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    player.removeFromQueue(queueIndex + 1 + idx);
                                                                }}
                                                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all cursor-pointer"
                                                            >
                                                                <X className="h-3 w-3 text-white/50" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
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
                                                        Based on · {currentTrack.title || currentTrack.filename}
                                                    </p>
                                                </div>
                                                <div className="space-y-0.5">
                                                    {recommendations.map((rec) => (
                                                        <div
                                                            key={rec.id}
                                                            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/5 transition-colors group"
                                                        >
                                                            <Music className="h-3.5 w-3.5 text-white/20 shrink-0" />
                                                            <div className="min-w-0 flex-1">
                                                                <p className="text-sm truncate">{rec.title || "Unknown"}</p>
                                                                <p className="text-xs text-white/40 truncate">
                                                                    {rec.artist || "Unknown"}
                                                                </p>
                                                                <p className="text-[10px] text-purple-400/70 truncate mt-0.5">
                                                                    {rec.reason}
                                                                    {rec.bpm ? ` · ${Math.round(rec.bpm)} BPM` : ""}
                                                                    {rec.keyCamelot ? ` · ${rec.keyCamelot}` : ""}
                                                                </p>
                                                            </div>
                                                            <span className="text-xs text-white/30 tabular-nums shrink-0">
                                                                {formatDuration(rec.duration)}
                                                            </span>
                                                            <button
                                                                onClick={() => handleAddRecommendation(rec)}
                                                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-white/10 rounded transition-all cursor-pointer"
                                                                title="Add to queue"
                                                            >
                                                                <Plus className="h-3.5 w-3.5 text-white/50" />
                                                            </button>
                                                        </div>
                                                    ))}
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
                                        {currentTrack.lyrics || currentTrack.comment ? (
                                            <div className="text-center space-y-4 max-w-sm">
                                                <p className="text-sm text-white/70 whitespace-pre-line leading-relaxed">
                                                    {currentTrack.lyrics || currentTrack.comment}
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
                    )}
                </div>
            </div>
        </div>
    );
}

/* ─── Viz Browser Side Panel ──────────────────────────────────────────── */

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
    track: Track;
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
                    {track.artworkUrl ? (
                        <img src={track.artworkUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                        <Disc3 className={cn("h-4 w-4 text-purple-400", isPlaying && "animate-[vinylSpin_3s_linear_infinite]")} />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-white truncate">{track.title || track.filename}</p>
                    <p className="text-[10px] text-white/40 truncate">{track.artist || "Unknown"}</p>
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
