"use client";

import { useState, useCallback, useEffect } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import {
    Search, FolderOpen, Music, Piano, Sliders, ChevronRight, ChevronDown,
    File, FileAudio, Plus, Play, GripVertical, Drum,
} from "lucide-react";
import { EFFECT_TYPES, DRUM_KIT_DEFAULT } from "@/lib/daw-engine";

type BrowserTab = "files" | "samples" | "plugins" | "presets";

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
                <div
                    key={track.id}
                    className="flex items-center gap-2 px-2 py-1 hover:bg-white/5 cursor-pointer group"
                    draggable
                    onDragStart={e => {
                        e.dataTransfer.setData("text/plain", JSON.stringify({ type: "library-track", track }));
                    }}
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
                            daw.importTrackFromLibrary(track.filePath, track.title);
                        }}
                        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded bg-purple-500/20 hover:bg-purple-500/40 text-purple-400 transition-all"
                    >
                        <Plus className="h-3 w-3" />
                    </button>
                </div>
            ))}
            {tracks.length === 0 && <div className="p-3 text-center text-[11px] text-white/20">No results</div>}
        </div>
    );
}

function SampleBrowser() {
    const daw = useDAW();

    const categories = [
        { name: "Drum Kits", items: DRUM_KIT_DEFAULT.map(d => d.name) },
        { name: "One Shots", items: ["Kick", "Snare", "Clap", "Hi-Hat", "Crash", "Ride", "Tom", "Percussion"] },
        { name: "Loops", items: ["Drum Loop 1", "Bass Loop 1", "Synth Loop 1"] },
    ];

    return (
        <div>
            {categories.map(cat => (
                <CollapsibleSection key={cat.name} title={cat.name}>
                    {cat.items.map(item => (
                        <div
                            key={item}
                            className="flex items-center gap-2 px-3 py-1 hover:bg-white/5 cursor-pointer text-[11px] text-white/50"
                            draggable
                        >
                            <Drum className="h-3 w-3 text-white/20" />
                            {item}
                        </div>
                    ))}
                </CollapsibleSection>
            ))}
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

function CollapsibleSection({ title, children }: { title: string; children: React.ReactNode }) {
    const [open, setOpen] = useState(true);

    return (
        <div>
            <button
                onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-1 px-2 py-1 text-[10px] text-white/40 hover:text-white/60 bg-white/[0.02]"
            >
                {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span className="uppercase tracking-wider">{title}</span>
            </button>
            {open && children}
        </div>
    );
}
