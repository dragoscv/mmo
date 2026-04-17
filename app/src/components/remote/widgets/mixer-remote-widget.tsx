"use client";

import { useCallback, useRef, useState } from "react";
import type { MixerSnapshot, MixerDeckSnapshot, MixerSamplerSlotSnapshot } from "@/lib/remote-sync";
import { cn } from "@/lib/utils";
import {
    Play,
    Pause,
    Headphones,
    Volume2,
    VolumeX,
    Disc,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    Repeat,
    Zap,
    Circle,
    Lock,
    Unlock,
    Settings,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MixerWidgetProps {
    snapshot: MixerSnapshot;
    sendCommand: (action: string, ...args: unknown[]) => void;
}

// ─── Knob (touch-friendly) ───────────────────────────────────────────────────

function RemoteKnob({
    value,
    min,
    max,
    color,
    label,
    onChange,
    onDoubleClick,
    centerValue,
    formatValue,
    size = 48,
}: {
    value: number;
    min: number;
    max: number;
    color: string;
    label: string;
    onChange: (v: number) => void;
    onDoubleClick?: () => void;
    centerValue?: number;
    formatValue?: (v: number) => string;
    size?: number;
}) {
    const startRef = useRef<{ y: number; val: number } | null>(null);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        startRef.current = { y: e.clientY, val: value };
    }, [value]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!startRef.current) return;
        const dy = startRef.current.y - e.clientY;
        const range = max - min;
        const delta = (dy / 120) * range;
        onChange(Math.max(min, Math.min(max, startRef.current.val + delta)));
    }, [min, max, onChange]);

    const handlePointerUp = useCallback(() => {
        startRef.current = null;
    }, []);

    const normalized = (value - min) / (max - min);
    const angle = -135 + normalized * 270;
    const displayValue = formatValue ? formatValue(value) : value.toFixed(0);

    return (
        <div className="flex flex-col items-center gap-1 select-none touch-none" onDoubleClick={onDoubleClick}>
            <svg
                width={size}
                height={size}
                viewBox="0 0 48 48"
                className="cursor-pointer"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                {/* Track */}
                <circle cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3"
                    strokeDasharray="94.25" strokeDashoffset="23.56" strokeLinecap="round"
                    transform="rotate(135 24 24)" />
                {/* Value arc */}
                <circle cx="24" cy="24" r="20" fill="none" stroke={color} strokeWidth="3"
                    strokeDasharray="94.25" strokeDashoffset={94.25 - normalized * 94.25 + 23.56} strokeLinecap="round"
                    transform="rotate(135 24 24)" opacity="0.8" />
                {/* Indicator line */}
                <line x1="24" y1="24" x2="24" y2="8" stroke={color} strokeWidth="2" strokeLinecap="round"
                    transform={`rotate(${angle} 24 24)`} />
                {/* Center dot */}
                <circle cx="24" cy="24" r="2" fill="rgba(255,255,255,0.15)" />
                {/* Value text */}
                <text x="24" y="40" textAnchor="middle" fill="rgba(255,255,255,0.4)" fontSize="7" fontFamily="monospace">
                    {displayValue}
                </text>
            </svg>
            <span className="text-[9px] text-white/30 uppercase tracking-wider">{label}</span>
        </div>
    );
}

// ─── Horizontal Fader ────────────────────────────────────────────────────────

function RemoteFader({
    value,
    min = 0,
    max = 1,
    color,
    label,
    onChange,
    onDoubleClick,
    showValue,
    className,
}: {
    value: number;
    min?: number;
    max?: number;
    color: string;
    label?: string;
    onChange: (v: number) => void;
    onDoubleClick?: () => void;
    showValue?: boolean;
    className?: string;
}) {
    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
    }, [min, max, onChange]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (e.buttons === 0) return;
        update(e);
    }, [min, max, onChange]);

    const update = useCallback((e: React.PointerEvent) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        onChange(min + x * (max - min));
    }, [min, max, onChange]);

    const pct = ((value - min) / (max - min)) * 100;

    return (
        <div className={cn("flex flex-col gap-1", className)} onDoubleClick={onDoubleClick}>
            {label && <span className="text-[9px] text-white/25 uppercase tracking-wider">{label}</span>}
            <div
                className="relative h-6 rounded-full bg-white/[0.04] cursor-pointer overflow-hidden touch-none select-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
            >
                <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
                    style={{ width: `${pct}%`, background: `linear-gradient(to right, ${color}30, ${color}70)` }} />
                <div className="absolute top-1/2 -translate-y-1/2 w-2 h-4 rounded-full bg-white shadow-sm transition-[left] duration-75"
                    style={{ left: `calc(${pct}% - 4px)` }} />
                {showValue && (
                    <span className="absolute inset-0 flex items-center justify-end px-2 text-[8px] tabular-nums text-white/25 pointer-events-none">
                        {Math.round(pct)}%
                    </span>
                )}
            </div>
        </div>
    );
}

// ─── Deck Card ───────────────────────────────────────────────────────────────

const DECK_COLORS: Record<string, string> = { A: "#f97316", B: "#06b6d4", C: "#84cc16", D: "#e879f9" };

function DeckCard({
    deck,
    side,
    sendCommand,
}: {
    deck: MixerDeckSnapshot;
    side: string;
    sendCommand: (action: string, ...args: unknown[]) => void;
}) {
    const color = DECK_COLORS[side] || "#888";

    return (
        <div className={cn(
            "rounded-2xl border p-3 transition-all",
            deck.isLoaded
                ? "bg-white/[0.02] border-white/[0.08]"
                : "bg-white/[0.01] border-white/[0.04] opacity-50",
        )}>
            {/* Track info */}
            <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/[0.06] flex items-center justify-center shrink-0 overflow-hidden">
                    {deck.artworkUrl ? (
                        <img src={deck.artworkUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                        <Disc className="w-5 h-5 text-white/15" />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white/70 truncate">{deck.trackTitle || "No track"}</div>
                    <div className="text-[10px] text-white/30 truncate">{deck.trackArtist || "—"}</div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[9px] tabular-nums font-mono" style={{ color }}>{deck.bpm.toFixed(1)} BPM</span>
                        {deck.key && <span className="text-[9px] text-white/30">{deck.key}</span>}
                    </div>
                </div>
                <div className="text-right shrink-0">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ color, backgroundColor: color + "20" }}>{side}</span>
                </div>
            </div>

            {/* Transport */}
            <div className="flex items-center gap-2 mb-3">
                <button
                    onClick={() => sendCommand("mixer.togglePlay", side)}
                    className={cn(
                        "flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl font-medium text-xs transition-all cursor-pointer",
                        deck.isPlaying
                            ? "text-black shadow-md"
                            : "bg-white/[0.04] text-white/40 hover:bg-white/[0.08]",
                    )}
                    style={deck.isPlaying ? { backgroundColor: color } : undefined}
                >
                    {deck.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    {deck.isPlaying ? "Pause" : "Play"}
                </button>

                <button
                    onClick={() => sendCommand("mixer.syncBpm", side)}
                    className="flex items-center justify-center w-10 h-10 rounded-xl bg-white/[0.04] text-white/30 hover:bg-white/[0.08] hover:text-white/50 transition-colors cursor-pointer"
                    title="Sync BPM"
                >
                    <Zap className="w-4 h-4" />
                </button>

                <button
                    onClick={() => sendCommand("mixer.toggleHeadphoneCue", side)}
                    className={cn(
                        "flex items-center justify-center w-10 h-10 rounded-xl transition-all cursor-pointer",
                        deck.headphoneCue
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-white/[0.04] text-white/30 hover:bg-white/[0.08]",
                    )}
                    title="Headphone cue"
                >
                    <Headphones className="w-4 h-4" />
                </button>
            </div>

            {/* Progress bar */}
            {deck.isLoaded && (
                <div className="h-1.5 rounded-full bg-white/[0.04] mb-3 overflow-hidden">
                    <div className="h-full rounded-full transition-[width] duration-200"
                        style={{ width: `${(deck.currentTime / Math.max(1, deck.duration)) * 100}%`, backgroundColor: color }} />
                </div>
            )}

            {/* EQ */}
            <div className="flex items-center gap-2 mb-3">
                <RemoteKnob value={deck.eqHi} min={-26} max={6} color={color} label="HI"
                    onChange={v => sendCommand("mixer.setEQ", side, "hi", Math.round(v))}
                    onDoubleClick={() => sendCommand("mixer.setEQ", side, "hi", 0)}
                    formatValue={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`} size={42} />
                <RemoteKnob value={deck.eqMid} min={-26} max={6} color={color} label="MID"
                    onChange={v => sendCommand("mixer.setEQ", side, "mid", Math.round(v))}
                    onDoubleClick={() => sendCommand("mixer.setEQ", side, "mid", 0)}
                    formatValue={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`} size={42} />
                <RemoteKnob value={deck.eqLow} min={-26} max={6} color={color} label="LOW"
                    onChange={v => sendCommand("mixer.setEQ", side, "low", Math.round(v))}
                    onDoubleClick={() => sendCommand("mixer.setEQ", side, "low", 0)}
                    formatValue={v => `${v > 0 ? "+" : ""}${v.toFixed(0)}`} size={42} />
                <RemoteKnob value={deck.filter} min={-1} max={1} color={Math.abs(deck.filter) > 0.05 ? (deck.filter < 0 ? "#eab308" : "#3b82f6") : "rgba(255,255,255,0.3)"} label="FILTER"
                    onChange={v => sendCommand("mixer.setFilter", side, v)}
                    onDoubleClick={() => sendCommand("mixer.setFilter", side, 0)}
                    formatValue={v => Math.abs(v) < 0.05 ? "OFF" : v < 0 ? "LP" : "HP"} size={42} />
            </div>

            {/* FX Controls */}
            <div className="mb-3 p-2 rounded-xl bg-white/[0.02] border border-white/[0.04]">
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[8px] text-white/20 uppercase font-bold">FX</span>
                </div>
                {/* Filter Type */}
                <div className="mb-2">
                    <span className="text-[8px] text-white/15 uppercase block mb-0.5">Filter</span>
                    <div className="flex gap-0.5 flex-wrap">
                        {(["lpf-hpf", "lpf", "hpf", "bpf", "notch", "sweep", "resonance"] as const).map(ft => (
                            <button key={ft} onClick={() => sendCommand("mixer.setFilterType", side, ft)}
                                className={cn("px-1.5 py-0.5 rounded text-[7px] cursor-pointer",
                                    deck.filterType === ft ? "bg-yellow-500/20 text-yellow-400" : "bg-white/[0.03] text-white/15 hover:bg-white/[0.06]")}>
                                {ft.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
                {/* Color FX */}
                <div className="mb-2">
                    <span className="text-[8px] text-white/15 uppercase block mb-0.5">Color FX</span>
                    <div className="flex gap-0.5 flex-wrap">
                        {(["echo", "reverb", "flanger", "phaser", "crusher", "noise", "dub-echo", "spiral", "wash", "gate", "formant", "pitch", "telephone", "rumble", "vinyl", "radio"] as const).map(fx => (
                            <button key={fx} onClick={() => sendCommand("mixer.setColorFxType", side, fx)}
                                className={cn("px-1.5 py-0.5 rounded text-[7px] cursor-pointer",
                                    deck.colorFxType === fx ? "bg-purple-500/20 text-purple-400" : "bg-white/[0.03] text-white/15 hover:bg-white/[0.06]")}>
                                {fx.toUpperCase()}
                            </button>
                        ))}
                    </div>
                    <RemoteFader value={deck.colorFx} min={0} max={1} color="#a855f7" label=""
                        onChange={v => sendCommand("mixer.setColorFx", side, v)}
                        onDoubleClick={() => sendCommand("mixer.setColorFx", side, 0)}
                        showValue className="mt-1" />
                </div>
                {/* Beat FX */}
                <div className="mb-2">
                    <span className="text-[8px] text-white/15 uppercase block mb-0.5">Beat FX</span>
                    <div className="flex gap-0.5 flex-wrap">
                        {(["delay", "echo", "reverb", "flanger", "phaser", "trans", "roll", "filter", "spiral", "noise", "crush", "ping-pong"] as const).map(bfx => (
                            <button key={bfx} onClick={() => sendCommand("mixer.setBeatFx", side, bfx)}
                                className={cn("px-1.5 py-0.5 rounded text-[7px] cursor-pointer",
                                    deck.beatFxType === bfx ? "bg-cyan-500/20 text-cyan-400" : "bg-white/[0.03] text-white/15 hover:bg-white/[0.06]")}>
                                {bfx.toUpperCase()}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                        <RemoteFader value={deck.beatFxAmount} min={0} max={1} color="#06b6d4" label=""
                            onChange={v => sendCommand("mixer.setBeatFxAmount", side, v)}
                            onDoubleClick={() => sendCommand("mixer.setBeatFxAmount", side, 0)}
                            showValue className="flex-1" />
                        <button onClick={() => sendCommand("mixer.toggleBeatFx", side)}
                            className={cn("px-2 py-1 rounded text-[8px] font-bold cursor-pointer",
                                deck.beatFxOn ? "bg-cyan-500/30 text-cyan-400" : "bg-white/[0.04] text-white/20")}>
                            {deck.beatFxOn ? "ON" : "OFF"}
                        </button>
                    </div>
                    <div className="flex gap-0.5 mt-1">
                        <span className="text-[7px] text-white/15 mr-1">Beat:</span>
                        {[1, 2, 4, 8, 16].map(div => (
                            <button key={div} onClick={() => sendCommand("mixer.setBeatFxBeatDiv", side, div)}
                                className={cn("px-1.5 py-0.5 rounded text-[7px] cursor-pointer",
                                    deck.beatFxBeatDiv === div ? "bg-cyan-500/20 text-cyan-400" : "bg-white/[0.03] text-white/15 hover:bg-white/[0.06]")}>
                                1/{div}
                            </button>
                        ))}
                    </div>
                </div>
                {/* Key Controls */}
                <div className="flex items-center gap-2">
                    <button onClick={() => sendCommand("mixer.setKeyLock", side, !deck.keyLock)}
                        className={cn("flex items-center gap-1 px-2 py-1 rounded text-[8px] cursor-pointer",
                            deck.keyLock ? "bg-green-500/20 text-green-400" : "bg-white/[0.04] text-white/20")}>
                        {deck.keyLock ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                        Key Lock
                    </button>
                    <div className="flex items-center gap-0.5">
                        <button onClick={() => sendCommand("mixer.setKeyShift", side, deck.keyShift - 1)}
                            className="w-6 h-6 rounded bg-white/[0.04] text-white/20 text-[9px] flex items-center justify-center cursor-pointer hover:bg-white/[0.08]">-</button>
                        <span className="text-[9px] text-white/30 w-8 text-center tabular-nums">{deck.keyShift > 0 ? `+${deck.keyShift}` : deck.keyShift}</span>
                        <button onClick={() => sendCommand("mixer.setKeyShift", side, deck.keyShift + 1)}
                            className="w-6 h-6 rounded bg-white/[0.04] text-white/20 text-[9px] flex items-center justify-center cursor-pointer hover:bg-white/[0.08]">+</button>
                    </div>
                </div>
            </div>

            {/* Volume fader */}
            <RemoteFader
                value={deck.volume}
                min={0} max={2}
                color={color}
                label="Volume"
                onChange={v => sendCommand("mixer.setVolume", side, v)}
                onDoubleClick={() => sendCommand("mixer.setVolume", side, 1)}
                showValue
            />

            {/* Hot cues */}
            {deck.hotCues.some(c => c !== null) && (
                <div className="flex gap-1 mt-3">
                    {deck.hotCues.map((cue, i) => (
                        <button
                            key={i}
                            onClick={() => cue !== null && sendCommand("mixer.jumpHotCue", side, i)}
                            disabled={cue === null}
                            className={cn(
                                "flex-1 py-1.5 rounded-lg text-[9px] font-bold transition-all cursor-pointer",
                                cue !== null
                                    ? "bg-white/10 text-white/60 hover:bg-white/15"
                                    : "bg-white/[0.02] text-white/10",
                            )}
                        >
                            {i + 1}
                        </button>
                    ))}
                </div>
            )}

            {/* Beat jump */}
            <div className="flex items-center gap-1 mt-2">
                {[1, 4, 16].map(beats => (
                    <button key={`back-${beats}`} onClick={() => sendCommand("mixer.beatJump", side, -beats)}
                        className="flex-1 py-1.5 rounded-lg bg-white/[0.03] text-[9px] text-white/30 hover:bg-white/[0.06] transition-colors cursor-pointer">
                        ◀{beats}
                    </button>
                ))}
                {[1, 4, 16].map(beats => (
                    <button key={`fwd-${beats}`} onClick={() => sendCommand("mixer.beatJump", side, beats)}
                        className="flex-1 py-1.5 rounded-lg bg-white/[0.03] text-[9px] text-white/30 hover:bg-white/[0.06] transition-colors cursor-pointer">
                        {beats}▶
                    </button>
                ))}
            </div>
        </div>
    );
}

// ─── Main Mixer Widget ───────────────────────────────────────────────────────

export function MixerRemoteWidget({ snapshot, sendCommand }: MixerWidgetProps) {
    const is4 = snapshot.deckMode === "4deck";
    const decks = is4
        ? [
            { side: "A", deck: snapshot.deckA },
            { side: "B", deck: snapshot.deckB },
            { side: "C", deck: snapshot.deckC },
            { side: "D", deck: snapshot.deckD },
        ]
        : [
            { side: "A", deck: snapshot.deckA },
            { side: "B", deck: snapshot.deckB },
        ];

    return (
        <div className="px-4 py-3 flex flex-col gap-4">
            {/* Master controls */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-3 mb-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/25">Master</span>
                    {snapshot.isRecording && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500/20 text-[9px] font-medium text-red-400">
                            <Circle className="w-2 h-2 fill-red-400" /> REC
                        </span>
                    )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                    <RemoteFader
                        value={snapshot.masterVolume}
                        min={0} max={1.5}
                        color="#fff"
                        label="Master Vol"
                        onChange={v => sendCommand("mixer.setMasterVolume", v)}
                        onDoubleClick={() => sendCommand("mixer.setMasterVolume", 1)}
                        showValue
                    />
                    <RemoteFader
                        value={snapshot.headphoneVolume}
                        min={0} max={1.5}
                        color="#eab308"
                        label="Headphone"
                        onChange={v => sendCommand("mixer.setHeadphoneVolume", v)}
                        onDoubleClick={() => sendCommand("mixer.setHeadphoneVolume", 1)}
                        showValue
                    />
                    <RemoteFader
                        value={snapshot.headphoneMix}
                        min={0} max={1}
                        color="#06b6d4"
                        label="Cue/Master Mix"
                        onChange={v => sendCommand("mixer.setHeadphoneMix", v)}
                        onDoubleClick={() => sendCommand("mixer.setHeadphoneMix", 0.5)}
                        showValue
                    />
                </div>

                {/* Crossfader */}
                <div className="mt-3">
                    <RemoteFader
                        value={snapshot.crossfader}
                        min={0} max={1}
                        color="rgba(255,255,255,0.5)"
                        label="Crossfader"
                        onChange={v => sendCommand("mixer.setCrossfader", v)}
                        onDoubleClick={() => sendCommand("mixer.setCrossfader", 0.5)}
                    />
                </div>

                {/* Recording toggle */}
                <button
                    onClick={() => sendCommand("mixer.toggleRecording")}
                    className={cn(
                        "mt-3 w-full py-2 rounded-xl text-xs font-medium transition-all cursor-pointer",
                        snapshot.isRecording
                            ? "bg-red-500/20 text-red-400 border border-red-500/30"
                            : "bg-white/[0.03] text-white/30 hover:bg-white/[0.06] border border-white/[0.06]",
                    )}
                >
                    {snapshot.isRecording ? `⏺ Recording — ${Math.floor(snapshot.recordingDuration / 1000)}s` : "⏺ Start Recording"}
                </button>
            </div>

            {/* Deck cards */}
            <div className={cn("grid gap-3", is4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
                {decks.map(({ side, deck }) => (
                    <DeckCard key={side} deck={deck} side={side} sendCommand={sendCommand} />
                ))}
            </div>

            {/* Sampler */}
            {snapshot.samplerSlots.length > 0 && (
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">Sampler</span>
                    <div className="grid grid-cols-4 gap-1.5">
                        {snapshot.samplerSlots.map((slot, i) => (
                            <button key={slot.id}
                                onPointerDown={() => slot.hasAudio && sendCommand("mixer.triggerSampler", i)}
                                onPointerUp={() => slot.isPlaying && sendCommand("mixer.stopSampler", i)}
                                onContextMenu={e => { e.preventDefault(); sendCommand("mixer.toggleSamplerLoop", i); }}
                                className={cn(
                                    "relative flex flex-col items-center justify-center py-3 rounded-xl border transition-all cursor-pointer select-none touch-none",
                                    slot.isPlaying ? "bg-pink-500/20 border-pink-500/30 text-pink-400"
                                        : slot.hasAudio ? "bg-white/[0.04] border-white/[0.08] text-white/40 hover:bg-white/[0.08]"
                                            : "bg-white/[0.01] border-white/[0.04] text-white/10",
                                )}>
                                <span className="text-[10px] font-bold">{i + 1}</span>
                                <span className="text-[7px] truncate max-w-full px-1">{slot.name || "—"}</span>
                                {slot.isLooping && (
                                    <Repeat className="absolute top-1 right-1 w-2.5 h-2.5 text-pink-400/50" />
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Global Settings */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">
                    <Settings className="w-3 h-3 inline mr-1" />Settings
                </span>

                {/* Crossfader Curve */}
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/25 w-20">XF Curve</span>
                    <div className="flex gap-0.5 flex-1">
                        {(["linear", "smooth", "sharp"] as const).map(c => (
                            <button key={c} onClick={() => sendCommand("mixer.setCrossfaderCurve", c)}
                                className={cn("flex-1 py-1 rounded text-[8px] cursor-pointer capitalize",
                                    snapshot.crossfaderCurve === c ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {c}
                            </button>
                        ))}
                    </div>
                </div>

                {/* EQ Mode */}
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/25 w-20">EQ Mode</span>
                    <div className="flex gap-0.5 flex-1">
                        {(["eq", "isolator"] as const).map(m => (
                            <button key={m} onClick={() => sendCommand("mixer.setEQMode", m)}
                                className={cn("flex-1 py-1 rounded text-[8px] cursor-pointer capitalize",
                                    snapshot.eqMode === m ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {m}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Tempo Range */}
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/25 w-20">Tempo ±</span>
                    <div className="flex gap-0.5 flex-1">
                        {[6, 10, 16, 25].map(r => (
                            <button key={r} onClick={() => sendCommand("mixer.setTempoRange", r)}
                                className={cn("flex-1 py-1 rounded text-[8px] cursor-pointer",
                                    snapshot.tempoRange === r ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                ±{r}%
                            </button>
                        ))}
                    </div>
                </div>

                {/* Deck Mode */}
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/25 w-20">Decks</span>
                    <div className="flex gap-0.5 flex-1">
                        {(["2deck", "4deck"] as const).map(m => (
                            <button key={m} onClick={() => sendCommand("mixer.setDeckMode", m)}
                                className={cn("flex-1 py-1 rounded text-[8px] cursor-pointer",
                                    snapshot.deckMode === m ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {m === "2deck" ? "2 Decks" : "4 Decks"}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Automix */}
                <button onClick={() => sendCommand("mixer.toggleAutomix")}
                    className={cn("w-full py-1.5 rounded-xl text-[9px] font-medium transition-all cursor-pointer",
                        snapshot.automixEnabled ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                            : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06] border border-white/[0.06]")}>
                    {snapshot.automixEnabled ? "Automix ON" : "Automix OFF"}
                </button>
            </div>
        </div>
    );
}
