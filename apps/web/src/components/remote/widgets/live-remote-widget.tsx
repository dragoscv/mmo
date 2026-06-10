"use client";

import { useRef } from "react";
import type { LiveSnapshot } from "@/lib/remote-sync";
import { cn } from "@/lib/utils";
import {
    Mic, MicOff, Square, Circle, Play, Pause, Volume2, VolumeX,
    Music, Headphones, Repeat, Trash2, Activity, Power, Sparkles,
} from "lucide-react";
import { RemotePanel } from "@/components/remote/remote-visibility";
import { LiveRecommendationsWidget } from "@/components/live/live-recommendations-widget";
import { LiveVisualizerWidget } from "@/components/live/live-visualizer-widget";

interface Props {
    snapshot: LiveSnapshot;
    sendCommand: (action: string, ...args: unknown[]) => void;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALES = ["Chromatic", "Major", "Minor", "Dorian", "Mixolydian", "Phrygian", "Pent. Maj", "Pent. Min", "Blues"];

// Parse a note string like "A4" / "C#3" / "—" into a midi-ish index (octave * 12 + pc).
// Used by the realtime coach widget on the remote (which only receives the note label).
function noteNameToIndex(note: string | undefined): number {
    if (!note || note.length < 2) return -1;
    const m = /^([A-G])([#b]?)(-?\d+)$/.exec(note);
    if (!m) return -1;
    const baseMap: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const base = baseMap[m[1]];
    if (base === undefined) return -1;
    const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
    const octave = parseInt(m[3], 10);
    return (octave + 1) * 12 + base + accidental;
}

// ─── Atomic ──────────────────────────────────────────────────────────────────

function MiniKnob({ value, min, max, color, label, onChange, onDoubleClick, format }: {
    value: number; min: number; max: number; color: string; label: string;
    onChange: (v: number) => void; onDoubleClick?: () => void; format?: (v: number) => string;
}) {
    const startRef = useRef<{ y: number; val: number } | null>(null);
    const normalized = (value - min) / (max - min);
    const angle = -135 + normalized * 270;
    return (
        <div className="flex flex-col items-center gap-0.5 select-none touch-none" onDoubleClick={onDoubleClick}>
            <svg width={36} height={36} viewBox="0 0 48 48" className="cursor-pointer"
                onPointerDown={e => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture(e.pointerId); startRef.current = { y: e.clientY, val: value }; }}
                onPointerMove={e => { if (!startRef.current) return; const dy = startRef.current.y - e.clientY; const delta = (dy / 100) * (max - min); onChange(Math.max(min, Math.min(max, startRef.current.val + delta))); }}
                onPointerUp={() => { startRef.current = null; }}>
                <circle cx="24" cy="24" r="18" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3"
                    strokeDasharray="84.82" strokeDashoffset="21.21" strokeLinecap="round" transform="rotate(135 24 24)" />
                <circle cx="24" cy="24" r="18" fill="none" stroke={color} strokeWidth="3"
                    strokeDasharray="84.82" strokeDashoffset={84.82 - normalized * 84.82 + 21.21} strokeLinecap="round"
                    transform="rotate(135 24 24)" />
                <line x1="24" y1="24" x2="24" y2="10" stroke={color} strokeWidth="2" strokeLinecap="round"
                    transform={`rotate(${angle} 24 24)`} />
            </svg>
            <span className="text-[8px] text-white/55 tabular-nums leading-none">{format ? format(value) : value.toFixed(2)}</span>
            <span className="text-[8px] text-white/25 uppercase tracking-wider leading-none">{label}</span>
        </div>
    );
}

function MeterBar({ peakL, peakR, isLimiting }: { peakL: number; peakR: number; isLimiting?: boolean }) {
    return (
        <div className={cn("flex flex-col gap-px p-1 rounded-lg bg-black/40 border", isLimiting ? "border-red-500/50" : "border-white/[0.04]")}>
            {[peakL, peakR].map((p, i) => (
                <div key={i} className="h-1.5 w-16 bg-white/[0.04] rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-[width] duration-75"
                        style={{
                            width: `${Math.min(100, p * 100)}%`,
                            background: p > 0.85 ? "#ef4444" : p > 0.6 ? "#eab308" : "#10b981",
                        }} />
                </div>
            ))}
        </div>
    );
}

function fmt(s: number) {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60); const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtRec(ms: number) {
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─── Widget ──────────────────────────────────────────────────────────────────

export function LiveRemoteWidget({ snapshot: s, sendCommand }: Props) {
    const send = sendCommand;

    return (
        <div className="flex flex-col gap-3 p-3 pb-8">
            {/* Master / Transport */}
            <RemotePanel id="transport" label="Master & Transport">
                <div className="rounded-2xl border border-rose-500/20 bg-gradient-to-br from-rose-500/[0.05] to-transparent p-3 space-y-3">
                    <div className="flex items-center gap-2">
                        <div className="w-9 h-9 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
                            <Mic className="w-4 h-4 text-rose-400" />
                        </div>
                        <div className="flex-1">
                            <div className="text-[10px] text-rose-400/60 font-bold uppercase tracking-wider">Live</div>
                            <div className="text-xs font-medium text-white/70">Performance</div>
                        </div>
                        <MeterBar peakL={s.masterPeakL} peakR={s.masterPeakR} isLimiting={s.isLimiting} />
                    </div>

                    <div className="flex items-center gap-2">
                        <button onClick={() => send("live.toggleRecording")}
                            className={cn("flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer",
                                s.isRecording
                                    ? "bg-red-500/25 text-red-400 border border-red-500/40 shadow-[0_0_10px_rgba(239,68,68,0.25)]"
                                    : "bg-white/[0.04] text-white/50 hover:bg-red-500/10 border border-white/[0.06]")}>
                            <Circle className={cn("w-3.5 h-3.5", s.isRecording && "fill-red-400 animate-pulse")} />
                            {s.isRecording ? fmtRec(s.recordingDuration) : "Record"}
                        </button>
                        <button onClick={() => send("live.toggleMetronome")}
                            className={cn("flex items-center justify-center w-12 h-11 rounded-xl border cursor-pointer transition-all",
                                s.isMetronomeOn
                                    ? "bg-blue-500/20 text-blue-400 border-blue-500/30"
                                    : "bg-white/[0.04] text-white/40 border-white/[0.06]")}>
                            <span className={cn("text-base", s.isMetronomeOn && "animate-pulse")}>🔔</span>
                        </button>
                        <button onClick={() => send("live.tap")}
                            className="px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 active:scale-95 cursor-pointer text-xs font-bold uppercase">
                            Tap
                        </button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="flex-1 px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-2">
                            <input type="number" min={20} max={300} step={0.1} value={s.tempo.toFixed(1)}
                                onChange={e => send("live.setTempo", parseFloat(e.target.value) || 120)}
                                className="text-lg font-bold text-amber-400 tabular-nums bg-transparent w-16 focus:outline-none" />
                            <span className="text-[9px] text-white/30 uppercase tracking-wider">BPM</span>
                        </div>
                        <div className="px-3 py-1.5 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center gap-2">
                            <span className="text-[9px] text-white/30 uppercase">Key</span>
                            <span className="text-base font-bold text-rose-400">{NOTE_NAMES[s.keyIndex]}</span>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <Volume2 className="w-3.5 h-3.5 text-white/30" />
                        <input type="range" min={0} max={2} step={0.01} value={s.masterVolume}
                            onChange={e => send("live.setMasterVolume", parseFloat(e.target.value))}
                            className="flex-1 accent-rose-500" />
                        <span className="text-[10px] text-white/40 tabular-nums w-8">{Math.round(s.masterVolume * 100)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Headphones className="w-3.5 h-3.5 text-white/30" />
                        <input type="range" min={0} max={2} step={0.01} value={s.monitorVolume}
                            onChange={e => send("live.setMonitorVolume", parseFloat(e.target.value))}
                            className="flex-1 accent-cyan-500" />
                    </div>
                </div>
            </RemotePanel>

            {/* Recommendations */}
            <RemotePanel id="recommendations" label="Realtime Coach">
                <LiveRecommendationsWidget
                    compact
                    keyIndex={s.keyIndex}
                    scaleIndex={s.scaleIndex}
                    voiceActive={!!s.voice?.isActive}
                    snapshot={s.voice ? {
                        pitch: {
                            note: s.voice.pitchNote,
                            cents: s.voice.pitchCents,
                            confidence: s.voice.pitchConfidence,
                            frequency: s.voice.pitchConfidence > 0.5 ? 1 : 0,
                            noteIndex: noteNameToIndex(s.voice.pitchNote),
                        },
                        rms: s.voice.rms,
                        peakL: s.voice.peakL,
                        peakR: s.voice.peakR,
                    } : null}
                />
            </RemotePanel>

            {/* Visualizer (renders from broadcast spectrum/waveform) */}
            <RemotePanel id="visualizer" label="Visualizer">
                <div className="h-[280px]">
                    <LiveVisualizerWidget
                        remoteSnapshot={{
                            spectrum: s.spectrum,
                            waveform: s.waveform,
                            peakL: s.masterPeakL,
                            peakR: s.masterPeakR,
                            isLimiting: s.isLimiting,
                        }}
                        className="!h-full"
                    />
                </div>
            </RemotePanel>

            {/* Voice */}
            <RemotePanel id="voice" label="Voice & FX">
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-3">
                    <div className="flex items-center gap-2">
                        {s.voice?.isActive ? <Mic className="w-4 h-4 text-rose-400" /> : <MicOff className="w-4 h-4 text-white/25" />}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400/70">Voice</span>
                        <button onClick={() => send(s.voice?.isActive ? "live.voiceStop" : "live.voiceStart")}
                            className={cn("ml-auto px-3 py-1 rounded-lg text-[10px] font-bold uppercase cursor-pointer",
                                s.voice?.isActive
                                    ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                                    : "bg-white/[0.04] text-white/40 border border-white/[0.06]")}>
                            {s.voice?.isActive ? "On" : "Off"}
                        </button>
                    </div>
                    {s.voice && (
                        <>
                            <div className="flex items-center justify-around gap-2">
                                <MiniKnob value={s.voice.inputGain} min={0} max={2} color="#f43f5e" label="In"
                                    onChange={v => send("live.voiceSetInputGain", v)} onDoubleClick={() => send("live.voiceSetInputGain", 1)}
                                    format={v => `${Math.round(v * 100)}%`} />
                                <MiniKnob value={s.voice.outputGain} min={0} max={2} color="#f43f5e" label="Out"
                                    onChange={v => send("live.voiceSetOutputGain", v)} onDoubleClick={() => send("live.voiceSetOutputGain", 0.85)}
                                    format={v => `${Math.round(v * 100)}%`} />
                                <div className="flex flex-col gap-1">
                                    <div className="text-[9px] text-white/30 uppercase">Pitch</div>
                                    <div className="text-base font-bold tabular-nums" style={{
                                        color: s.voice.pitchConfidence > 0.5 && Math.abs(s.voice.pitchCents) <= 8 ? "#10b981" : "#eab308",
                                    }}>
                                        {s.voice.pitchNote || "—"}
                                    </div>
                                </div>
                            </div>
                            {s.voice.chain.length > 0 && (
                                <div className="space-y-1 pt-2 border-t border-white/[0.04]">
                                    <div className="text-[9px] text-white/30 uppercase tracking-wider">FX Chain ({s.voice.chain.length})</div>
                                    {s.voice.chain.map(fx => (
                                        <div key={fx.id} className={cn("flex items-center gap-1.5 px-2 py-1 rounded-lg",
                                            fx.enabled ? "bg-rose-500/[0.06] border border-rose-500/15" : "bg-white/[0.02] border border-white/[0.04] opacity-50")}>
                                            <button onClick={() => send("live.voiceToggleEffect", fx.id)}
                                                className={cn("w-5 h-5 rounded flex items-center justify-center cursor-pointer",
                                                    fx.enabled ? "bg-rose-500/25 text-rose-400" : "bg-white/5 text-white/20")}>
                                                <Power className="w-2.5 h-2.5" />
                                            </button>
                                            <span className="text-[10px] text-white/60 flex-1 capitalize truncate">
                                                {fx.type.replace(/([A-Z])/g, " $1").trim()}
                                            </span>
                                            <button onClick={() => send("live.voiceRemoveEffect", fx.id)}
                                                className="text-white/15 hover:text-red-400/60 cursor-pointer">
                                                <Trash2 className="w-3 h-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
            </RemotePanel>

            {/* Backing Track */}
            <RemotePanel id="backing" label="Backing Track">
                {s.backingLoaded && (
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
                        <div className="flex items-center gap-2">
                            <Music className="w-4 h-4 text-blue-400/70" />
                            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400/70">Backing</span>
                            <span className="ml-auto text-[10px] text-white/40 tabular-nums">{fmt(s.backingPosition)} / {fmt(s.backingDuration)}</span>
                        </div>
                        <div className="text-[11px] text-white/60 truncate">{s.backingName}</div>
                        <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden cursor-pointer"
                            onPointerDown={e => {
                                const r = e.currentTarget.getBoundingClientRect();
                                send("live.backingSeek", ((e.clientX - r.left) / r.width) * s.backingDuration);
                            }}>
                            <div className="h-full bg-blue-500/60 rounded-full transition-[width] duration-100"
                                style={{ width: `${s.backingDuration > 0 ? (s.backingPosition / s.backingDuration) * 100 : 0}%` }} />
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button onClick={() => send("live.backingToggle")}
                                className={cn("flex-1 flex items-center justify-center gap-1 py-2 rounded-lg cursor-pointer text-[11px] font-medium",
                                    s.backingIsPlaying
                                        ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                        : "bg-white/[0.04] text-white/40 border border-white/[0.06]")}>
                                {s.backingIsPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                                {s.backingIsPlaying ? "Pause" : "Play"}
                            </button>
                            <button onClick={() => send("live.backingStop")}
                                className="w-8 h-8 rounded-lg bg-white/[0.04] text-white/40 flex items-center justify-center cursor-pointer">
                                <Square className="w-3 h-3" />
                            </button>
                            <button onClick={() => send("live.setBackingLoop", !s.backingLoopActive)}
                                className={cn("w-8 h-8 rounded-lg cursor-pointer flex items-center justify-center",
                                    s.backingLoopActive ? "bg-purple-500/20 text-purple-400" : "bg-white/[0.04] text-white/40")}>
                                <Repeat className="w-3 h-3" />
                            </button>
                        </div>
                        <div className="flex items-center justify-around gap-2 pt-1">
                            <MiniKnob value={s.backingVolume} min={0} max={2} color="#3b82f6" label="Vol"
                                onChange={v => send("live.setBackingVolume", v)} onDoubleClick={() => send("live.setBackingVolume", 0.85)}
                                format={v => `${Math.round(v * 100)}%`} />
                            <MiniKnob value={s.backingTempoRatio} min={0.5} max={1.5} color="#3b82f6" label="Tempo"
                                onChange={v => send("live.setBackingTempoRatio", v)} onDoubleClick={() => send("live.setBackingTempoRatio", 1)}
                                format={v => `${Math.round(v * 100)}%`} />
                            <MiniKnob value={s.backingPitchSemis} min={-12} max={12} color="#3b82f6" label="Pitch"
                                onChange={v => send("live.setBackingPitchSemis", v)} onDoubleClick={() => send("live.setBackingPitchSemis", 0)}
                                format={v => `${v > 0 ? "+" : ""}${Math.round(v)}`} />
                        </div>
                    </div>
                )}
            </RemotePanel>

            {/* Looper */}
            <RemotePanel id="looper" label="Looper">
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                        <Repeat className="w-4 h-4 text-purple-400/70" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400/70">Looper</span>
                        <button onClick={() => send("live.stopAllLoopers")}
                            className="ml-auto text-[9px] px-2 py-0.5 rounded bg-white/[0.04] text-white/40 cursor-pointer">
                            Stop All
                        </button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                        {s.loopers.map(loop => {
                            const color = loop.state === "recording" ? "#ef4444"
                                : loop.state === "playing" ? "#10b981"
                                    : loop.state === "stopped" ? "#eab308" : "#6b7280";
                            return (
                                <div key={loop.id} className={cn("rounded-xl border p-1.5",
                                    loop.state === "recording" ? "border-red-500/40 bg-red-500/5"
                                        : loop.state === "playing" ? "border-emerald-500/30 bg-emerald-500/5"
                                            : "border-white/[0.06] bg-white/[0.02]")}>
                                    <div className="flex items-center gap-1.5 mb-1">
                                        <div className="w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center"
                                            style={{ backgroundColor: `${color}25`, color }}>{loop.id + 1}</div>
                                        <span className="text-[9px] uppercase font-bold flex-1" style={{ color }}>{loop.state}</span>
                                        {loop.durationBeats > 0 && (
                                            <button onClick={() => send("live.clearLooper", loop.id)} className="text-white/15 cursor-pointer">
                                                <Trash2 className="w-2.5 h-2.5" />
                                            </button>
                                        )}
                                    </div>
                                    <button onClick={() => send("live.toggleLooper", loop.id)}
                                        className={cn("w-full py-1.5 rounded-lg text-[10px] font-bold uppercase cursor-pointer",
                                            loop.state === "empty" ? "bg-white/[0.04] text-white/40"
                                                : loop.state === "recording" ? "bg-red-500/25 text-red-400 animate-pulse"
                                                    : loop.state === "playing" ? "bg-emerald-500/25 text-emerald-400"
                                                        : "bg-amber-500/15 text-amber-400")}>
                                        {loop.state === "empty" ? "Rec" : loop.state === "recording" ? "Stop" : loop.state === "playing" ? "Pause" : "Play"}
                                    </button>
                                    <div className="flex items-center gap-1 mt-1">
                                        <button onClick={() => send("live.toggleLooperMute", loop.id)} className="cursor-pointer">
                                            {loop.muted ? <VolumeX className="w-3 h-3 text-white/30" /> : <Volume2 className="w-3 h-3 text-white/40" />}
                                        </button>
                                        <input type="range" min={0} max={2} step={0.01} value={loop.volume}
                                            onChange={e => send("live.setLooperVolume", loop.id, parseFloat(e.target.value))}
                                            className="flex-1 accent-purple-500" />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </RemotePanel>

            {/* Pads */}
            <RemotePanel id="pads" label="Pads">
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-yellow-400/70" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-400/70">Pads</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                        {s.pads.map(pad => (
                            <button key={pad.id}
                                onClick={() => pad.hasAudio && send("live.triggerPad", pad.id)}
                                disabled={!pad.hasAudio}
                                className={cn(
                                    "aspect-square rounded-xl border transition-all duration-150 flex flex-col items-center justify-center gap-0.5 cursor-pointer active:scale-95 relative",
                                    pad.hasAudio ? (pad.isPlaying ? "shadow-[0_0_10px_var(--c)]" : "") : "border-dashed border-white/10 opacity-40"
                                )}
                                style={pad.hasAudio ? {
                                    "--c": pad.color,
                                    backgroundColor: pad.isPlaying ? `${pad.color}30` : `${pad.color}12`,
                                    borderColor: pad.isPlaying ? pad.color : `${pad.color}40`,
                                } as React.CSSProperties : undefined}>
                                {pad.hasAudio ? (
                                    <>
                                        <span className="text-[9px] font-bold uppercase truncate max-w-full px-1" style={{ color: pad.color }}>{pad.name}</span>
                                        {pad.loop && <Repeat className="w-2 h-2 absolute top-1 right-1" style={{ color: pad.color }} />}
                                    </>
                                ) : (
                                    <span className="text-[9px] text-white/20">{pad.id + 1}</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            </RemotePanel>

            {/* Tuner */}
            <RemotePanel id="tuner" label="Tuner">
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                    <div className="flex items-center gap-2 mb-2">
                        <Activity className="w-4 h-4 text-emerald-400/70" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400/70">Tuner</span>
                    </div>
                    <div className="text-center">
                        <div className="text-3xl font-bold tabular-nums"
                            style={{
                                color: s.tunerConfidence > 0.5 && Math.abs(s.tunerCents) <= 8 ? "#10b981"
                                    : Math.abs(s.tunerCents) > 25 ? "#ef4444"
                                        : s.tunerConfidence > 0.3 ? "#eab308" : "rgba(255,255,255,0.15)",
                            }}>
                            {s.tunerNote || "—"}
                        </div>
                        <div className="text-[9px] text-white/30 tabular-nums">
                            {s.tunerFrequency > 0 ? `${s.tunerFrequency.toFixed(1)} Hz` : "—"} · {s.tunerCents > 0 ? "+" : ""}{s.tunerCents}¢
                        </div>
                    </div>
                </div>
            </RemotePanel>

            {/* Key & Scale */}
            <RemotePanel id="keyScale" label="Key & Scale">
                <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 space-y-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-cyan-400/70">Key & Scale</div>
                    <div className="grid grid-cols-12 gap-px">
                        {NOTE_NAMES.map((n, i) => (
                            <button key={i} onClick={() => send("live.setKey", i)}
                                className={cn("py-1 text-[9px] cursor-pointer rounded",
                                    n.includes("#") ? "bg-gray-900" : "bg-white/[0.03]",
                                    s.keyIndex === i ? "!bg-cyan-500/25 text-cyan-300" : "text-white/40")}>
                                {n}
                            </button>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {SCALES.map((name, i) => (
                            <button key={i} onClick={() => send("live.setScale", i)}
                                className={cn("px-2 py-0.5 rounded text-[9px] cursor-pointer",
                                    s.scaleIndex === i ? "bg-cyan-500/20 text-cyan-300" : "bg-white/[0.03] text-white/35")}>
                                {name}
                            </button>
                        ))}
                    </div>
                </div>
            </RemotePanel>
        </div>
    );
}
