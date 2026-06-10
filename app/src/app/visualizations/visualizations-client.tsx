"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { usePlayer } from "@/components/player-context";
import { VisualizationCanvas } from "@/components/visualization-canvas";
import { VisualizationControls } from "@/components/visualization-controls";
import { cn } from "@/lib/utils";
import { useRenderCount } from "@/lib/dev-debugger";
import { useProjectAutosave } from "@/hooks/use-project-autosave";
import {
    getAllVisualizations,
    getCategories,
    getVisualizationsByCategory,
    searchVisualizations,
    getRandomVisualization,
    getVisualizationCount,
    loadVizSettings,
    saveVizSettings,
    type VizSettings,
    type VizPlaylist,
} from "@/lib/visualizations/registry";
import type { VisualizationDef } from "@/lib/visualizations/types";
import { PALETTE_NAMES, PALETTES } from "@/lib/visualizations/palettes";
import {
    Search,
    Heart,
    Grid3X3,
    Layers,
    Play,
    Plus,
    X,
    Settings,
    Monitor,
    ChevronLeft,
    Shuffle,
    SkipBack,
    SkipForward,
    Trash2,
    PenLine,
    ListMusic,
    BarChart3,
    Maximize,
    Minimize,
    Zap,
    ArrowLeft,
    PanelLeftClose,
    PanelLeft,
} from "lucide-react";

type ViewMode = "browse" | "preview";
type SidebarTab = "categories" | "favorites" | "playlists";

export function VisualizationsClient() {
    useRenderCount("Page:/visualizations");
    const player = usePlayer();
    const allViz = useMemo(() => getAllVisualizations(), []);
    const categories = useMemo(() => getCategories(), []);

    const [settings, setSettings] = useState<VizSettings>(() => loadVizSettings());
    const [viewMode, setViewMode] = useState<ViewMode>("browse");
    const [selectedViz, setSelectedViz] = useState<VisualizationDef | null>(null);
    const [sidebarTab, setSidebarTab] = useState<SidebarTab>("categories");
    const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [showSettings, setShowSettings] = useState(false);
    const [vizFps, setVizFps] = useState(0);
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Playlist management
    const [editingPlaylist, setEditingPlaylist] = useState<string | null>(null);
    const [newPlaylistName, setNewPlaylistName] = useState("");
    const [mobileSidebar, setMobileSidebar] = useState(false);

    const updateSettings = useCallback((patch: Partial<VizSettings>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveVizSettings(next);
            return next;
        });
    }, []);

    // Filtered visualizations
    const displayedViz = useMemo(() => {
        if (searchQuery) return searchVisualizations(searchQuery);
        if (sidebarTab === "favorites") {
            return allViz.filter(v => settings.favorites.includes(v.id));
        }
        if (sidebarTab === "playlists" && editingPlaylist) {
            const pl = settings.playlists.find(p => p.id === editingPlaylist);
            if (pl) return allViz.filter(v => pl.vizIds.includes(v.id));
        }
        if (selectedCategory) return getVisualizationsByCategory(selectedCategory);
        return allViz;
    }, [searchQuery, sidebarTab, selectedCategory, settings.favorites, settings.playlists, editingPlaylist, allViz]);

    const toggleFavorite = useCallback((vizId: string) => {
        setSettings(prev => {
            const favs = prev.favorites.includes(vizId)
                ? prev.favorites.filter(f => f !== vizId)
                : [...prev.favorites, vizId];
            const next = { ...prev, favorites: favs };
            saveVizSettings(next);
            return next;
        });
    }, []);

    const createPlaylist = useCallback(() => {
        const name = newPlaylistName.trim() || `Playlist ${settings.playlists.length + 1}`;
        const pl: VizPlaylist = { id: `pl-${Date.now()}`, name, vizIds: [] };
        updateSettings({ playlists: [...settings.playlists, pl] });
        setNewPlaylistName("");
    }, [newPlaylistName, settings.playlists, updateSettings]);

    const deletePlaylist = useCallback((plId: string) => {
        updateSettings({ playlists: settings.playlists.filter(p => p.id !== plId) });
        if (editingPlaylist === plId) setEditingPlaylist(null);
    }, [settings.playlists, editingPlaylist, updateSettings]);

    const addToPlaylist = useCallback((plId: string, vizId: string) => {
        updateSettings({
            playlists: settings.playlists.map(p =>
                p.id === plId && !p.vizIds.includes(vizId)
                    ? { ...p, vizIds: [...p.vizIds, vizId] }
                    : p
            ),
        });
    }, [settings.playlists, updateSettings]);

    const removeFromPlaylist = useCallback((plId: string, vizId: string) => {
        updateSettings({
            playlists: settings.playlists.map(p =>
                p.id === plId
                    ? { ...p, vizIds: p.vizIds.filter(id => id !== vizId) }
                    : p
            ),
        });
    }, [settings.playlists, updateSettings]);

    const openPreview = useCallback((viz: VisualizationDef) => {
        setSelectedViz(viz);
        setViewMode("preview");
    }, []);

    // Navigation in preview
    const currentIdx = selectedViz ? displayedViz.findIndex(v => v.id === selectedViz.id) : -1;
    const previewNext = useCallback(() => {
        if (displayedViz.length === 0) return;
        const next = (currentIdx + 1) % displayedViz.length;
        setSelectedViz(displayedViz[next]);
    }, [currentIdx, displayedViz]);
    const previewPrev = useCallback(() => {
        if (displayedViz.length === 0) return;
        const prev = (currentIdx - 1 + displayedViz.length) % displayedViz.length;
        setSelectedViz(displayedViz[prev]);
    }, [currentIdx, displayedViz]);
    const previewRandom = useCallback(() => {
        const rand = getRandomVisualization(selectedViz?.id);
        setSelectedViz(rand);
    }, [selectedViz?.id]);

    const toggleFullscreen = useCallback(async () => {
        if (!document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
            setIsFullscreen(true);
        } else {
            await document.exitFullscreen();
            setIsFullscreen(false);
        }
    }, []);

    // Preview Mode
    if (viewMode === "preview" && selectedViz) {
        return (
            <div className="h-dvh w-full bg-black relative">
                <VisualizationCanvas
                    visualization={selectedViz}
                    sensitivity={settings.sensitivity}
                    quality={settings.quality}
                    showStats={settings.showStats}
                    onFpsUpdate={setVizFps}
                />
                <VisualizationControls
                    current={selectedViz}
                    isFavorite={settings.favorites.includes(selectedViz.id)}
                    showStats={settings.showStats}
                    isTheater={false}
                    isFullscreen={isFullscreen}
                    onPrev={previewPrev}
                    onNext={previewNext}
                    onRandom={previewRandom}
                    onToggleFavorite={() => toggleFavorite(selectedViz.id)}
                    onToggleStats={() => updateSettings({ showStats: !settings.showStats })}
                    onToggleTheater={() => { }}
                    onToggleFullscreen={toggleFullscreen}
                    onOpenBrowser={() => setViewMode("browse")}
                    fps={vizFps}
                />
                {/* Back button */}
                <button
                    onClick={() => setViewMode("browse")}
                    className="absolute top-3 left-3 z-20 flex items-center gap-2 px-3 py-2 bg-black/50 hover:bg-black/70 rounded-lg text-white/70 hover:text-white text-sm transition-all cursor-pointer"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Browse
                </button>
            </div>
        );
    }

    // Stable preset id for cloud persistence (favorites + playlists).
    const [presetId, setPresetId] = useState<string | null>(null);
    useEffect(() => {
        try {
            const KEY = "mmo:viz:preset-id";
            let id = localStorage.getItem(KEY);
            if (!id) {
                id = (crypto.randomUUID?.() ?? `viz-${Date.now()}`);
                localStorage.setItem(KEY, id);
            }
            setPresetId(id);
        } catch { /* ignore */ }
    }, []);
    useProjectAutosave({
        kind: "visualization",
        externalId: presetId,
        name: "Visualization Preset",
        document: settings as unknown as Record<string, unknown>,
        enabled: Boolean(presetId),
    });

    // Browse Mode
    return (
        <div className="h-full flex bg-[var(--background)] text-[var(--foreground)]">
            {/* Mobile sidebar overlay */}
            {mobileSidebar && (
                <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileSidebar(false)} />
            )}
            {/* Sidebar */}
            <div className={cn(
                "w-64 shrink-0 border-r border-[var(--border)] flex flex-col bg-[var(--card)]",
                "fixed inset-y-0 left-0 z-50 md:relative md:z-auto",
                "transition-transform duration-200 md:translate-x-0",
                mobileSidebar ? "translate-x-0" : "-translate-x-full"
            )}>
                <div className="p-4 border-b border-[var(--border)]">
                    <h1 className="text-lg font-bold mb-1">Visualizations</h1>
                    <p className="text-xs text-[var(--muted-foreground)]">{getVisualizationCount()} visualizations</p>
                </div>

                {/* Sidebar tabs */}
                <div className="flex border-b border-[var(--border)]">
                    {([
                        { id: "categories" as const, icon: Grid3X3, label: "Browse" },
                        { id: "favorites" as const, icon: Heart, label: "Favorites" },
                        { id: "playlists" as const, icon: ListMusic, label: "Playlists" },
                    ]).map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => {
                                setSidebarTab(tab.id);
                                setSelectedCategory(null);
                                setEditingPlaylist(null);
                            }}
                            className={cn(
                                "flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium transition-colors cursor-pointer",
                                sidebarTab === tab.id
                                    ? "text-[var(--foreground)] border-b-2 border-purple-400"
                                    : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                            )}
                        >
                            <tab.icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="flex-1 overflow-y-auto p-2">
                    {sidebarTab === "categories" && (
                        <div className="space-y-0.5">
                            <button
                                onClick={() => { setSelectedCategory(null); setMobileSidebar(false); }}
                                className={cn(
                                    "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer",
                                    !selectedCategory
                                        ? "bg-purple-500/10 text-purple-300"
                                        : "hover:bg-[var(--accent)] text-[var(--muted-foreground)]"
                                )}
                            >
                                All ({allViz.length})
                            </button>
                            {categories.map(cat => {
                                const count = getVisualizationsByCategory(cat).length;
                                return (
                                    <button
                                        key={cat}
                                        onClick={() => { setSelectedCategory(cat); setMobileSidebar(false); }}
                                        className={cn(
                                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer flex justify-between",
                                            selectedCategory === cat
                                                ? "bg-purple-500/10 text-purple-300"
                                                : "hover:bg-[var(--accent)] text-[var(--muted-foreground)]"
                                        )}
                                    >
                                        <span>{cat}</span>
                                        <span className="text-xs opacity-50">{count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {sidebarTab === "favorites" && (
                        <div className="text-center py-4">
                            <Heart className="h-6 w-6 mx-auto mb-2 text-[var(--muted-foreground)]" />
                            <p className="text-sm text-[var(--muted-foreground)]">
                                {settings.favorites.length} favorites
                            </p>
                        </div>
                    )}

                    {sidebarTab === "playlists" && (
                        <div className="space-y-2">
                            {/* Create playlist */}
                            <div className="flex gap-1">
                                <input
                                    type="text"
                                    placeholder="New playlist..."
                                    value={newPlaylistName}
                                    onChange={e => setNewPlaylistName(e.target.value)}
                                    onKeyDown={e => e.key === "Enter" && createPlaylist()}
                                    className="flex-1 px-3 py-1.5 bg-[var(--input)] rounded-lg text-sm border border-[var(--border)] placeholder:text-[var(--muted-foreground)]"
                                />
                                <button
                                    onClick={createPlaylist}
                                    className="p-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors cursor-pointer"
                                >
                                    <Plus className="h-4 w-4" />
                                </button>
                            </div>
                            {settings.playlists.map(pl => (
                                <div
                                    key={pl.id}
                                    className={cn(
                                        "flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors",
                                        editingPlaylist === pl.id
                                            ? "bg-purple-500/10 text-purple-300"
                                            : "hover:bg-[var(--accent)]"
                                    )}
                                    onClick={() => setEditingPlaylist(pl.id)}
                                >
                                    <div>
                                        <p className="text-sm">{pl.name}</p>
                                        <p className="text-xs text-[var(--muted-foreground)]">{pl.vizIds.length} items</p>
                                    </div>
                                    <button
                                        onClick={e => { e.stopPropagation(); deletePlaylist(pl.id); }}
                                        className="p-1 rounded hover:bg-red-500/10 text-[var(--muted-foreground)] hover:text-red-400 transition-colors cursor-pointer"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            ))}
                            {settings.playlists.length === 0 && (
                                <p className="text-xs text-[var(--muted-foreground)] text-center py-4">
                                    Create a playlist to organize your favorite visualizations
                                </p>
                            )}
                        </div>
                    )}
                </div>

                {/* Settings */}
                <div className="border-t border-[var(--border)] p-3">
                    <button
                        onClick={() => setShowSettings(!showSettings)}
                        className="flex items-center gap-2 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer w-full"
                    >
                        <Settings className="h-4 w-4" />
                        Settings
                    </button>
                    {showSettings && (
                        <div className="mt-3 space-y-3">
                            <div>
                                <label className="text-xs text-[var(--muted-foreground)]">Sensitivity</label>
                                <input
                                    type="range"
                                    min={0.3}
                                    max={2.5}
                                    step={0.1}
                                    value={settings.sensitivity}
                                    onChange={e => updateSettings({ sensitivity: parseFloat(e.target.value) })}
                                    className="w-full h-1 accent-purple-400 cursor-pointer mt-1"
                                />
                                <span className="text-[10px] text-[var(--muted-foreground)]">{settings.sensitivity.toFixed(1)}x</span>
                            </div>
                            <div>
                                <label className="text-xs text-[var(--muted-foreground)]">Quality</label>
                                <div className="flex gap-1 mt-1">
                                    {(["low", "medium", "high"] as const).map(q => (
                                        <button
                                            key={q}
                                            onClick={() => updateSettings({ quality: q })}
                                            className={cn(
                                                "flex-1 py-1 rounded text-xs capitalize transition-colors cursor-pointer",
                                                settings.quality === q
                                                    ? "bg-purple-500/20 text-purple-300"
                                                    : "bg-[var(--accent)] text-[var(--muted-foreground)]"
                                            )}
                                        >
                                            {q}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <label className="flex items-center gap-2 text-xs cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={settings.showStats}
                                    onChange={() => updateSettings({ showStats: !settings.showStats })}
                                    className="accent-purple-400"
                                />
                                <span className="text-[var(--muted-foreground)]">Show performance stats</span>
                            </label>
                        </div>
                    )}
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden">
                {/* Search bar */}
                <div className="p-3 md:p-4 border-b border-[var(--border)] flex items-center gap-3">
                    <button
                        onClick={() => setMobileSidebar(true)}
                        className="md:hidden p-2 rounded-lg hover:bg-[var(--accent)] transition-colors cursor-pointer shrink-0"
                    >
                        <PanelLeft className="h-5 w-5" />
                    </button>
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--muted-foreground)]" />
                        <input
                            type="text"
                            placeholder="Search visualizations..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-3 py-2 bg-[var(--input)] rounded-lg text-sm border border-[var(--border)] placeholder:text-[var(--muted-foreground)]"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery("")}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 hover:bg-[var(--accent)] rounded cursor-pointer"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                    <div className="text-xs text-[var(--muted-foreground)]">
                        {displayedViz.length} {displayedViz.length === 1 ? "result" : "results"}
                    </div>
                </div>

                {/* Grid */}
                <div className="flex-1 overflow-y-auto p-3 md:p-4">
                    <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-2 md:gap-3">
                        {displayedViz.map(viz => (
                            <VizCard
                                key={viz.id}
                                viz={viz}
                                isFavorite={settings.favorites.includes(viz.id)}
                                onPreview={() => openPreview(viz)}
                                onToggleFavorite={() => toggleFavorite(viz.id)}
                                playlists={settings.playlists}
                                onAddToPlaylist={(plId) => addToPlaylist(plId, viz.id)}
                            />
                        ))}
                    </div>
                    {displayedViz.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-20 text-[var(--muted-foreground)]">
                            <Layers className="h-12 w-12 mb-4 opacity-30" />
                            <p className="text-lg font-medium">No visualizations found</p>
                            <p className="text-sm mt-1">Try a different search or category</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function VizCard({
    viz,
    isFavorite,
    onPreview,
    onToggleFavorite,
    playlists,
    onAddToPlaylist,
}: {
    viz: VisualizationDef;
    isFavorite: boolean;
    onPreview: () => void;
    onToggleFavorite: () => void;
    playlists: VizPlaylist[];
    onAddToPlaylist: (plId: string) => void;
}) {
    const [showPlaylistMenu, setShowPlaylistMenu] = useState(false);

    // Extract palette from viz ID for preview swatch
    const palName = viz.id.split("-").pop() || "";

    return (
        <div className="group relative rounded-xl border border-[var(--border)] bg-[var(--card)] overflow-hidden hover:border-purple-500/30 transition-all">
            {/* Preview area - colored gradient based on palette */}
            <div
                className="h-28 bg-gradient-to-br from-zinc-900 to-zinc-800 flex items-center justify-center cursor-pointer relative"
                onClick={onPreview}
            >
                {/* Palette color preview */}
                <div className="flex gap-0.5">
                    {viz.tags
                        .filter(t => PALETTE_NAMES.includes(t as any))
                        .slice(0, 1)
                        .flatMap(paletteName => {
                            const colors = PALETTES[paletteName as keyof typeof PALETTES];
                            return colors?.slice(0, 5).map((color, i) => (
                                <div
                                    key={i}
                                    className="w-6 h-16 rounded-sm"
                                    style={{ backgroundColor: color, opacity: 0.6 + i * 0.08 }}
                                />
                            )) || [];
                        })}
                </div>
                {/* Play overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 backdrop-blur">
                        <Play className="h-5 w-5 text-white ml-0.5" />
                    </div>
                </div>
                {/* Interactive badge */}
                {viz.interactive && (
                    <span className="absolute top-2 right-2 text-[8px] px-1 py-0.5 rounded bg-purple-500/20 text-purple-300 uppercase font-bold">
                        Interactive
                    </span>
                )}
            </div>

            {/* Info */}
            <div className="p-3">
                <p className="text-sm font-medium truncate">{viz.name}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-0.5">{viz.category}</p>
                <div className="flex items-center mt-2 gap-1">
                    <button
                        onClick={onToggleFavorite}
                        className={cn(
                            "p-1 rounded transition-colors cursor-pointer",
                            isFavorite ? "text-rose-400" : "text-[var(--muted-foreground)] hover:text-rose-400"
                        )}
                        title="Favorite"
                    >
                        <Heart className={cn("h-3.5 w-3.5", isFavorite && "fill-current")} />
                    </button>
                    {playlists.length > 0 && (
                        <div className="relative">
                            <button
                                onClick={() => setShowPlaylistMenu(!showPlaylistMenu)}
                                className="p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors cursor-pointer"
                                title="Add to playlist"
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                            {showPlaylistMenu && (
                                <div className="absolute bottom-full left-0 mb-1 bg-[var(--popover)] border border-[var(--border)] rounded-lg shadow-lg py-1 min-w-[140px] z-10">
                                    {playlists.map(pl => (
                                        <button
                                            key={pl.id}
                                            onClick={() => {
                                                onAddToPlaylist(pl.id);
                                                setShowPlaylistMenu(false);
                                            }}
                                            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--accent)] cursor-pointer"
                                        >
                                            {pl.name}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
