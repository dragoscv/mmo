"use client";

import type { EditorSnapshot } from "@/lib/remote-sync";
import { cn } from "@/lib/utils";
import { RemotePanel } from "@/components/remote/remote-visibility";
import {
    Play,
    Pause,
    Square,
    Undo2,
    Redo2,
    Scissors,
    Copy,
    ClipboardPaste,
    Volume2,
    VolumeX,
    Waves,
    Maximize2,
    SkipBack,
    SkipForward,
} from "lucide-react";

interface EditorWidgetProps {
    snapshot: EditorSnapshot;
    sendCommand: (action: string, ...args: unknown[]) => void;
}

// ─── Stem Control ────────────────────────────────────────────────────────────

function StemSlider({ name, color, active, sendCommand }: {
    name: string; color: string; active: boolean;
    sendCommand: EditorWidgetProps["sendCommand"];
}) {
    return (
        <div className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl border transition-all",
            active ? "bg-white/[0.03] border-white/[0.08]" : "bg-white/[0.01] border-white/[0.04] opacity-40",
        )}>
            <div className="w-2 h-6 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <span className="text-[10px] font-medium text-white/50 w-16 capitalize">{name}</span>
            <div className="flex-1 h-1 rounded-full bg-white/5">
                <div className="h-full rounded-full" style={{ width: active ? "100%" : "0%", backgroundColor: color, opacity: 0.6 }} />
            </div>
        </div>
    );
}

// ─── Format time ─────────────────────────────────────────────────────────────

function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Main Editor Widget ──────────────────────────────────────────────────────

export function EditorRemoteWidget({ snapshot, sendCommand }: EditorWidgetProps) {
    return (
        <div className="px-4 py-3 flex flex-col gap-4">
            {/* File info */}
            <RemotePanel id="file" label="File & Progress">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center shrink-0">
                        <Waves className="w-5 h-5 text-purple-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-white/70 truncate">
                            {snapshot.fileName || "No file loaded"}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] tabular-nums text-white/30">{formatTime(snapshot.duration)}</span>
                            <span className="text-[10px] text-white/20">{snapshot.sampleRate / 1000}kHz</span>
                            <span className="text-[10px] text-white/20">{snapshot.channels === 2 ? "Stereo" : "Mono"}</span>
                        </div>
                    </div>
                    <div className="text-[10px] tabular-nums text-white/50">
                        <span className="text-purple-400">{snapshot.zoom.toFixed(1)}x</span>
                    </div>
                </div>

                {/* Progress */}
                <div className="mt-3">
                    <div className="flex items-center justify-between text-[9px] tabular-nums text-white/25 mb-1">
                        <span>{formatTime(snapshot.currentTime)}</span>
                        <span>{formatTime(snapshot.duration)}</span>
                    </div>
                    <div
                        className="h-2 rounded-full bg-white/[0.04] cursor-pointer overflow-hidden touch-none select-none"
                        onPointerDown={(e) => {
                            e.preventDefault();
                            (e.target as HTMLElement).setPointerCapture(e.pointerId);
                            const rect = e.currentTarget.getBoundingClientRect();
                            const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                            sendCommand("editor.seek", x * snapshot.duration);
                        }}
                        onPointerMove={(e) => {
                            if (e.buttons === 0) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                            sendCommand("editor.seek", x * snapshot.duration);
                        }}
                    >
                        <div className="h-full rounded-full bg-gradient-to-r from-purple-500/40 to-purple-400/60 transition-[width] duration-100"
                            style={{ width: `${(snapshot.currentTime / Math.max(0.001, snapshot.duration)) * 100}%` }} />
                    </div>
                </div>
            </div>
            </RemotePanel>

            {/* Transport */}
            <RemotePanel id="transport" label="Transport">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => sendCommand("editor.seek", 0)}
                        className="flex items-center justify-center w-11 h-11 rounded-xl bg-white/[0.04] text-white/30 hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="Go to start"
                    >
                        <SkipBack className="w-4 h-4" />
                    </button>

                    <button
                        onClick={() => snapshot.isPlaying ? sendCommand("editor.pause") : sendCommand("editor.play")}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl font-medium text-xs transition-all cursor-pointer",
                            snapshot.isPlaying
                                ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                : "bg-white/[0.04] text-white/40 hover:bg-white/[0.08] border border-white/[0.06]",
                        )}
                    >
                        {snapshot.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        {snapshot.isPlaying ? "Pause" : "Play"}
                    </button>

                    <button
                        onClick={() => sendCommand("editor.stop")}
                        className="flex items-center justify-center w-11 h-11 rounded-xl bg-white/[0.04] text-white/30 hover:bg-white/[0.08] border border-white/[0.06] transition-colors cursor-pointer"
                    >
                        <Square className="w-4 h-4" />
                    </button>

                    <button
                        onClick={() => sendCommand("editor.seek", snapshot.duration)}
                        className="flex items-center justify-center w-11 h-11 rounded-xl bg-white/[0.04] text-white/30 hover:bg-white/[0.08] transition-colors cursor-pointer"
                        title="Go to end"
                    >
                        <SkipForward className="w-4 h-4" />
                    </button>
                </div>

                {/* Undo/Redo */}
                <div className="flex items-center gap-2 mt-2">
                    <button onClick={() => sendCommand("editor.undo")}
                        disabled={!snapshot.canUndo}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-1 py-2 rounded-xl text-xs transition-colors cursor-pointer",
                            snapshot.canUndo ? "bg-white/[0.04] text-white/40 hover:bg-white/[0.08]" : "bg-white/[0.02] text-white/15",
                        )}>
                        <Undo2 className="w-3.5 h-3.5" /> Undo
                    </button>
                    <button onClick={() => sendCommand("editor.redo")}
                        disabled={!snapshot.canRedo}
                        className={cn(
                            "flex-1 flex items-center justify-center gap-1 py-2 rounded-xl text-xs transition-colors cursor-pointer",
                            snapshot.canRedo ? "bg-white/[0.04] text-white/40 hover:bg-white/[0.08]" : "bg-white/[0.02] text-white/15",
                        )}>
                        <Redo2 className="w-3.5 h-3.5" /> Redo
                    </button>
                </div>
            </div>
            </RemotePanel>

            {/* Selection tools */}
            <RemotePanel id="selection" label="Selection Tools">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">
                    Selection {snapshot.hasSelection && (
                        <span className="text-purple-400/50 normal-case">
                            ({formatTime(snapshot.selectionStart)} → {formatTime(snapshot.selectionEnd)})
                        </span>
                    )}
                </span>

                <div className="grid grid-cols-3 gap-1.5">
                    <button onClick={() => sendCommand("editor.cut")} disabled={!snapshot.hasSelection}
                        className={cn("flex flex-col items-center gap-1 py-2.5 rounded-xl text-[10px] transition-colors cursor-pointer",
                            snapshot.hasSelection ? "bg-white/[0.04] text-white/40 hover:bg-white/[0.08]" : "bg-white/[0.02] text-white/15")}>
                        <Scissors className="w-4 h-4" /> Cut
                    </button>
                    <button onClick={() => sendCommand("editor.copy")} disabled={!snapshot.hasSelection}
                        className={cn("flex flex-col items-center gap-1 py-2.5 rounded-xl text-[10px] transition-colors cursor-pointer",
                            snapshot.hasSelection ? "bg-white/[0.04] text-white/40 hover:bg-white/[0.08]" : "bg-white/[0.02] text-white/15")}>
                        <Copy className="w-4 h-4" /> Copy
                    </button>
                    <button onClick={() => sendCommand("editor.paste")}
                        className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-white/[0.04] text-white/40 hover:bg-white/[0.08] text-[10px] transition-colors cursor-pointer">
                        <ClipboardPaste className="w-4 h-4" /> Paste
                    </button>
                </div>
            </div>
            </RemotePanel>

            {/* Effects */}
            <RemotePanel id="effects" label="Effects">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">Effects</span>
                <div className="grid grid-cols-2 gap-1.5">
                    {[
                        { label: "Normalize", cmd: "editor.normalize", icon: <Maximize2 className="w-3.5 h-3.5" /> },
                        { label: "Silence", cmd: "editor.silence", icon: <VolumeX className="w-3.5 h-3.5" /> },
                        { label: "Fade In", cmd: "editor.fadeIn", icon: <Volume2 className="w-3.5 h-3.5" /> },
                        { label: "Fade Out", cmd: "editor.fadeOut", icon: <Volume2 className="w-3.5 h-3.5 rotate-180" /> },
                        { label: "Reverse", cmd: "editor.reverse", icon: <span className="text-xs">↔</span> },
                        { label: "Separate Stems", cmd: "editor.separateStems", icon: <Waves className="w-3.5 h-3.5" /> },
                    ].map(({ label, cmd, icon }) => (
                        <button
                            key={cmd}
                            onClick={() => sendCommand(cmd)}
                            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-white/[0.03] text-[10px] text-white/40 hover:bg-white/[0.06] hover:text-white/60 transition-colors cursor-pointer"
                        >
                            {icon}
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            </RemotePanel>

            {/* Stems */}
            <RemotePanel id="stems" label="Stems">
            {snapshot.stems.length > 0 && (
                <div className="rounded-2xl border border-purple-500/10 bg-purple-500/[0.02] p-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400/30 block mb-2">Stems</span>
                    <div className="flex flex-col gap-1">
                        {snapshot.stems.map(stem => (
                            <StemSlider
                                key={stem.name}
                                name={stem.name}
                                color={stem.color}
                                active={stem.active}
                                sendCommand={sendCommand}
                            />
                        ))}
                    </div>
                </div>
            )}
            </RemotePanel>

            {/* Tool selector */}
            <RemotePanel id="tool" label="Active Tool">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">Active Tool</span>
                <div className="flex gap-1.5">
                    {(["select", "trim", "slip", "cut", "draw", "zoom", "timestretch"] as const).map(tool => (
                        <button
                            key={tool}
                            onClick={() => sendCommand("editor.setTool", tool)}
                            className={cn(
                                "flex-1 py-2 rounded-lg text-[9px] capitalize transition-all cursor-pointer",
                                snapshot.activeTool === tool
                                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                    : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06]",
                            )}
                        >
                            {tool}
                        </button>
                    ))}
                </div>
            </div>
            </RemotePanel>

            {/* View mode */}
            <RemotePanel id="view" label="View & Zoom">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">View Mode</span>
                <div className="flex gap-1.5">
                    {(["waveform", "spectrogram", "split"] as const).map(v => (
                        <button key={v} onClick={() => sendCommand("editor.setView", v)}
                            className={cn("flex-1 py-2 rounded-lg text-[9px] capitalize transition-all cursor-pointer",
                                snapshot.view === v ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                    : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06]")}>
                            {v}
                        </button>
                    ))}
                </div>
                {/* Zoom */}
                <div className="flex items-center gap-2 mt-2">
                    <span className="text-[9px] text-white/25">Zoom</span>
                    <button onClick={() => sendCommand("editor.setZoom", Math.max(10, snapshot.zoom / 1.5))}
                        className="w-7 h-7 rounded-lg bg-white/[0.04] text-white/30 hover:bg-white/[0.08] text-xs flex items-center justify-center cursor-pointer">−</button>
                    <span className="text-[9px] tabular-nums text-white/40 w-12 text-center">{snapshot.zoom.toFixed(0)}px/s</span>
                    <button onClick={() => sendCommand("editor.setZoom", Math.min(2000, snapshot.zoom * 1.5))}
                        className="w-7 h-7 rounded-lg bg-white/[0.04] text-white/30 hover:bg-white/[0.08] text-xs flex items-center justify-center cursor-pointer">+</button>
                </div>
            </div>
            </RemotePanel>
        </div>
    );
}
