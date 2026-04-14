"use client";

import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
    Palette,
    Zap,
    KeyRound,
    Disc3,
    Keyboard,
    MousePointer,
    Info,
} from "lucide-react";

type Tab = "harmonic" | "energy" | "genres" | "shortcuts" | "general";

const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "harmonic", label: "Harmonic Keys", icon: KeyRound },
    { id: "energy", label: "Energy", icon: Zap },
    { id: "genres", label: "Genres", icon: Disc3 },
    { id: "shortcuts", label: "Controls", icon: Keyboard },
    { id: "general", label: "General", icon: Info },
];

// ─── Harmonic Data ────────────────────────────────────────────────────────────

const harmonicRules = [
    {
        color: "bg-green-400",
        textClass: "text-green-400",
        label: "Perfect Match",
        description: "Same key or relative major/minor (e.g. 8A → 8A, 8A → 8B)",
    },
    {
        color: "bg-yellow-400",
        textClass: "text-yellow-400",
        label: "Compatible",
        description: "Adjacent key ±1 on same letter (e.g. 7A → 8A, 12A → 1A)",
    },
    {
        color: "bg-red-400",
        textClass: "text-red-400",
        label: "Clash",
        description: "Keys too far apart — avoid mixing these tracks",
    },
    {
        color: "bg-muted",
        textClass: "text-muted-foreground",
        label: "Unknown",
        description: "Key data missing — no harmonic info available",
    },
];

// ─── Energy Data ──────────────────────────────────────────────────────────────

const energyLevels = [
    { level: 1, color: "bg-blue-500", label: "Very Low", desc: "Ambient, intro, downtempo" },
    { level: 2, color: "bg-cyan-500", label: "Low", desc: "Chill, lo-fi, warm-up" },
    { level: 3, color: "bg-teal-500", label: "Low-Med", desc: "Deep house, smooth grooves" },
    { level: 4, color: "bg-green-500", label: "Medium", desc: "Steady groove, mid-tempo" },
    { level: 5, color: "bg-lime-500", label: "Medium", desc: "Driving beats, building energy" },
    { level: 6, color: "bg-yellow-500", label: "Med-High", desc: "Peak hour warm-up" },
    { level: 7, color: "bg-amber-500", label: "High", desc: "Main room, high energy" },
    { level: 8, color: "bg-orange-500", label: "High", desc: "Peak time, big drops" },
    { level: 9, color: "bg-red-500", label: "Very High", desc: "Maximum intensity" },
    { level: 10, color: "bg-rose-500", label: "Peak", desc: "Absolute maximum energy" },
];

// ─── Genre Data ───────────────────────────────────────────────────────────────

const genreColors: { genre: string; bg: string; text: string }[] = [
    { genre: "House", bg: "bg-purple-500/20", text: "text-purple-400" },
    { genre: "Tech House", bg: "bg-violet-500/20", text: "text-violet-400" },
    { genre: "Deep House", bg: "bg-indigo-500/20", text: "text-indigo-400" },
    { genre: "Prog. House", bg: "bg-blue-500/20", text: "text-blue-400" },
    { genre: "Techno", bg: "bg-zinc-500/20", text: "text-zinc-300" },
    { genre: "Melodic Techno", bg: "bg-slate-500/20", text: "text-slate-300" },
    { genre: "Trance", bg: "bg-cyan-500/20", text: "text-cyan-400" },
    { genre: "Psytrance", bg: "bg-emerald-500/20", text: "text-emerald-400" },
    { genre: "Drum & Bass", bg: "bg-amber-500/20", text: "text-amber-400" },
    { genre: "Dubstep", bg: "bg-red-500/20", text: "text-red-400" },
    { genre: "EDM", bg: "bg-pink-500/20", text: "text-pink-400" },
    { genre: "Electro", bg: "bg-yellow-500/20", text: "text-yellow-400" },
    { genre: "Hip Hop", bg: "bg-orange-500/20", text: "text-orange-400" },
    { genre: "R&B", bg: "bg-rose-500/20", text: "text-rose-400" },
    { genre: "Pop", bg: "bg-fuchsia-500/20", text: "text-fuchsia-400" },
    { genre: "Rock", bg: "bg-stone-500/20", text: "text-stone-400" },
    { genre: "Latin", bg: "bg-lime-500/20", text: "text-lime-400" },
    { genre: "Reggaeton", bg: "bg-green-500/20", text: "text-green-400" },
    { genre: "Afrobeat", bg: "bg-teal-500/20", text: "text-teal-400" },
    { genre: "Disco", bg: "bg-sky-500/20", text: "text-sky-400" },
    { genre: "Funk", bg: "bg-amber-600/20", text: "text-amber-500" },
    { genre: "Jazz", bg: "bg-blue-600/20", text: "text-blue-500" },
    { genre: "Classical", bg: "bg-neutral-500/20", text: "text-neutral-400" },
    { genre: "Ambient", bg: "bg-gray-500/20", text: "text-gray-400" },
    { genre: "Breakbeat", bg: "bg-orange-600/20", text: "text-orange-500" },
    { genre: "Garage", bg: "bg-violet-600/20", text: "text-violet-500" },
    { genre: "Minimal", bg: "bg-zinc-400/20", text: "text-zinc-300" },
    { genre: "Hardstyle", bg: "bg-red-600/20", text: "text-red-500" },
    { genre: "Hardcore", bg: "bg-rose-600/20", text: "text-rose-500" },
];

// ─── Controls Data ────────────────────────────────────────────────────────────

const keyboardShortcuts: { keys: string[]; action: string; note?: string }[] = [
    { keys: ["Space"], action: "Play / Pause" },
    { keys: ["→"], action: "Next track" },
    { keys: ["←"], action: "Previous track" },
    { keys: ["Shift", "→"], action: "Seek forward 5s" },
    { keys: ["Shift", "←"], action: "Seek back 5s" },
    { keys: ["↑"], action: "Volume up" },
    { keys: ["↓"], action: "Volume down" },
    { keys: ["M"], action: "Mute / Unmute" },
    { keys: ["S"], action: "Toggle shuffle" },
    { keys: ["R"], action: "Toggle repeat", note: "Cycles: Off → All → One" },
    { keys: ["N"], action: "Toggle Now Playing" },
    { keys: ["Esc"], action: "Close Now Playing" },
];

const mouseControls: { action: string; how: string }[] = [
    { action: "Play Track", how: "Click the play button on track row hover" },
    { action: "Seek", how: "Click anywhere on the progress bar" },
    { action: "Volume", how: "Drag the volume slider" },
    { action: "Sort Column", how: "Click any column header (click again to reverse)" },
    { action: "Search", how: "Type in the search box to filter" },
    { action: "Toggle Favorite", how: "Click the heart icon on a track row" },
    { action: "Rate Track", how: "Click the stars in the Rating column" },
    { action: "Track Details", how: "Click a track's title to open the detail modal" },
    { action: "Add to Queue", how: "Track actions menu (⋯) → Add to Queue" },
    { action: "Add to Playlist", how: "Track actions menu (⋯) → Add to Playlist" },
    { action: "Manage Columns", how: "Click \"More\" button to show/hide table columns" },
    { action: "Now Playing", how: "Click the track info in the player bar" },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface LegendModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function LegendModal({ open, onOpenChange }: LegendModalProps) {
    const [activeTab, setActiveTab] = useState<Tab>("harmonic");

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
                <DialogHeader className="px-6 pt-6 pb-4">
                    <DialogTitle className="flex items-center gap-2.5 text-lg">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-fuchsia-600">
                            <Palette className="h-4 w-4 text-white" />
                        </div>
                        Legend & Help
                    </DialogTitle>
                </DialogHeader>

                {/* Tab bar */}
                <div className="flex gap-1 px-6 pb-3 border-b border-border overflow-x-auto">
                    {tabs.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setActiveTab(id)}
                            className={cn(
                                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors cursor-pointer",
                                activeTab === id
                                    ? "bg-purple-500/15 text-purple-400 dark:text-purple-300"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                            )}
                        >
                            <Icon className="h-3.5 w-3.5" />
                            {label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-6 py-5">
                    {activeTab === "harmonic" && <HarmonicTab />}
                    {activeTab === "energy" && <EnergyTab />}
                    {activeTab === "genres" && <GenresTab />}
                    {activeTab === "shortcuts" && <ControlsTab />}
                    {activeTab === "general" && <GeneralTab />}
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── Tab Content ──────────────────────────────────────────────────────────────

function HarmonicTab() {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-sm font-semibold mb-1">Camelot Wheel — Harmonic Mixing</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    When a track is playing, the library rows are colored to show harmonic compatibility
                    with the current track. This uses the Camelot key notation system.
                </p>
            </div>

            <div className="space-y-2">
                {harmonicRules.map((rule) => (
                    <div key={rule.label} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
                        <div className={cn("mt-0.5 h-3 w-3 shrink-0 rounded-full", rule.color)} />
                        <div>
                            <p className={cn("text-sm font-medium", rule.textClass)}>{rule.label}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{rule.description}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                    <strong className="text-foreground">Tip:</strong> For smooth transitions, mix tracks that show{" "}
                    <span className="text-green-400 font-medium">green</span> or{" "}
                    <span className="text-yellow-400 font-medium">yellow</span>. Avoid{" "}
                    <span className="text-red-400 font-medium">red</span> unless you want a dramatic key change.
                </p>
            </div>
        </div>
    );
}

function EnergyTab() {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-sm font-semibold mb-1">Energy Levels (1–10)</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Energy represents the intensity and danceability of a track, from ambient/chill (1) to maximum peak-time bangers (10).
                    Shown as a colored dot in the library table.
                </p>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
                {energyLevels.map((e) => (
                    <div key={e.level} className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2">
                        <div className={cn("h-3 w-3 shrink-0 rounded-full", e.color)} />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold tabular-nums">{e.level}</span>
                                <span className="text-xs font-medium">{e.label}</span>
                            </div>
                            <p className="text-[10px] text-muted-foreground truncate">{e.desc}</p>
                        </div>
                    </div>
                ))}
            </div>

            <div className="rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground leading-relaxed">
                    <strong className="text-foreground">Tip:</strong> Build energy gradually during your set.
                    Jump no more than ±2 levels between consecutive tracks for smooth progression.
                </p>
            </div>
        </div>
    );
}

function GenresTab() {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-sm font-semibold mb-1">Genre Colors</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                    Each genre is assigned a unique color badge in the library table for quick visual scanning.
                </p>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
                {genreColors.map((g) => (
                    <div
                        key={g.genre}
                        className={cn(
                            "rounded-md px-2.5 py-1.5 text-xs font-medium text-center",
                            g.bg,
                            g.text
                        )}
                    >
                        {g.genre}
                    </div>
                ))}
            </div>
        </div>
    );
}

function ControlsTab() {
    return (
        <div className="space-y-6">
            {/* Keyboard Shortcuts */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <Keyboard className="h-4 w-4 text-purple-400" />
                    <h3 className="text-sm font-semibold">Keyboard Shortcuts</h3>
                </div>
                <p className="text-xs text-muted-foreground mb-3 px-1">
                    Shortcuts are active when no input field is focused.
                </p>
                <div className="space-y-1">
                    {keyboardShortcuts.map((s) => (
                        <div key={s.action} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors">
                            <div className="flex items-center gap-1 w-28 shrink-0">
                                {s.keys.map((k, i) => (
                                    <span key={i} className="flex items-center gap-1">
                                        {i > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
                                        <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-[10px] font-medium text-foreground">
                                            {k}
                                        </kbd>
                                    </span>
                                ))}
                            </div>
                            <div className="flex-1 min-w-0">
                                <span className="text-xs text-foreground">{s.action}</span>
                                {s.note && (
                                    <span className="text-[10px] text-muted-foreground ml-1.5">({s.note})</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Mouse / Click Actions */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <MousePointer className="h-4 w-4 text-purple-400" />
                    <h3 className="text-sm font-semibold">Mouse Actions</h3>
                </div>
                <div className="space-y-1">
                    {mouseControls.map((c) => (
                        <div key={c.action} className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-muted/50 transition-colors">
                            <span className="text-xs font-medium w-28 shrink-0 text-foreground">{c.action}</span>
                            <span className="text-xs text-muted-foreground">{c.how}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function GeneralTab() {
    return (
        <div className="space-y-5">
            <div>
                <h3 className="text-sm font-semibold mb-1">UI Indicators</h3>
                <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                    Quick reference for visual elements throughout the app.
                </p>

                <div className="space-y-2">
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="h-3 w-3 rounded-full bg-purple-500" />
                        <div>
                            <p className="text-xs font-medium">Purple accent</p>
                            <p className="text-[10px] text-muted-foreground">Active/selected elements, currently playing track</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="h-3 w-3 rounded-full bg-rose-500" />
                        <div>
                            <p className="text-xs font-medium">Heart / Favorite</p>
                            <p className="text-[10px] text-muted-foreground">Filled red heart = favorited track</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="flex items-end gap-[2px] h-3.5">
                            {[0, 1, 2, 3].map((i) => (
                                <div
                                    key={i}
                                    className="w-[2.5px] rounded-full bg-purple-400 animate-[barBounce_0.8s_ease-in-out_infinite]"
                                    style={{ animationDelay: `${i * 0.12}s` }}
                                />
                            ))}
                        </div>
                        <div>
                            <p className="text-xs font-medium">Waveform bars</p>
                            <p className="text-[10px] text-muted-foreground">Animated bars indicate a track is currently playing</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
                        <div className="flex gap-0.5">
                            {[1, 2, 3, 4, 5].map((s) => (
                                <svg key={s} viewBox="0 0 24 24" className={cn("h-3 w-3", s <= 3 ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground/30")} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                </svg>
                            ))}
                        </div>
                        <div>
                            <p className="text-xs font-medium">Star Rating</p>
                            <p className="text-[10px] text-muted-foreground">1–5 stars to rate tracks — click to set, click same to clear</p>
                        </div>
                    </div>
                </div>
            </div>

            <div>
                <h3 className="text-sm font-semibold mb-2">Activity Log Icons</h3>
                <div className="grid grid-cols-2 gap-1.5">
                    {[
                        { color: "bg-green-500", label: "Track added" },
                        { color: "bg-blue-500", label: "Track moved" },
                        { color: "bg-purple-500", label: "Analysis started" },
                        { color: "bg-purple-400", label: "Analysis completed" },
                        { color: "bg-yellow-500", label: "Other activity" },
                    ].map((a) => (
                        <div key={a.label} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                            <div className={cn("h-2.5 w-2.5 rounded-full", a.color)} />
                            <span className="text-xs">{a.label}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
