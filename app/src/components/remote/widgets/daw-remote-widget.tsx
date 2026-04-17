"use client";

import { useCallback, useState, useRef } from "react";
import type { DAWSnapshot, DAWTrackSnapshot, DAWSynthSnapshot, DAWStepSeqSnapshot, DAWInsertSnapshot, VPSnapshot } from "@/lib/remote-sync";
import { cn } from "@/lib/utils";
import {
    Play,
    Pause,
    Square,
    Circle,
    Mic,
    MicOff,
    Volume2,
    VolumeX,
    Headphones,
    Undo2,
    Redo2,
    ChevronDown,
    ChevronRight,
    Sliders,
    Music,
    Grid3X3,
    Trash2,
    Sparkles,
    Power,
    Plus,
} from "lucide-react";

interface DAWWidgetProps {
    snapshot: DAWSnapshot;
    sendCommand: (action: string, ...args: unknown[]) => void;
}

// ─── Shared knob for synth/effects ───────────────────────────────────────────

function MiniKnob({
    value, min, max, color, label, onChange, onDoubleClick, step,
}: {
    value: number; min: number; max: number; color: string; label: string;
    onChange: (v: number) => void; onDoubleClick?: () => void; step?: number;
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
                    transform="rotate(135 24 24)" opacity="0.7" />
                <line x1="24" y1="24" x2="24" y2="10" stroke={color} strokeWidth="2" strokeLinecap="round"
                    transform={`rotate(${angle} 24 24)`} />
                <text x="24" y="38" textAnchor="middle" fill="rgba(255,255,255,0.35)" fontSize="7" fontFamily="monospace">
                    {value < 10 ? value.toFixed(2) : value.toFixed(value < 100 ? 1 : 0)}
                </text>
            </svg>
            <span className="text-[8px] text-white/25 uppercase tracking-wider leading-none">{label}</span>
        </div>
    );
}

// ─── Level Meter ─────────────────────────────────────────────────────────────

function LevelMeter({ peakL, peakR, color }: { peakL: number; peakR: number; color: string }) {
    return (
        <div className="flex items-end gap-px h-6 w-3">
            <div className="flex-1 bg-white/[0.04] rounded-full overflow-hidden relative">
                <div className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
                    style={{ height: `${Math.min(100, peakL * 100)}%`, backgroundColor: color }} />
            </div>
            <div className="flex-1 bg-white/[0.04] rounded-full overflow-hidden relative">
                <div className="absolute bottom-0 left-0 right-0 rounded-full transition-[height] duration-75"
                    style={{ height: `${Math.min(100, peakR * 100)}%`, backgroundColor: color }} />
            </div>
        </div>
    );
}

// ─── Collapsible Section ─────────────────────────────────────────────────────

function Section({ title, icon, children, defaultOpen = false, color = "white" }: {
    title: string; icon?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; color?: string;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02]">
            <button onClick={() => setOpen(!open)}
                className="w-full flex items-center gap-2 p-3 cursor-pointer hover:bg-white/[0.02] rounded-2xl transition-colors">
                {icon}
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25">{title}</span>
                {open ? <ChevronDown className="w-3 h-3 text-white/20 ml-auto" /> : <ChevronRight className="w-3 h-3 text-white/20 ml-auto" />}
            </button>
            {open && <div className="px-3 pb-3 pt-0">{children}</div>}
        </div>
    );
}

// ─── Track Strip ─────────────────────────────────────────────────────────────

function TrackStrip({ track, sendCommand, isSelected, onSelect }: {
    track: DAWTrackSnapshot; sendCommand: DAWWidgetProps["sendCommand"]; isSelected: boolean; onSelect: () => void;
}) {
    return (
        <div className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-xl border transition-all cursor-pointer",
            track.muted ? "bg-white/[0.01] border-white/[0.04] opacity-50"
                : isSelected ? "bg-white/[0.04] border-white/[0.10]"
                    : "bg-white/[0.02] border-white/[0.06]",
        )} onClick={onSelect}>
            <div className="w-2 h-full min-h-[32px] rounded-full shrink-0" style={{ backgroundColor: track.color }} />
            <div className="flex-1 min-w-0">
                <div className="text-[11px] font-medium text-white/60 truncate">{track.name}</div>
                <div className="text-[9px] text-white/25 uppercase">{track.type}</div>
            </div>
            <LevelMeter peakL={track.peakL} peakR={track.peakR} color={track.color} />
            <div className="w-20">
                <div className="relative h-5 rounded-full bg-white/[0.04] cursor-pointer overflow-hidden touch-none select-none"
                    onPointerDown={e => { e.preventDefault(); e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); const rect = e.currentTarget.getBoundingClientRect(); sendCommand("daw.setTrackVolume", track.id, Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))); }}
                    onPointerMove={e => { if (e.buttons === 0) return; e.stopPropagation(); const rect = e.currentTarget.getBoundingClientRect(); sendCommand("daw.setTrackVolume", track.id, Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))); }}
                    onDoubleClick={e => { e.stopPropagation(); sendCommand("daw.setTrackVolume", track.id, 0.8); }}
                    title={`Volume: ${Math.round(track.volume * 100)}%`}>
                    <div className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75"
                        style={{ width: `${track.volume * 100}%`, background: `linear-gradient(to right, ${track.color}30, ${track.color}70)` }} />
                    <div className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3.5 rounded-full bg-white shadow-sm transition-[left] duration-75"
                        style={{ left: `calc(${track.volume * 100}% - 3px)` }} />
                </div>
            </div>
            <button onClick={e => { e.stopPropagation(); sendCommand("daw.setTrackPan", track.id, 0); }}
                className="text-[8px] text-white/20 w-6 text-center cursor-pointer"
                title={`Pan: ${track.pan === 0 ? "C" : track.pan < 0 ? `L${Math.round(Math.abs(track.pan) * 100)}` : `R${Math.round(track.pan * 100)}`}`}>
                {track.pan === 0 ? "C" : track.pan < 0 ? `L${Math.round(Math.abs(track.pan) * 100)}` : `R${Math.round(track.pan * 100)}`}
            </button>
            <button onClick={e => { e.stopPropagation(); sendCommand("daw.toggleTrackMute", track.id); }}
                className={cn("flex items-center justify-center w-7 h-7 rounded-lg transition-all cursor-pointer",
                    track.muted ? "bg-red-500/20 text-red-400" : "bg-white/5 text-white/25 hover:bg-white/10")} title="Mute">
                <span className="text-[9px] font-bold">M</span>
            </button>
            <button onClick={e => { e.stopPropagation(); sendCommand("daw.toggleTrackSolo", track.id); }}
                className={cn("flex items-center justify-center w-7 h-7 rounded-lg transition-all cursor-pointer",
                    track.soloed ? "bg-amber-500/20 text-amber-400" : "bg-white/5 text-white/25 hover:bg-white/10")} title="Solo">
                <span className="text-[9px] font-bold">S</span>
            </button>
            <button onClick={e => { e.stopPropagation(); sendCommand("daw.toggleTrackArm", track.id); }}
                className={cn("flex items-center justify-center w-7 h-7 rounded-lg transition-all cursor-pointer",
                    track.armed ? "bg-red-500/20 text-red-400" : "bg-white/5 text-white/25 hover:bg-white/10")} title="Arm">
                <Circle className={cn("w-3 h-3", track.armed && "fill-red-400")} />
            </button>
        </div>
    );
}

// ─── Synth Controls ──────────────────────────────────────────────────────────

const OSC_TYPES = ["sine", "square", "sawtooth", "triangle"];
const FILTER_TYPES = ["lowpass", "highpass", "bandpass", "notch"];
const LFO_SHAPES = ["sine", "square", "sawtooth", "triangle"];
const LFO_TARGETS = ["pitch", "filter", "amp"];

function SynthControls({ synth, sendCommand }: { synth: DAWSynthSnapshot; sendCommand: DAWWidgetProps["sendCommand"] }) {
    const update = (key: string, value: unknown) => sendCommand("daw.setSynthConfig", { [key]: value });
    const updateOsc = (idx: number, key: string, value: unknown) => {
        const oscs = synth.oscillators.map((o, i) => i === idx ? { ...o, [key]: value } : { ...o });
        sendCommand("daw.setSynthConfig", { oscillators: oscs });
    };

    return (
        <div className="flex flex-col gap-3">
            {/* Oscillators */}
            {synth.oscillators.map((osc, i) => (
                <div key={i} className={cn("p-2 rounded-xl border transition-all",
                    osc.enabled ? "border-white/[0.08] bg-white/[0.02]" : "border-white/[0.04] bg-white/[0.01] opacity-40")}>
                    <div className="flex items-center gap-2 mb-2">
                        <button onClick={() => updateOsc(i, "enabled", !osc.enabled)}
                            className={cn("w-5 h-5 rounded flex items-center justify-center text-[8px] font-bold cursor-pointer",
                                osc.enabled ? "bg-blue-500/30 text-blue-400" : "bg-white/5 text-white/20")}>
                            {i + 1}
                        </button>
                        <span className="text-[9px] text-white/30 uppercase">OSC {i + 1}</span>
                        <div className="flex gap-0.5 ml-auto">
                            {OSC_TYPES.map(t => (
                                <button key={t} onClick={() => updateOsc(i, "type", t)}
                                    className={cn("px-1.5 py-0.5 rounded text-[8px] cursor-pointer",
                                        osc.type === t ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                    {t.slice(0, 3).toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <MiniKnob value={osc.gain} min={0} max={1} color="#60a5fa" label="Gain"
                            onChange={v => updateOsc(i, "gain", v)} onDoubleClick={() => updateOsc(i, "gain", 0.5)} />
                        <MiniKnob value={osc.detune} min={-100} max={100} color="#60a5fa" label="Detune"
                            onChange={v => updateOsc(i, "detune", Math.round(v))} onDoubleClick={() => updateOsc(i, "detune", 0)} />
                        <MiniKnob value={osc.octave} min={-3} max={3} color="#60a5fa" label="Oct"
                            onChange={v => updateOsc(i, "octave", Math.round(v))} onDoubleClick={() => updateOsc(i, "octave", 0)} />
                    </div>
                </div>
            ))}

            {/* Filter */}
            <div className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/30 uppercase font-bold">Filter</span>
                    <div className="flex gap-0.5 ml-auto">
                        {FILTER_TYPES.map(t => (
                            <button key={t} onClick={() => update("filterType", t)}
                                className={cn("px-1.5 py-0.5 rounded text-[8px] cursor-pointer",
                                    synth.filterType === t ? "bg-amber-500/20 text-amber-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {t === "lowpass" ? "LP" : t === "highpass" ? "HP" : t === "bandpass" ? "BP" : "NT"}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    <MiniKnob value={synth.filterCutoff} min={20} max={20000} color="#f59e0b" label="Cutoff"
                        onChange={v => update("filterCutoff", v)} onDoubleClick={() => update("filterCutoff", 5000)} />
                    <MiniKnob value={synth.filterResonance} min={0} max={30} color="#f59e0b" label="Reso"
                        onChange={v => update("filterResonance", v)} onDoubleClick={() => update("filterResonance", 1)} />
                    <MiniKnob value={synth.filterEnvAmount} min={0} max={10000} color="#f59e0b" label="Env"
                        onChange={v => update("filterEnvAmount", v)} onDoubleClick={() => update("filterEnvAmount", 2000)} />
                </div>
            </div>

            {/* Amp ADSR */}
            <div className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <span className="text-[9px] text-white/30 uppercase font-bold block mb-1">Amp Envelope</span>
                <div className="flex items-center gap-1.5">
                    <MiniKnob value={synth.ampAttack} min={0} max={2} color="#34d399" label="A"
                        onChange={v => update("ampAttack", v)} onDoubleClick={() => update("ampAttack", 0.01)} />
                    <MiniKnob value={synth.ampDecay} min={0} max={2} color="#34d399" label="D"
                        onChange={v => update("ampDecay", v)} onDoubleClick={() => update("ampDecay", 0.2)} />
                    <MiniKnob value={synth.ampSustain} min={0} max={1} color="#34d399" label="S"
                        onChange={v => update("ampSustain", v)} onDoubleClick={() => update("ampSustain", 0.7)} />
                    <MiniKnob value={synth.ampRelease} min={0} max={5} color="#34d399" label="R"
                        onChange={v => update("ampRelease", v)} onDoubleClick={() => update("ampRelease", 0.3)} />
                </div>
            </div>

            {/* Filter ADSR */}
            <div className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <span className="text-[9px] text-white/30 uppercase font-bold block mb-1">Filter Envelope</span>
                <div className="flex items-center gap-1.5">
                    <MiniKnob value={synth.filterAttack} min={0} max={2} color="#a78bfa" label="A"
                        onChange={v => update("filterAttack", v)} onDoubleClick={() => update("filterAttack", 0.01)} />
                    <MiniKnob value={synth.filterDecay} min={0} max={2} color="#a78bfa" label="D"
                        onChange={v => update("filterDecay", v)} onDoubleClick={() => update("filterDecay", 0.3)} />
                    <MiniKnob value={synth.filterSustain} min={0} max={1} color="#a78bfa" label="S"
                        onChange={v => update("filterSustain", v)} onDoubleClick={() => update("filterSustain", 0.2)} />
                    <MiniKnob value={synth.filterRelease} min={0} max={5} color="#a78bfa" label="R"
                        onChange={v => update("filterRelease", v)} onDoubleClick={() => update("filterRelease", 0.3)} />
                </div>
            </div>

            {/* LFO */}
            <div className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <div className="flex items-center gap-2 mb-2">
                    <span className="text-[9px] text-white/30 uppercase font-bold">LFO</span>
                    <div className="flex gap-0.5 ml-auto">
                        {LFO_SHAPES.map(s => (
                            <button key={s} onClick={() => update("lfoShape", s)}
                                className={cn("px-1.5 py-0.5 rounded text-[8px] cursor-pointer",
                                    synth.lfoShape === s ? "bg-cyan-500/20 text-cyan-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {s.slice(0, 3).toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex items-center gap-1.5">
                    <MiniKnob value={synth.lfoRate} min={0.1} max={20} color="#22d3ee" label="Rate"
                        onChange={v => update("lfoRate", v)} onDoubleClick={() => update("lfoRate", 4)} />
                    <MiniKnob value={synth.lfoDepth} min={0} max={1} color="#22d3ee" label="Depth"
                        onChange={v => update("lfoDepth", v)} onDoubleClick={() => update("lfoDepth", 0.5)} />
                    <div className="flex flex-col gap-0.5 ml-1">
                        {LFO_TARGETS.map(t => (
                            <button key={t} onClick={() => update("lfoTarget", t)}
                                className={cn("px-2 py-0.5 rounded text-[8px] cursor-pointer",
                                    synth.lfoTarget === t ? "bg-cyan-500/20 text-cyan-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                {t.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Effects */}
            <div className="p-2 rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <span className="text-[9px] text-white/30 uppercase font-bold block mb-1">Effects & Gain</span>
                <div className="flex items-center gap-1.5">
                    <MiniKnob value={synth.reverbMix} min={0} max={1} color="#f472b6" label="Reverb"
                        onChange={v => update("reverbMix", v)} onDoubleClick={() => update("reverbMix", 0)} />
                    <MiniKnob value={synth.delayMix} min={0} max={1} color="#f472b6" label="Delay"
                        onChange={v => update("delayMix", v)} onDoubleClick={() => update("delayMix", 0)} />
                    <MiniKnob value={synth.delayTime} min={0.05} max={1} color="#f472b6" label="D.Time"
                        onChange={v => update("delayTime", v)} onDoubleClick={() => update("delayTime", 0.25)} />
                    <MiniKnob value={synth.masterGain} min={0} max={1} color="#fff" label="Gain"
                        onChange={v => update("masterGain", v)} onDoubleClick={() => update("masterGain", 0.7)} />
                </div>
            </div>
        </div>
    );
}

// ─── Step Sequencer Controls ─────────────────────────────────────────────────

function StepSequencerControls({ stepSeq, sendCommand }: { stepSeq: DAWStepSeqSnapshot; sendCommand: DAWWidgetProps["sendCommand"] }) {
    return (
        <div className="flex flex-col gap-2">
            {/* Pattern config */}
            <div className="flex items-center gap-2 mb-1">
                <span className="text-[9px] text-white/30">Steps:</span>
                <div className="flex gap-0.5">
                    {[8, 16, 32, 64].map(n => (
                        <button key={n} onClick={() => sendCommand("daw.setPatternSteps", n)}
                            className={cn("px-2 py-0.5 rounded text-[8px] cursor-pointer",
                                stepSeq.steps === n ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                            {n}
                        </button>
                    ))}
                </div>
                <span className="text-[9px] text-white/30 ml-auto">Swing:</span>
                <MiniKnob value={stepSeq.swing} min={0} max={100} color="#34d399" label=""
                    onChange={v => sendCommand("daw.setPatternSwing", Math.round(v))}
                    onDoubleClick={() => sendCommand("daw.setPatternSwing", 0)} />
                <button onClick={() => sendCommand("daw.clearPattern")}
                    className="p-1.5 rounded-lg bg-red-500/10 text-red-400/50 hover:bg-red-500/20 hover:text-red-400 cursor-pointer">
                    <Trash2 className="w-3 h-3" />
                </button>
            </div>

            {/* Step grid */}
            <div className="overflow-x-auto">
                {stepSeq.tracks.map((track, trackIdx) => (
                    <div key={track.id} className="flex items-center gap-0.5 mb-0.5">
                        <div className="w-14 shrink-0 flex items-center gap-1">
                            <button onClick={() => sendCommand("daw.toggleStep", trackIdx, -1)}
                                className={cn("text-[8px] truncate", track.muted ? "text-white/15" : "text-white/40")}>
                                {track.name}
                            </button>
                        </div>
                        <div className="flex gap-px">
                            {track.steps.slice(0, Math.min(stepSeq.steps, 32)).map((step, stepIdx) => (
                                <button key={stepIdx}
                                    onClick={() => sendCommand("daw.toggleStep", trackIdx, stepIdx)}
                                    className={cn(
                                        "w-5 h-5 rounded-sm transition-all cursor-pointer text-[7px]",
                                        step.active
                                            ? step.velocity > 100 ? "bg-emerald-400/80 text-white" : "bg-emerald-500/40 text-white/60"
                                            : stepIdx % 4 === 0 ? "bg-white/[0.06] hover:bg-white/[0.10]" : "bg-white/[0.03] hover:bg-white/[0.06]",
                                    )} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── Effects Rack (per-track inserts) ────────────────────────────────────────

function InsertRow({ insert, trackId, sendCommand }: {
    insert: DAWInsertSnapshot; trackId: string; sendCommand: DAWWidgetProps["sendCommand"];
}) {
    const [expanded, setExpanded] = useState(false);
    const params = Object.entries(insert.params);

    return (
        <div className={cn("rounded-lg border transition-all",
            insert.enabled ? "border-white/[0.08] bg-white/[0.02]" : "border-white/[0.04] bg-white/[0.01] opacity-50")}>
            <div className="flex items-center gap-2 px-2 py-1.5">
                <button onClick={() => sendCommand("daw.toggleInsert", trackId, insert.id)}
                    className={cn("w-5 h-5 rounded flex items-center justify-center text-[8px] cursor-pointer",
                        insert.enabled ? "bg-emerald-500/30 text-emerald-400" : "bg-white/5 text-white/20")}>
                    {insert.enabled ? "✓" : "○"}
                </button>
                <span className="text-[9px] text-white/50 font-medium flex-1 capitalize">{insert.type.replace(/-/g, " ")}</span>
                {params.length > 0 && (
                    <button onClick={() => setExpanded(!expanded)} className="text-white/20 cursor-pointer">
                        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </button>
                )}
            </div>
            {expanded && params.length > 0 && (
                <div className="px-2 pb-2 flex flex-wrap gap-1">
                    {params.map(([key, val]) => (
                        <MiniKnob key={key} value={val} min={0} max={1} color="#60a5fa" label={key}
                            onChange={v => sendCommand("daw.setInsertParam", trackId, insert.id, key, v)} />
                    ))}
                </div>
            )}
        </div>
    );
}

function EffectsRack({ tracks, selectedTrackId, sendCommand }: {
    tracks: DAWTrackSnapshot[]; selectedTrackId: string | null; sendCommand: DAWWidgetProps["sendCommand"];
}) {
    const selectedTrack = tracks.find(t => t.id === selectedTrackId);
    if (!selectedTrack) {
        return <div className="text-[10px] text-white/20 text-center py-4">Select a track to view its effects</div>;
    }
    if (selectedTrack.inserts.length === 0) {
        return <div className="text-[10px] text-white/20 text-center py-4">No inserts on &quot;{selectedTrack.name}&quot;</div>;
    }
    return (
        <div className="flex flex-col gap-1">
            <div className="text-[9px] text-white/25 mb-1">Inserts on &quot;{selectedTrack.name}&quot;</div>
            {selectedTrack.inserts.map(ins => (
                <InsertRow key={ins.id} insert={ins} trackId={selectedTrack.id} sendCommand={sendCommand} />
            ))}
        </div>
    );
}

// ─── Voice Processor ─────────────────────────────────────────────────────────

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_NAMES = ["Chromatic", "Major", "Minor", "Pent. Maj", "Pent. Min", "Blues", "Dorian", "Mixolydian", "Harm. Min"];

const VP_FX_CATEGORIES: { label: string; types: string[] }[] = [
    { label: "Voice", types: ["autotune", "pitchShift", "noiseSuppression", "vocoderLite"] },
    { label: "Dynamics", types: ["compressor", "limiter", "gate", "deEsser", "sidechain"] },
    { label: "EQ", types: ["eq3", "parametricEq", "filter"] },
    { label: "Reverb", types: ["reverb", "convolutionReverb", "delay", "pingPongDelay"] },
    { label: "Modulation", types: ["chorus", "flanger", "phaser", "tremolo"] },
    { label: "Distortion", types: ["distortion", "bitcrusher", "saturator"] },
    { label: "Stereo", types: ["stereoWidth"] },
];

function VPInsertRow({ fx, sendCommand }: {
    fx: { id: string; type: string; enabled: boolean; params: Record<string, number> };
    sendCommand: DAWWidgetProps["sendCommand"];
}) {
    const [expanded, setExpanded] = useState(false);
    const params = Object.entries(fx.params);

    return (
        <div className={cn("rounded-xl border transition-all duration-200",
            fx.enabled
                ? "border-rose-500/20 bg-gradient-to-r from-rose-500/[0.04] to-transparent"
                : "border-white/[0.04] bg-white/[0.01] opacity-50")}>
            <div className="flex items-center gap-2 px-2.5 py-2">
                <button onClick={() => sendCommand("daw.vpToggleEffect", fx.id)}
                    className={cn("w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200 cursor-pointer",
                        fx.enabled
                            ? "bg-rose-500/25 text-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.15)]"
                            : "bg-white/5 text-white/20")}>
                    <Power className="w-3 h-3" />
                </button>
                <span className="text-[10px] text-white/60 font-medium flex-1 capitalize">
                    {fx.type.replace(/([A-Z])/g, " $1").trim()}
                </span>
                <button onClick={() => sendCommand("daw.vpRemoveEffect", fx.id)}
                    className="text-white/15 hover:text-red-400/60 transition-colors cursor-pointer p-0.5">
                    <Trash2 className="w-3 h-3" />
                </button>
                {params.length > 0 && (
                    <button onClick={() => setExpanded(!expanded)} className="text-white/20 cursor-pointer">
                        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </button>
                )}
            </div>
            {expanded && params.length > 0 && (
                <div className="px-2 pb-2.5 flex flex-wrap gap-1.5">
                    {params.map(([key, val]) => {
                        const isFreq = key.includes("freq") || key.includes("Freq");
                        const isSemitones = key === "semitones";
                        const min = isSemitones ? -24 : isFreq ? 20 : key === "threshold" ? -60 : 0;
                        const max = isSemitones ? 24 : isFreq ? 20000 : key === "threshold" ? 0 : key === "ratio" ? 20 : key === "reduction" ? 40 : key === "makeupGain" ? 24 : 1;
                        return (
                            <MiniKnob key={key} value={val} min={min} max={max} color="#f43f5e" label={key}
                                onChange={v => sendCommand("daw.vpUpdateParam", fx.id, key, v)} />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function VPAddEffectPicker({ sendCommand, onClose }: {
    sendCommand: DAWWidgetProps["sendCommand"]; onClose: () => void;
}) {
    return (
        <div className="rounded-xl border border-rose-500/15 bg-black/80 backdrop-blur-xl p-3 space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
            <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400/60">Add Effect</span>
                <button onClick={onClose} className="text-white/20 hover:text-white/40 text-xs cursor-pointer">✕</button>
            </div>
            {VP_FX_CATEGORIES.map(cat => (
                <div key={cat.label}>
                    <div className="text-[8px] uppercase tracking-wider text-white/20 mb-1">{cat.label}</div>
                    <div className="flex flex-wrap gap-1">
                        {cat.types.map(type => (
                            <button key={type} onClick={() => { sendCommand("daw.vpAddEffect", type); onClose(); }}
                                className="px-2 py-1 rounded-lg text-[9px] bg-white/[0.04] text-white/40 hover:bg-rose-500/15 hover:text-rose-300 transition-all cursor-pointer capitalize border border-transparent hover:border-rose-500/20">
                                {type.replace(/([A-Z])/g, " $1").trim()}
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function VoiceProcessorControls({ vp, sendCommand }: {
    vp: VPSnapshot; sendCommand: DAWWidgetProps["sendCommand"];
}) {
    const [showAddFx, setShowAddFx] = useState(false);

    const confidencePct = Math.round(vp.pitchConfidence * 100);
    const centsAbs = Math.abs(vp.pitchCents);
    const centsDir = vp.pitchCents >= 0 ? "+" : "−";

    return (
        <div className="rounded-2xl border border-rose-500/10 bg-gradient-to-b from-rose-500/[0.03] to-transparent overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2 p-3 border-b border-white/[0.04]">
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-300",
                    vp.isActive
                        ? "bg-rose-500/25 text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.2)]"
                        : "bg-white/[0.04] text-white/20")}>
                    {vp.isActive ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                </div>
                <div className="flex-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400/60">Voice Processor</span>
                </div>
                <button onClick={() => sendCommand("daw.vpToggle")}
                    className={cn("px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all duration-200 cursor-pointer",
                        vp.isActive
                            ? "bg-rose-500/20 text-rose-400 border border-rose-500/30 shadow-[0_0_8px_rgba(244,63,94,0.1)]"
                            : "bg-white/[0.04] text-white/30 hover:bg-white/[0.06] border border-white/[0.06]")}>
                    {vp.isActive ? "Active" : "Inactive"}
                </button>
            </div>

            <div className="p-3 space-y-3">
                {/* Pitch display */}
                <div className="rounded-xl bg-black/30 border border-white/[0.04] p-3 text-center">
                    <div className="flex items-center justify-center gap-3">
                        <div className="text-2xl font-bold text-white/70 tabular-nums min-w-[3ch] tracking-tight">
                            {vp.pitchNote || "—"}
                        </div>
                        <div className="flex flex-col items-start text-[9px]">
                            <span className={cn("tabular-nums", centsAbs > 20 ? "text-amber-400/60" : "text-emerald-400/60")}>
                                {centsDir}{centsAbs}¢
                            </span>
                            <span className="text-white/20">{confidencePct}% conf</span>
                        </div>
                    </div>
                    {/* Pitch meter bar */}
                    <div className="mt-2 h-1 rounded-full bg-white/[0.04] overflow-hidden relative">
                        <div className="absolute top-0 bottom-0 w-px bg-white/10 left-1/2" />
                        <div className="absolute top-0 bottom-0 h-full w-2 rounded-full transition-all duration-100"
                            style={{
                                left: `${50 + (vp.pitchCents / 50) * 50}%`,
                                transform: "translateX(-50%)",
                                backgroundColor: centsAbs > 20 ? "#f59e0b" : "#10b981",
                                opacity: vp.pitchConfidence,
                            }} />
                    </div>
                </div>

                {/* Levels */}
                <div className="flex items-center gap-3">
                    <div className="flex-1 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] text-white/20 uppercase w-8">In</span>
                            <div className="flex-1 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                                <div className="h-full rounded-full transition-[width] duration-75 bg-gradient-to-r from-rose-500/40 to-rose-400/60"
                                    style={{ width: `${Math.min(100, vp.peakL * 100)}%` }} />
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] text-white/20 uppercase w-8">Out</span>
                            <div className="flex-1 h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                                <div className="h-full rounded-full transition-[width] duration-75 bg-gradient-to-r from-rose-500/40 to-rose-400/60"
                                    style={{ width: `${Math.min(100, vp.peakR * 100)}%` }} />
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-[8px] text-white/20 uppercase w-8">RMS</span>
                            <div className="flex-1 h-1 rounded-full bg-white/[0.04] overflow-hidden">
                                <div className="h-full rounded-full transition-[width] duration-75 bg-white/10"
                                    style={{ width: `${Math.min(100, vp.rms * 100)}%` }} />
                            </div>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <MiniKnob value={vp.inputGain} min={0} max={2} color="#f43f5e" label="Input"
                            onChange={v => sendCommand("daw.vpSetInputGain", v)}
                            onDoubleClick={() => sendCommand("daw.vpSetInputGain", 1)} />
                        <MiniKnob value={vp.outputGain} min={0} max={2} color="#f43f5e" label="Output"
                            onChange={v => sendCommand("daw.vpSetOutputGain", v)}
                            onDoubleClick={() => sendCommand("daw.vpSetOutputGain", 1)} />
                    </div>
                </div>

                {/* Key & Scale */}
                <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-white/20">Key & Scale</span>
                        <button onClick={() => sendCommand("daw.vpAutoDetect")}
                            className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg text-[9px] bg-rose-500/10 text-rose-400/70 hover:bg-rose-500/20 transition-all cursor-pointer border border-rose-500/15">
                            <Sparkles className="w-3 h-3" /> Auto-detect
                        </button>
                    </div>
                    {/* Key buttons */}
                    <div className="grid grid-cols-12 gap-0.5">
                        {NOTE_NAMES.map((note, i) => (
                            <button key={i} onClick={() => sendCommand("daw.vpSetKey", i)}
                                className={cn("py-1.5 rounded-md text-[9px] font-medium transition-all cursor-pointer",
                                    note.includes("#") ? "bg-gray-800" : "bg-white/[0.03]",
                                    vp.selectedKey === i
                                        ? "!bg-rose-500/25 text-rose-400 border border-rose-500/30 shadow-[0_0_6px_rgba(244,63,94,0.15)]"
                                        : "text-white/30 border border-transparent hover:bg-white/[0.06]")}>
                                {note}
                            </button>
                        ))}
                    </div>
                    {/* Scale selector */}
                    <div className="flex flex-wrap gap-1">
                        {SCALE_NAMES.map((name, i) => (
                            <button key={i} onClick={() => sendCommand("daw.vpSetScale", i)}
                                className={cn("px-2 py-1 rounded-lg text-[9px] transition-all cursor-pointer",
                                    vp.selectedScale === i
                                        ? "bg-rose-500/20 text-rose-400 border border-rose-500/25"
                                        : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06] border border-transparent")}>
                                {name}
                            </button>
                        ))}
                    </div>
                </div>

                {/* FX Chain */}
                <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-white/20">
                            FX Chain ({vp.chain.length})
                        </span>
                        <button onClick={() => setShowAddFx(!showAddFx)}
                            className="ml-auto flex items-center gap-0.5 px-2 py-1 rounded-lg text-[9px] bg-white/[0.04] text-white/30 hover:bg-rose-500/15 hover:text-rose-300 transition-all cursor-pointer">
                            <Plus className="w-3 h-3" /> Add
                        </button>
                    </div>

                    {showAddFx && <VPAddEffectPicker sendCommand={sendCommand} onClose={() => setShowAddFx(false)} />}

                    {vp.chain.length === 0 && !showAddFx && (
                        <div className="text-[10px] text-white/15 text-center py-4 rounded-xl border border-dashed border-white/[0.06]">
                            No effects — tap Auto-detect or Add
                        </div>
                    )}

                    {vp.chain.map(fx => (
                        <VPInsertRow key={fx.id} fx={fx} sendCommand={sendCommand} />
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Tool & Snap Selectors ───────────────────────────────────────────────────

const TOOLS = ["select", "draw", "erase", "slice", "mute", "automation"] as const;
const SNAPS = ["1/1", "1/2", "1/4", "1/8", "1/16", "1/32", "none"] as const;

// ─── Main DAW Widget ─────────────────────────────────────────────────────────

export function DAWRemoteWidget({ snapshot, sendCommand }: DAWWidgetProps) {
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

    return (
        <div className="px-4 py-3 flex flex-col gap-3">
            {/* Transport bar */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/25">Transport</span>
                    <span className="text-[9px] text-white/20 ml-1">{snapshot.playbackMode}</span>
                    <span className="text-xs tabular-nums text-white/40 font-mono ml-auto">
                        {snapshot.tempo.toFixed(1)} BPM
                    </span>
                    <span className="text-[10px] tabular-nums text-white/25 font-mono">
                        Beat {snapshot.currentBeat.toFixed(1)}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <button onClick={() => sendCommand("daw.togglePlay")}
                        className={cn("flex-1 flex items-center justify-center gap-1.5 py-3 rounded-xl font-medium text-xs transition-all cursor-pointer",
                            snapshot.isPlaying ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                : "bg-white/[0.04] text-white/40 hover:bg-white/[0.08] border border-white/[0.06]")}>
                        {snapshot.isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        {snapshot.isPlaying ? "Pause" : "Play"}
                    </button>
                    <button onClick={() => sendCommand("daw.stop")}
                        className="flex items-center justify-center w-12 h-12 rounded-xl bg-white/[0.04] text-white/30 hover:bg-white/[0.08] border border-white/[0.06] transition-colors cursor-pointer">
                        <Square className="w-4 h-4" />
                    </button>
                    <button onClick={() => sendCommand("daw.record")}
                        className={cn("flex items-center justify-center w-12 h-12 rounded-xl border transition-all cursor-pointer",
                            snapshot.isRecording ? "bg-red-500/20 text-red-400 border-red-500/30" : "bg-white/[0.04] text-white/30 hover:bg-white/[0.08] border-white/[0.06]")}>
                        <Circle className={cn("w-4 h-4", snapshot.isRecording && "fill-red-400")} />
                    </button>
                    <button onClick={() => sendCommand("daw.toggleMetronome")}
                        className={cn("flex items-center justify-center w-12 h-12 rounded-xl border transition-all cursor-pointer",
                            snapshot.metronomeOn ? "bg-blue-500/20 text-blue-400 border-blue-500/30" : "bg-white/[0.04] text-white/30 hover:bg-white/[0.08] border-white/[0.06]")}
                        title="Metronome">
                        <span className="text-sm">🔔</span>
                    </button>
                </div>

                {/* Undo/Redo + tempo + playback mode */}
                <div className="flex items-center gap-2 mt-3">
                    <button onClick={() => sendCommand("daw.undo")}
                        className="flex-1 flex items-center justify-center gap-1 py-2 rounded-xl bg-white/[0.03] text-white/30 hover:bg-white/[0.06] text-xs cursor-pointer">
                        <Undo2 className="w-3.5 h-3.5" /> Undo
                    </button>
                    <button onClick={() => sendCommand("daw.redo")}
                        className="flex-1 flex items-center justify-center gap-1 py-2 rounded-xl bg-white/[0.03] text-white/30 hover:bg-white/[0.06] text-xs cursor-pointer">
                        <Redo2 className="w-3.5 h-3.5" /> Redo
                    </button>
                    <div className="flex items-center gap-1">
                        <button onClick={() => sendCommand("daw.setTempo", Math.max(20, snapshot.tempo - 1))}
                            className="w-8 h-8 rounded-lg bg-white/[0.04] text-white/30 hover:bg-white/[0.08] text-xs flex items-center justify-center cursor-pointer">-</button>
                        <span className="text-xs tabular-nums text-white/50 font-mono w-12 text-center">{snapshot.tempo.toFixed(0)}</span>
                        <button onClick={() => sendCommand("daw.setTempo", Math.min(300, snapshot.tempo + 1))}
                            className="w-8 h-8 rounded-lg bg-white/[0.04] text-white/30 hover:bg-white/[0.08] text-xs flex items-center justify-center cursor-pointer">+</button>
                    </div>
                </div>

                {/* Playback mode toggle */}
                <div className="flex items-center gap-2 mt-2">
                    <button onClick={() => sendCommand("daw.togglePlaybackMode")}
                        className={cn("flex-1 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer transition-all",
                            snapshot.playbackMode === "pattern" ? "bg-emerald-500/15 text-emerald-400" : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06]")}>
                        Pattern
                    </button>
                    <button onClick={() => sendCommand("daw.togglePlaybackMode")}
                        className={cn("flex-1 py-1.5 rounded-lg text-[10px] font-medium cursor-pointer transition-all",
                            snapshot.playbackMode === "song" ? "bg-blue-500/15 text-blue-400" : "bg-white/[0.03] text-white/25 hover:bg-white/[0.06]")}>
                        Song
                    </button>
                </div>

                {/* Master meter + volume */}
                <div className="flex items-center gap-2 mt-3">
                    <span className="text-[9px] text-white/25 uppercase">Master</span>
                    <div className="flex-1 h-2 rounded-full bg-white/[0.04] overflow-hidden">
                        <div className="h-full rounded-full transition-[width] duration-75 bg-gradient-to-r from-emerald-500/50 to-emerald-400/70"
                            style={{ width: `${Math.min(100, Math.max(snapshot.masterPeakL, snapshot.masterPeakR) * 100)}%` }} />
                    </div>
                    <span className="text-[9px] tabular-nums text-white/25">{Math.round(snapshot.masterVolume * 100)}%</span>
                </div>
            </div>

            {/* Tool & Snap */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-4">
                    <div className="flex-1">
                        <span className="text-[9px] text-white/25 uppercase block mb-1">Tool</span>
                        <div className="flex gap-0.5 flex-wrap">
                            {TOOLS.map(t => (
                                <button key={t} onClick={() => sendCommand("daw.setTool", t)}
                                    className={cn("px-2 py-1 rounded text-[8px] cursor-pointer capitalize",
                                        snapshot.tool === t ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="flex-1">
                        <span className="text-[9px] text-white/25 uppercase block mb-1">Snap</span>
                        <div className="flex gap-0.5 flex-wrap">
                            {SNAPS.map(s => (
                                <button key={s} onClick={() => sendCommand("daw.setSnap", s)}
                                    className={cn("px-2 py-1 rounded text-[8px] cursor-pointer",
                                        snapshot.snap === s ? "bg-amber-500/20 text-amber-400" : "bg-white/[0.03] text-white/20 hover:bg-white/[0.06]")}>
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Track list */}
            <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 px-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-white/25">
                        Tracks ({snapshot.tracks.length})
                    </span>
                    <span className="text-[10px] text-white/20">{snapshot.projectName}</span>
                </div>
                {snapshot.tracks.map(track => (
                    <TrackStrip key={track.id} track={track} sendCommand={sendCommand}
                        isSelected={selectedTrackId === track.id}
                        onSelect={() => setSelectedTrackId(selectedTrackId === track.id ? null : track.id)} />
                ))}
                {snapshot.tracks.length === 0 && (
                    <div className="flex items-center justify-center py-8 rounded-xl border border-dashed border-white/[0.06] text-xs text-white/20">
                        No tracks in project
                    </div>
                )}
            </div>

            {/* Panel toggles */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 block mb-2">Panels</span>
                <div className="flex flex-wrap gap-1.5">
                    {([
                        { key: "mixer", active: snapshot.showMixer },
                        { key: "pianoRoll", active: snapshot.showPianoRoll },
                        { key: "stepSequencer", active: snapshot.showStepSequencer },
                        { key: "effectsRack", active: snapshot.showEffectsRack },
                        { key: "synth", active: snapshot.showSynth },
                        { key: "voiceProcessor", active: snapshot.showVoiceProcessor },
                        { key: "automation", active: snapshot.showAutomation },
                    ] as const).map(({ key, active }) => (
                        <button key={key} onClick={() => sendCommand("daw.togglePanel", key)}
                            className={cn("px-2.5 py-1.5 rounded-lg text-[10px] transition-colors cursor-pointer capitalize",
                                active ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                    : "bg-white/[0.03] text-white/30 hover:bg-white/[0.06] hover:text-white/50 border border-transparent")}>
                            {key.replace(/([A-Z])/g, " $1").trim()}
                        </button>
                    ))}
                </div>
            </div>

            {/* Synth */}
            <Section title="Synthesizer" icon={<Music className="w-3.5 h-3.5 text-blue-400/50" />} color="blue">
                <SynthControls synth={snapshot.synth} sendCommand={sendCommand} />
            </Section>

            {/* Step Sequencer */}
            <Section title="Step Sequencer" icon={<Grid3X3 className="w-3.5 h-3.5 text-emerald-400/50" />} color="emerald">
                <StepSequencerControls stepSeq={snapshot.stepSeq} sendCommand={sendCommand} />
            </Section>

            {/* Effects Rack */}
            <Section title="Effects Rack" icon={<Sliders className="w-3.5 h-3.5 text-purple-400/50" />} color="purple">
                <EffectsRack tracks={snapshot.tracks} selectedTrackId={selectedTrackId} sendCommand={sendCommand} />
            </Section>

            {/* Voice Processor */}
            {snapshot.showVoiceProcessor && snapshot.vp && (
                <VoiceProcessorControls vp={snapshot.vp} sendCommand={sendCommand} />
            )}
        </div>
    );
}
