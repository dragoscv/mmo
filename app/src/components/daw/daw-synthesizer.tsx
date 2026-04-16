"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import type { SynthConfig, SynthOscillator } from "@/lib/daw-engine";

const OSC_TYPES: OscillatorType[] = ["sine", "triangle", "sawtooth", "square"];
const FILTER_TYPES: BiquadFilterType[] = ["lowpass", "highpass", "bandpass", "notch"];
const LFO_TARGETS = ["pitch", "filter", "amp"] as const;

export function DAWSynthesizer() {
    const daw = useDAW();
    const config = daw.synthConfig;
    const [activeKeys, setActiveKeys] = useState<Set<number>>(new Set());
    const keyboardRef = useRef<HTMLDivElement>(null);
    const activeNoteIdsRef = useRef<Map<number, string>>(new Map());

    const update = useCallback((patch: Partial<SynthConfig>) => {
        daw.setSynthConfig(patch);
    }, [daw]);

    // Computer keyboard → MIDI mapping (Z-M = C3-B3, Q-P = C4-B4)
    const keyMapRef = useRef<Record<string, number>>({
        z: 60, s: 61, x: 62, d: 63, c: 64, v: 65, g: 66, b: 67, h: 68, n: 69, j: 70, m: 71,
        q: 72, 2: 73, w: 74, 3: 75, e: 76, r: 77, 5: 78, t: 79, 6: 80, y: 81, 7: 82, u: 83,
    });

    useEffect(() => {
        const keyMap = keyMapRef.current;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
            const target = e.target as HTMLElement;
            if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return;

            const pitch = keyMap[e.key.toLowerCase()];
            if (pitch != null && !activeNoteIdsRef.current.has(pitch)) {
                setActiveKeys(prev => new Set(prev).add(pitch));
                const noteId = daw.playSynthNote(pitch, 100);
                activeNoteIdsRef.current.set(pitch, noteId);
            }
        };
        const handleKeyUp = (e: KeyboardEvent) => {
            const pitch = keyMap[e.key.toLowerCase()];
            if (pitch != null) {
                setActiveKeys(prev => { const n = new Set(prev); n.delete(pitch); return n; });
                const noteId = activeNoteIdsRef.current.get(pitch);
                if (noteId) {
                    daw.stopSynthNote(noteId);
                    activeNoteIdsRef.current.delete(pitch);
                }
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, [daw]);

    return (
        <div className="h-full flex flex-col bg-[var(--daw-bg)] overflow-hidden">
            {/* Top bar */}
            <div className="h-7 flex items-center px-3 border-b border-[var(--daw-border)] bg-[var(--daw-surface)] flex-shrink-0">
                <span className="text-xs text-white/60 font-medium">Synthesizer</span>
                <span className="text-[9px] text-white/20 ml-auto">Use Z-M and Q-U keys to play</span>
            </div>

            {/* Main synth panel */}
            <div className="flex-1 flex overflow-hidden">
                {/* Oscillators */}
                <div className="flex-1 p-2 border-r border-white/5">
                    <SectionLabel>Oscillators</SectionLabel>
                    <div className="flex gap-3 mt-1">
                        {([0, 1, 2] as const).map(i => {
                            const osc = config.oscillators[i];
                            return (
                                <div key={i} className="flex-1">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="text-[9px] text-white/30">OSC {i + 1}</span>
                                        <button
                                            onClick={() => {
                                                const oscs = [...config.oscillators] as SynthOscillator[];
                                                oscs[i] = { ...oscs[i], enabled: !oscs[i].enabled };
                                                update({ oscillators: oscs });
                                            }}
                                            className={cn(
                                                "text-[8px] px-1 rounded",
                                                osc.enabled ? "text-cyan-400 bg-cyan-500/20" : "text-white/20"
                                            )}
                                        >
                                            {osc.enabled ? "ON" : "OFF"}
                                        </button>
                                    </div>

                                    {/* Waveform selector */}
                                    <div className="flex gap-0.5 mb-1">
                                        {OSC_TYPES.map(type => (
                                            <button
                                                key={type}
                                                onClick={() => {
                                                    const oscs = [...config.oscillators] as SynthOscillator[];
                                                    oscs[i] = { ...oscs[i], type };
                                                    update({ oscillators: oscs });
                                                }}
                                                className={cn(
                                                    "flex-1 h-5 rounded text-[8px] capitalize",
                                                    osc.type === type ? "bg-purple-500/30 text-purple-400" : "bg-white/5 text-white/20"
                                                )}
                                            >
                                                {type.slice(0, 3)}
                                            </button>
                                        ))}
                                    </div>

                                    <MiniKnob label="Detune" value={osc.detune} min={-100} max={100} step={1}
                                        format={v => `${v > 0 ? "+" : ""}${v}`}
                                        onChange={v => {
                                            const oscs = [...config.oscillators] as SynthOscillator[];
                                            oscs[i] = { ...oscs[i], detune: v };
                                            update({ oscillators: oscs });
                                        }} />
                                    <MiniKnob label="Gain" value={osc.gain} min={0} max={1} step={0.01}
                                        onChange={v => {
                                            const oscs = [...config.oscillators] as SynthOscillator[];
                                            oscs[i] = { ...oscs[i], gain: v };
                                            update({ oscillators: oscs });
                                        }} />
                                    <MiniKnob label="Octave" value={osc.octave} min={-3} max={3} step={1}
                                        format={v => `${v > 0 ? "+" : ""}${v}`}
                                        onChange={v => {
                                            const oscs = [...config.oscillators] as SynthOscillator[];
                                            oscs[i] = { ...oscs[i], octave: v };
                                            update({ oscillators: oscs });
                                        }} />
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Filter */}
                <div className="w-[140px] p-2 border-r border-white/5">
                    <SectionLabel>Filter</SectionLabel>
                    <div className="flex gap-0.5 mb-2 mt-1">
                        {FILTER_TYPES.map(type => (
                            <button
                                key={type}
                                onClick={() => update({ filterType: type })}
                                className={cn(
                                    "flex-1 h-5 rounded text-[8px] capitalize",
                                    config.filterType === type ? "bg-orange-500/30 text-orange-400" : "bg-white/5 text-white/20"
                                )}
                            >
                                {type.slice(0, 2)}
                            </button>
                        ))}
                    </div>
                    <MiniKnob label="Cutoff" value={config.filterCutoff} min={20} max={20000} step={1}
                        format={v => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`}
                        onChange={v => update({ filterCutoff: v })} />
                    <MiniKnob label="Resonance" value={config.filterResonance} min={0} max={30} step={0.1}
                        onChange={v => update({ filterResonance: v })} />
                    <MiniKnob label="Env Amount" value={config.filterEnvAmount} min={0} max={1} step={0.01}
                        onChange={v => update({ filterEnvAmount: v })} />
                </div>

                {/* ADSR */}
                <div className="w-[160px] p-2 border-r border-white/5">
                    <SectionLabel>Amp Envelope (ADSR)</SectionLabel>
                    <div className="mt-1">
                        <ADSRDisplay a={config.ampAttack} d={config.ampDecay} s={config.ampSustain} r={config.ampRelease} />
                        <MiniKnob label="Attack" value={config.ampAttack} min={0.001} max={5} step={0.001}
                            format={v => v >= 1 ? `${v.toFixed(1)}s` : `${(v * 1000).toFixed(0)}ms`}
                            onChange={v => update({ ampAttack: v })} />
                        <MiniKnob label="Decay" value={config.ampDecay} min={0.001} max={5} step={0.001}
                            format={v => v >= 1 ? `${v.toFixed(1)}s` : `${(v * 1000).toFixed(0)}ms`}
                            onChange={v => update({ ampDecay: v })} />
                        <MiniKnob label="Sustain" value={config.ampSustain} min={0} max={1} step={0.01}
                            onChange={v => update({ ampSustain: v })} />
                        <MiniKnob label="Release" value={config.ampRelease} min={0.01} max={10} step={0.01}
                            format={v => v >= 1 ? `${v.toFixed(1)}s` : `${(v * 1000).toFixed(0)}ms`}
                            onChange={v => update({ ampRelease: v })} />
                    </div>
                </div>

                {/* LFO */}
                <div className="w-[130px] p-2">
                    <SectionLabel>LFO</SectionLabel>
                    <div className="flex gap-0.5 mb-2 mt-1">
                        {OSC_TYPES.map(type => (
                            <button
                                key={type}
                                onClick={() => update({ lfoShape: type })}
                                className={cn(
                                    "flex-1 h-5 rounded text-[8px] capitalize",
                                    config.lfoShape === type ? "bg-green-500/30 text-green-400" : "bg-white/5 text-white/20"
                                )}
                            >
                                {type.slice(0, 3)}
                            </button>
                        ))}
                    </div>
                    <MiniKnob label="Rate" value={config.lfoRate} min={0.01} max={50} step={0.01}
                        format={v => `${v.toFixed(1)} Hz`}
                        onChange={v => update({ lfoRate: v })} />
                    <MiniKnob label="Depth" value={config.lfoDepth} min={0} max={1} step={0.01}
                        onChange={v => update({ lfoDepth: v })} />
                    <div className="mt-1">
                        <span className="text-[8px] text-white/20 uppercase">Target</span>
                        <div className="flex gap-0.5 mt-0.5">
                            {LFO_TARGETS.map(tgt => (
                                <button
                                    key={tgt}
                                    onClick={() => update({ lfoTarget: tgt })}
                                    className={cn(
                                        "flex-1 h-5 rounded text-[7px] capitalize",
                                        config.lfoTarget === tgt ? "bg-green-500/20 text-green-400" : "bg-white/5 text-white/20"
                                    )}
                                >
                                    {tgt.slice(0, 4)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Keyboard */}
            <div ref={keyboardRef} className="h-14 flex-shrink-0 border-t border-white/10 flex">
                {Array.from({ length: 36 }).map((_, i) => {
                    const pitch = 48 + i; // C3 to B5
                    const isBlack = [1, 3, 6, 8, 10].includes(pitch % 12);
                    const isActive = activeKeys.has(pitch);

                    const onDown = () => {
                        setActiveKeys(prev => new Set(prev).add(pitch));
                        const noteId = daw.playSynthNote(pitch, 100);
                        activeNoteIdsRef.current.set(pitch, noteId);
                    };
                    const onUp = () => {
                        setActiveKeys(prev => { const n = new Set(prev); n.delete(pitch); return n; });
                        const noteId = activeNoteIdsRef.current.get(pitch);
                        if (noteId) { daw.stopSynthNote(noteId); activeNoteIdsRef.current.delete(pitch); }
                    };
                    const onLeave = () => {
                        if (activeKeys.has(pitch)) onUp();
                    };

                    if (isBlack) {
                        return (
                            <div
                                key={pitch}
                                className={cn(
                                    "h-[60%] w-[12px] -mx-[6px] z-10 rounded-b-sm cursor-pointer transition-all",
                                    isActive ? "bg-purple-400 shadow-[0_0_8px_rgba(168,85,247,0.5)]" : "bg-[var(--daw-surface)] hover:bg-[var(--daw-surface-2)]"
                                )}
                                onMouseDown={onDown}
                                onMouseUp={onUp}
                                onMouseLeave={onLeave}
                            />
                        );
                    }

                    return (
                        <div
                            key={pitch}
                            className={cn(
                                "flex-1 border-r border-white/10 cursor-pointer transition-all flex items-end justify-center pb-0.5",
                                isActive ? "bg-purple-500/30" : "bg-[#22223a] hover:bg-[#2a2a40]",
                                pitch % 12 === 0 && "border-l border-l-white/20"
                            )}
                            onMouseDown={onDown}
                            onMouseUp={onUp}
                            onMouseLeave={onLeave}
                        >
                            {pitch % 12 === 0 && (
                                <span className="text-[7px] text-white/20">C{Math.floor(pitch / 12) - 1}</span>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Mini Controls ───────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <div className="text-[9px] text-white/20 uppercase tracking-wider">{children}</div>;
}

function MiniKnob({ label, value, min, max, step, onChange, format }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (v: number) => void;
    format?: (v: number) => string;
}) {
    const display = format ? format(value) : value.toFixed(2);
    return (
        <div className="flex items-center gap-1 h-5">
            <span className="text-[8px] text-white/25 w-14 truncate">{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="flex-1 h-0.5 accent-purple-500 min-w-0"
            />
            <span className="text-[8px] text-white/30 w-12 text-right font-mono truncate">{display}</span>
        </div>
    );
}

// ─── ADSR Display ────────────────────────────────────────────────────────

function ADSRDisplay({ a, d, s, r }: { a: number; d: number; s: number; r: number }) {
    const w = 150;
    const h = 40;
    const total = a + d + 0.3 + r; // sustain is held
    const scale = w / total;

    const ax = a * scale;
    const dx = ax + d * scale;
    const sx = dx + 0.3 * scale;
    const rx = sx + r * scale;
    const sy = h - s * (h - 4);

    const path = `M0,${h} L${ax},4 L${dx},${sy} L${sx},${sy} L${rx},${h}`;

    return (
        <svg width={w} height={h} className="mb-1">
            <path d={path} fill="none" stroke="rgba(168,85,247,0.4)" strokeWidth="1.5" />
            <path d={`${path} L${w},${h} Z`} fill="rgba(168,85,247,0.05)" />
        </svg>
    );
}
