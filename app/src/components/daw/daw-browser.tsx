"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import {
    Search, FolderOpen, Music, Piano, Sliders, ChevronRight, ChevronDown,
    File, FileAudio, Plus, Play, Pause, GripVertical, Drum, Info,
    Volume2, Clock, Hash, Disc,
} from "lucide-react";
import { EFFECT_TYPES, DRUM_KIT_DEFAULT } from "@/lib/daw-engine";
import { useContextMenu, type MenuEntry } from "./daw-context-menu";
import { useTouchDrag } from "./daw-ui-utils";
import { useRenderCount } from "@/lib/dev-debugger";

type BrowserTab = "files" | "samples" | "plugins" | "presets";

// ─── Manifest types ─────────────────────────────────────────────────────────

interface SampleInfo {
    file: string;
    path: string;
    name: string;
    type: string;
    duration: number;
    sizeKB: number;
    oneshot: boolean;
    bpm: number | null;
    key: string | null;
    brightness: string | null;
    rmsDb: number | null;
}

interface GenreGroup {
    name: string;
    label: string;
    path: string;
    samples: SampleInfo[];
}

interface SampleCategory {
    path: string;
    label: string;
    genres: GenreGroup[];
    sampleCount: number;
}

interface SampleManifest {
    version: number;
    name: string;
    description: string;
    categories: SampleCategory[];
    totalSamples: number;
    totalSizeKB: number;
}

// For library integration
interface LibraryTrack {
    id: number;
    title: string;
    artist: string;
    bpm: number | null;
    key: string | null;
    duration: number | null;
    filePath: string;
}

export function DAWBrowser() {
    useRenderCount("DAWBrowser");
    const daw = useDAW();
    const [tab, setTab] = useState<BrowserTab>("files");
    const [searchQuery, setSearchQuery] = useState("");
    const [libraryTracks, setLibraryTracks] = useState<LibraryTrack[]>([]);
    const [loadingLibrary, setLoadingLibrary] = useState(false);

    // Search library tracks
    const searchLibrary = useCallback(async (query: string) => {
        if (query.length < 2) {
            setLibraryTracks([]);
            return;
        }
        setLoadingLibrary(true);
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=50`);
            if (res.ok) {
                const data = await res.json();
                setLibraryTracks(data.tracks ?? data ?? []);
            }
        } catch {
            // silently fail
        } finally {
            setLoadingLibrary(false);
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => {
            if (tab === "files" && searchQuery) searchLibrary(searchQuery);
        }, 300);
        return () => clearTimeout(t);
    }, [searchQuery, tab, searchLibrary]);

    const tabs: { id: BrowserTab; label: string; icon: typeof Music }[] = [
        { id: "files", label: "Library", icon: Music },
        { id: "samples", label: "Samples", icon: FileAudio },
        { id: "plugins", label: "Plugins", icon: Sliders },
        { id: "presets", label: "Presets", icon: Piano },
    ];

    return (
        <div className="h-full flex flex-col bg-[var(--daw-bg)]">
            {/* Tab bar */}
            <div className="flex border-b border-white/10 flex-shrink-0">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={cn(
                            "flex-1 h-7 flex items-center justify-center gap-1 text-[10px] transition-colors",
                            tab === t.id
                                ? "bg-white/5 text-white/80 border-b border-purple-500"
                                : "text-white/30 hover:text-white/50"
                        )}
                    >
                        <t.icon className="h-3 w-3" />
                        {t.label}
                    </button>
                ))}
            </div>

            {/* Search */}
            <div className="p-1.5 border-b border-white/5 flex-shrink-0">
                <div className="flex items-center gap-1 bg-black/30 rounded px-2 h-6">
                    <Search className="h-3 w-3 text-white/20" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search..."
                        className="flex-1 bg-transparent text-xs text-white/70 placeholder:text-white/20 focus:outline-none"
                    />
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                {tab === "files" && (
                    <FileBrowser
                        tracks={libraryTracks}
                        loading={loadingLibrary}
                        query={searchQuery}
                    />
                )}
                {tab === "samples" && <SampleBrowser />}
                {tab === "plugins" && <PluginBrowser />}
                {tab === "presets" && <PresetBrowser />}
            </div>
        </div>
    );
}

function FileBrowser({ tracks, loading, query }: { tracks: LibraryTrack[]; loading: boolean; query: string }) {
    const daw = useDAW();
    const ctxMenu = useContextMenu();

    const handleTrackContextMenu = useCallback((e: React.MouseEvent, track: LibraryTrack) => {
        e.preventDefault();
        const items: MenuEntry[] = [
            { type: "label", label: track.title },
            { type: "separator" },
            {
                label: "Add to Timeline",
                icon: <Plus className="h-3.5 w-3.5" />,
                onClick: () => daw.importTrackFromLibrary(track.filePath, track.title),
            },
            { type: "separator" },
            {
                label: `BPM: ${track.bpm ?? "—"}`,
                icon: <Info className="h-3.5 w-3.5" />,
                disabled: true,
                onClick: () => { },
            },
            {
                label: `Key: ${track.key ?? "—"}`,
                icon: <Music className="h-3.5 w-3.5" />,
                disabled: true,
                onClick: () => { },
            },
        ];
        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, ctxMenu]);

    if (!query) {
        return (
            <div className="p-3 text-center">
                <Music className="h-8 w-8 text-white/10 mx-auto mb-2" />
                <p className="text-[11px] text-white/20">Search your library to find tracks</p>
                <p className="text-[10px] text-white/10 mt-1">Drag tracks to the timeline or click + to add</p>
            </div>
        );
    }

    if (loading) {
        return <div className="p-3 text-center text-[11px] text-white/20">Searching...</div>;
    }

    return (
        <div>
            {tracks.map(track => (
                <LibraryTrackRow
                    key={track.id}
                    track={track}
                    onContextMenu={e => handleTrackContextMenu(e, track)}
                    onAdd={() => daw.importTrackFromLibrary(track.filePath, track.title)}
                />
            ))}
            {tracks.length === 0 && <div className="p-3 text-center text-[11px] text-white/20">No results</div>}
        </div>
    );
}

function LibraryTrackRow({ track, onContextMenu, onAdd }: {
    track: LibraryTrack;
    onContextMenu: (e: React.MouseEvent) => void;
    onAdd: () => void;
}) {
    const touchDrag = useTouchDrag({
        payload: { type: "library-track", track },
        ghostText: track.title,
    });
    return (
        <div
            className="flex items-center gap-2 px-2 py-1 hover:bg-white/5 cursor-pointer group"
            draggable
            onDragStart={e => {
                e.dataTransfer.setData("text/plain", JSON.stringify({ type: "library-track", track }));
                e.dataTransfer.effectAllowed = "copy";
                const ghost = document.createElement("div");
                ghost.style.cssText = `
                    position: fixed; top: -1000px; left: -1000px;
                    padding: 6px 12px; border-radius: 6px;
                    background: linear-gradient(135deg, rgba(59,130,246,0.9), rgba(37,99,235,0.9));
                    color: white; font-size: 11px; font-family: system-ui;
                    display: flex; align-items: center; gap: 6px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                    white-space: nowrap; border: 1px solid rgba(255,255,255,0.15);
                `;
                ghost.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><span>${track.title}</span>`;
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 20, 20);
                requestAnimationFrame(() => document.body.removeChild(ghost));
            }}
            onContextMenu={onContextMenu}
            {...touchDrag}
        >
            <FileAudio className="h-3 w-3 text-white/20 flex-shrink-0" />
            <div className="flex-1 min-w-0">
                <p className="text-[11px] text-white/70 truncate">{track.title}</p>
                <p className="text-[9px] text-white/30 truncate">{track.artist}</p>
            </div>
            {track.bpm && <span className="text-[9px] text-white/20 font-mono">{track.bpm}</span>}
            {track.key && <span className="text-[9px] text-white/20">{track.key}</span>}
            <button
                onClick={e => {
                    e.stopPropagation();
                    onAdd();
                }}
                        className="opacity-60 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded bg-purple-500/20 hover:bg-purple-500/40 text-purple-400 transition-all"
            >
                <Plus className="h-3 w-3" />
            </button>
        </div>
    );
}

function SampleBrowser() {
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const [manifest, setManifest] = useState<SampleManifest | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchFilter, setSearchFilter] = useState("");
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Load manifest on mount
    useEffect(() => {
        fetch("/samples/manifest.json")
            .then(res => {
                if (!res.ok) throw new Error("Manifest not found — run: python scripts/build-sample-pack.py");
                return res.json();
            })
            .then((data: SampleManifest) => {
                setManifest(data);
                setLoading(false);
            })
            .catch(err => {
                setError(err.message);
                setLoading(false);
            });
    }, []);

    // Cleanup audio preview on unmount
    useEffect(() => {
        return () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);

    // Toggle preview playback
    const togglePreview = useCallback((samplePath: string) => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        if (previewUrl === samplePath) {
            setPreviewUrl(null);
            setPreviewPlaying(false);
            return;
        }

        const audio = new Audio(samplePath);
        audio.volume = 0.5;
        audio.onended = () => {
            setPreviewUrl(null);
            setPreviewPlaying(false);
        };
        audio.play();
        audioRef.current = audio;
        setPreviewUrl(samplePath);
        setPreviewPlaying(true);
    }, [previewUrl]);

    // Filter samples by search query
    const filteredCategories = useMemo(() => {
        if (!manifest) return [];
        if (!searchFilter.trim()) return manifest.categories;

        const q = searchFilter.toLowerCase();
        return manifest.categories
            .map(cat => ({
                ...cat,
                genres: cat.genres
                    .map(g => ({
                        ...g,
                        samples: g.samples.filter(s =>
                            s.name.toLowerCase().includes(q) ||
                            s.type.toLowerCase().includes(q) ||
                            g.label.toLowerCase().includes(q) ||
                            cat.label.toLowerCase().includes(q) ||
                            (s.key && s.key.toLowerCase().includes(q)) ||
                            (s.brightness && s.brightness.toLowerCase().includes(q))
                        ),
                    }))
                    .filter(g => g.samples.length > 0),
                sampleCount: 0, // will recalc
            }))
            .map(cat => ({ ...cat, sampleCount: cat.genres.reduce((sum, g) => sum + g.samples.length, 0) }))
            .filter(cat => cat.sampleCount > 0);
    }, [manifest, searchFilter]);

    const handleSampleContextMenu = useCallback((e: React.MouseEvent, sample: SampleInfo, genre: GenreGroup) => {
        e.preventDefault();
        const items: MenuEntry[] = [
            { type: "label", label: sample.name },
            { type: "separator" },
            {
                label: "Add to Timeline",
                icon: <Plus className="h-3.5 w-3.5" />,
                onClick: () => daw.importTrackFromLibrary(sample.path, sample.name),
            },
            {
                label: previewUrl === sample.path ? "Stop Preview" : "Preview",
                icon: previewUrl === sample.path ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />,
                onClick: () => togglePreview(sample.path),
            },
            { type: "separator" },
            {
                label: `Duration: ${sample.duration.toFixed(2)}s`,
                icon: <Clock className="h-3.5 w-3.5" />,
                disabled: true, onClick: () => { },
            },
            {
                label: `Size: ${sample.sizeKB < 1024 ? `${Math.round(sample.sizeKB)}KB` : `${(sample.sizeKB / 1024).toFixed(1)}MB`}`,
                icon: <Info className="h-3.5 w-3.5" />,
                disabled: true, onClick: () => { },
            },
            ...(sample.bpm ? [{
                label: `BPM: ${sample.bpm}`,
                icon: <Hash className="h-3.5 w-3.5" />,
                disabled: true, onClick: () => { },
            } as MenuEntry] : []),
            ...(sample.key ? [{
                label: `Key: ${sample.key}`,
                icon: <Music className="h-3.5 w-3.5" />,
                disabled: true, onClick: () => { },
            } as MenuEntry] : []),
        ];
        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, ctxMenu, previewUrl, togglePreview]);

    if (loading) {
        return (
            <div className="p-3 text-center">
                <div className="animate-spin h-5 w-5 border-2 border-purple-500 border-t-transparent rounded-full mx-auto mb-2" />
                <p className="text-[11px] text-white/30">Loading samples...</p>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-3 text-center">
                <Disc className="h-8 w-8 text-white/10 mx-auto mb-2" />
                <p className="text-[11px] text-red-400/60">{error}</p>
                <p className="text-[9px] text-white/20 mt-1">Run the build script to generate samples</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Sample search */}
            <div className="px-1.5 pb-1 flex-shrink-0">
                <div className="flex items-center gap-1 bg-black/20 rounded px-2 h-5">
                    <Search className="h-2.5 w-2.5 text-white/15" />
                    <input
                        type="text"
                        value={searchFilter}
                        onChange={e => setSearchFilter(e.target.value)}
                        placeholder="Filter samples..."
                        className="flex-1 bg-transparent text-[10px] text-white/60 placeholder:text-white/15 focus:outline-none"
                    />
                    {manifest && (
                        <span className="text-[8px] text-white/15 font-mono">
                            {searchFilter
                                ? filteredCategories.reduce((s, c) => s + c.sampleCount, 0)
                                : manifest.totalSamples}
                        </span>
                    )}
                </div>
            </div>

            {/* Category tree */}
            <div className="flex-1 overflow-y-auto">
                {filteredCategories.map(cat => (
                    <CollapsibleSection
                        key={cat.path}
                        title={`${cat.label} (${cat.sampleCount})`}
                        defaultOpen={false}
                    >
                        {cat.genres.map(genre => (
                            <CollapsibleSection
                                key={genre.path}
                                title={`${genre.label} (${genre.samples.length})`}
                                indent
                                defaultOpen={false}
                            >
                                {genre.samples.map(sample => (
                                    <SampleRow
                                        key={sample.path}
                                        sample={sample}
                                        isPreviewing={previewUrl === sample.path}
                                        onTogglePreview={() => togglePreview(sample.path)}
                                        onContextMenu={e => handleSampleContextMenu(e, sample, genre)}
                                        onDoubleClick={() => daw.importTrackFromLibrary(sample.path, sample.name)}
                                        onAdd={() => daw.importTrackFromLibrary(sample.path, sample.name)}
                                    />
                                ))}
                            </CollapsibleSection>
                        ))}
                    </CollapsibleSection>
                ))}
            </div>
        </div>
    );
}

function SampleRow({ sample, isPreviewing, onTogglePreview, onContextMenu, onDoubleClick, onAdd }: {
    sample: SampleInfo;
    isPreviewing: boolean;
    onTogglePreview: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
    onAdd: () => void;
}) {
    const touchDrag = useTouchDrag({
        payload: {
            type: "sample",
            path: sample.path,
            name: sample.name,
            duration: sample.duration,
            sampleType: sample.type,
        },
        ghostText: sample.name,
    });
    return (
        <div
            className={cn(
                "flex items-center gap-1.5 px-4 py-0.5 hover:bg-white/5 cursor-pointer group text-[10px]",
                isPreviewing && "bg-purple-500/10"
            )}
            draggable
            onDragStart={e => {
                e.dataTransfer.setData("text/plain", JSON.stringify({
                    type: "sample",
                    path: sample.path,
                    name: sample.name,
                    duration: sample.duration,
                    sampleType: sample.type,
                }));
                e.dataTransfer.effectAllowed = "copy";
                const ghost = document.createElement("div");
                ghost.style.cssText = `
                    position: fixed; top: -1000px; left: -1000px;
                    padding: 6px 12px; border-radius: 6px;
                    background: linear-gradient(135deg, rgba(139,92,246,0.9), rgba(109,40,217,0.9));
                    color: white; font-size: 11px; font-family: system-ui;
                    display: flex; align-items: center; gap: 6px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                    backdrop-filter: blur(8px); white-space: nowrap;
                    border: 1px solid rgba(255,255,255,0.15);
                `;
                ghost.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M2 12h4l3-9 4 18 3-9h4"/></svg><span>${sample.name}</span>`;
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 20, 20);
                requestAnimationFrame(() => document.body.removeChild(ghost));
            }}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            {...touchDrag}
        >
            <button
                onClick={e => { e.stopPropagation(); onTogglePreview(); }}
                className={cn(
                    "w-3.5 h-3.5 flex items-center justify-center flex-shrink-0 rounded-sm transition-colors",
                    isPreviewing ? "text-purple-400" : "text-white/15 opacity-0 group-hover:opacity-100"
                )}
            >
                {isPreviewing ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}
            </button>
            <span className={cn("flex-1 truncate", isPreviewing ? "text-purple-300/80" : "text-white/50")}>
                {sample.name}
            </span>
            <span className="text-[8px] text-white/15 font-mono flex-shrink-0">
                {sample.duration < 1 ? `${Math.round(sample.duration * 1000)}ms` : `${sample.duration.toFixed(1)}s`}
            </span>
            {sample.key && (
                <span className="text-[8px] text-cyan-400/30 font-mono flex-shrink-0 w-5 text-center">{sample.key}</span>
            )}
            {sample.oneshot && (
                <span className="text-[7px] text-green-400/25 flex-shrink-0">1S</span>
            )}
            <button
                onClick={e => { e.stopPropagation(); onAdd(); }}
                className="opacity-60 group-hover:opacity-100 w-3.5 h-3.5 flex items-center justify-center rounded-sm bg-purple-500/20 hover:bg-purple-500/40 text-purple-400 transition-all flex-shrink-0"
            >
                <Plus className="h-2.5 w-2.5" />
            </button>
        </div>
    );
}

function PluginBrowser() {
    const daw = useDAW();

    const plugins: { name: string; type: string }[] = EFFECT_TYPES.map(t => ({ name: t, type: "effect" }));

    return (
        <div>
            <CollapsibleSection title="Effects">
                {plugins.map(p => (
                    <div
                        key={p.name}
                        className="flex items-center gap-2 px-3 py-1 hover:bg-white/5 cursor-pointer text-[11px] text-white/50"
                        draggable
                        onDragStart={e => {
                            e.dataTransfer.setData("text/plain", JSON.stringify({ type: "plugin", plugin: p }));
                        }}
                    >
                        <Sliders className="h-3 w-3 text-cyan-400/40" />
                        <span className="capitalize">{p.name.replace(/_/g, " ")}</span>
                    </div>
                ))}
            </CollapsibleSection>
            <CollapsibleSection title="Instruments">
                {["Synthesizer", "Sampler", "Drum Machine"].map(inst => (
                    <div
                        key={inst}
                        className="flex items-center gap-2 px-3 py-1 hover:bg-white/5 cursor-pointer text-[11px] text-white/50"
                    >
                        <Piano className="h-3 w-3 text-purple-400/40" />
                        {inst}
                    </div>
                ))}
            </CollapsibleSection>
        </div>
    );
}

function PresetBrowser() {
    const synthPresets = [
        "Init Patch", "Fat Bass", "Saw Lead", "Pad Warm", "Pluck Bright",
        "Sub Bass", "Detuned Lead", "String Pad", "Arp Sequence", "FM Bell",
    ];

    return (
        <div>
            <CollapsibleSection title="Synth Presets">
                {synthPresets.map(p => (
                    <div
                        key={p}
                        className="flex items-center gap-2 px-3 py-1 hover:bg-white/5 cursor-pointer text-[11px] text-white/50"
                    >
                        <File className="h-3 w-3 text-white/20" />
                        {p}
                    </div>
                ))}
            </CollapsibleSection>
        </div>
    );
}

function CollapsibleSection({ title, children, indent, defaultOpen = true }: { title: string; children: React.ReactNode; indent?: boolean; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div>
            <button
                onClick={() => setOpen(!open)}
                className={cn(
                    "w-full flex items-center gap-1 py-0.5 text-[10px] text-white/40 hover:text-white/60 bg-white/[0.02]",
                    indent ? "px-3" : "px-2",
                )}
            >
                {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                <span className={cn("uppercase tracking-wider truncate", indent && "text-[9px]")}>{title}</span>
            </button>
            {open && children}
        </div>
    );
}
