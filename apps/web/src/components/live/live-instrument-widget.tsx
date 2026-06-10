"use client";

/**
 * LiveInstrumentWidget — re-voices the live mic input through a chosen
 * instrument timbre (piano, violin, organ, …). Tracks pitch and amplitude
 * from the existing voice processor analyser, drives an InstrumentSynth.
 *
 * Provides quick transpose buttons (-12 / -7 / -1 / 0 / +1 / +7 / +12),
 * instrument selection, volume, and a portamento control.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLive } from "@/components/live/live-context";
import {
    InstrumentSynth,
    INSTRUMENT_PRESETS,
    type InstrumentId,
    type InstrumentPreset,
} from "@/lib/instrument-synth";
import { cn } from "@/lib/utils";
import { Music2, Volume2, RotateCcw, Mic, MicOff } from "lucide-react";

const STORAGE_KEY = "live-instrument-state-v1";

interface PersistedState {
    enabled: boolean;
    instrument: InstrumentId;
    transpose: number;
    volume: number;
    portamentoMs: number | null;
    /** Hear the dry mic alongside the instrument synth.
     *  When false, the mic is muted on the master mix so only the
     *  re-voiced instrument is audible. */
    hearMic: boolean;
}

const DEFAULT_STATE: PersistedState = {
    enabled: false,
    instrument: "piano",
    transpose: 0,
    volume: 0.6,
    portamentoMs: null,
    hearMic: true,
};

function loadState(): PersistedState {
    try {
        const raw = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
        if (!raw) return DEFAULT_STATE;
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...parsed };
    } catch {
        return DEFAULT_STATE;
    }
}

function saveState(s: PersistedState): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch {
        /* ignore */
    }
}

export function LiveInstrumentWidget() {
    const live = useLive();
    const synthRef = useRef<InstrumentSynth | null>(null);

    const [state, setState] = useState<PersistedState>(() => loadState());

    // Build / destroy the synth alongside the engine.
    useEffect(() => {
        if (!live.engine) return;
        const engine = live.engine;
        const synth = new InstrumentSynth(engine.ctx);
        // Route synth to a dedicated bus that's NOT downstream of the voice
        // output so muting the mic doesn't mute the synth.
        synth.output.connect(engine.instrumentBus);
        synthRef.current = synth;
        // Apply persisted state immediately.
        synth.setInstrument(state.instrument);
        synth.setTranspose(state.transpose);
        synth.setVolume(state.volume);
        synth.setPortamento(state.portamentoMs);
        synth.setEnabled(state.enabled);

        return () => {
            try { synth.output.disconnect(); } catch { /* */ }
            synth.destroy();
            synthRef.current = null;
            // Always restore mic monitor when the widget unmounts so we don't
            // leave the user silenced.
            try { engine.setVoiceMonitor(true, 30); } catch { /* */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [live.engine]);

    // Apply state changes to synth + persist.
    useEffect(() => {
        const synth = synthRef.current;
        if (!synth) return;
        synth.setInstrument(state.instrument);
        synth.setTranspose(state.transpose);
        synth.setVolume(state.volume);
        synth.setPortamento(state.portamentoMs);
        synth.setEnabled(state.enabled);
        saveState(state);
    }, [state]);

    // Sync mic monitor with the toggle. Only mute the mic when the synth is
    // actually enabled — otherwise we'd silence the user with nothing
    // audible to take its place.
    useEffect(() => {
        const engine = live.engine;
        if (!engine) return;
        const wantMic = state.hearMic || !state.enabled;
        engine.setVoiceMonitor(wantMic, 40);
    }, [live.engine, state.hearMic, state.enabled]);

    // Pitch + RMS feed: subscribe directly to the engine's 250 Hz pitch
    // driver instead of going through `useLiveMeters`. The React meters
    // store is throttled to the user's UI refresh-rate (default 4 Hz),
    // which means a 250 ms phase delay on instrument retunes — totally
    // unacceptable for an instrument synth. The engine exposes a fast
    // listener API that fires on every YIN tick (~4 ms) and bypasses
    // React's reconciler entirely.
    useEffect(() => {
        const engine = live.engine;
        if (!engine) return;
        if (!state.enabled) return;
        const synth = synthRef.current;
        if (!synth) return;
        const unsub = engine.voice.addPitchListener(({ noteIndex, confidence, rms }) => {
            // Direct call into the synth's per-tick state machine. No
            // React state writes here — we never want to schedule a
            // re-render at 250 Hz.
            synth.updatePitch(noteIndex, confidence, rms);
        });
        return unsub;
    }, [live.engine, state.enabled]);

    // ─── Instruments grouped by family ───────────────────────────────
    const grouped = useMemo(() => {
        const out: Record<string, InstrumentPreset[]> = {};
        for (const p of INSTRUMENT_PRESETS) {
            (out[p.family] ??= []).push(p);
        }
        return out;
    }, []);

    function setInstrument(id: InstrumentId) {
        setState((s) => ({ ...s, instrument: id }));
    }
    function setTranspose(t: number) {
        setState((s) => ({ ...s, transpose: Math.max(-48, Math.min(48, t)) }));
    }
    function bumpTranspose(delta: number) {
        setState((s) => ({ ...s, transpose: Math.max(-48, Math.min(48, s.transpose + delta)) }));
    }
    function setVolume(v: number) {
        setState((s) => ({ ...s, volume: Math.max(0, Math.min(1, v)) }));
    }
    function setEnabled(on: boolean) {
        setState((s) => ({ ...s, enabled: on }));
    }
    function setHearMic(on: boolean) {
        setState((s) => ({ ...s, hearMic: on }));
    }
    function setPortamento(ms: number) {
        setState((s) => ({ ...s, portamentoMs: ms }));
    }

    const transposeAbs = state.transpose;
    const transposeLabel =
        transposeAbs === 0
            ? "No transpose"
            : `${transposeAbs > 0 ? "+" : ""}${transposeAbs} semi (${(transposeAbs / 12).toFixed(transposeAbs % 12 === 0 ? 0 : 2)} oct)`;

    return (
        <div className="space-y-3 p-1">
            {/* Header row: enable + instrument name + reset transpose */}
            <div className="flex items-center gap-2">
                <button
                    onClick={() => setEnabled(!state.enabled)}
                    className={cn(
                        "px-3 h-8 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer",
                        state.enabled
                            ? "bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 shadow-[0_0_12px_rgba(16,185,129,0.25)]"
                            : "bg-white/[0.04] text-white/40 border border-white/10 hover:text-white/70",
                    )}
                    title={state.enabled ? "Disable instrument synth" : "Enable instrument synth"}
                >
                    <Music2 className="w-3.5 h-3.5" />
                    {state.enabled ? "On" : "Off"}
                </button>
                <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-white/30 uppercase tracking-wider">Instrument</div>
                    <div className="text-sm font-medium text-white/85 truncate">
                        {INSTRUMENT_PRESETS.find((p) => p.id === state.instrument)?.name}
                    </div>
                </div>
                <div className="text-right">
                    <div className="text-[10px] text-white/30 uppercase tracking-wider">Transpose</div>
                    <div
                        className={cn(
                            "text-sm font-medium tabular-nums",
                            state.transpose === 0 ? "text-white/60" : "text-amber-300",
                        )}
                        title={transposeLabel}
                    >
                        {state.transpose > 0 ? "+" : ""}
                        {state.transpose}
                    </div>
                </div>
            </div>

            {/* Mic monitor toggle: choose whether to also hear the dry mic. */}
            <button
                onClick={() => setHearMic(!state.hearMic)}
                disabled={!state.enabled}
                title={
                    !state.enabled
                        ? "Enable the instrument to control mic monitoring"
                        : state.hearMic
                            ? "You hear BOTH your real voice and the instrument. Click to mute mic and hear only the instrument."
                            : "Mic is muted on the master \u2014 you hear ONLY the instrument. Click to also hear your voice."
                }
                className={cn(
                    "w-full flex items-center justify-between gap-2 px-3 h-9 rounded-lg text-xs transition-all border cursor-pointer",
                    !state.enabled && "opacity-40 cursor-not-allowed",
                    state.enabled && state.hearMic && "bg-cyan-500/15 text-cyan-200 border-cyan-500/30 hover:bg-cyan-500/20",
                    state.enabled && !state.hearMic && "bg-amber-500/15 text-amber-200 border-amber-500/30 hover:bg-amber-500/20",
                    !state.enabled && "bg-white/[0.04] text-white/40 border-white/10",
                )}
            >
                <span className="flex items-center gap-2">
                    {state.hearMic ? (
                        <Mic className="w-3.5 h-3.5" />
                    ) : (
                        <MicOff className="w-3.5 h-3.5" />
                    )}
                    <span className="font-medium">
                        {state.hearMic ? "Hear mic + instrument" : "Instrument only (mic muted)"}
                    </span>
                </span>
                <span
                    className={cn(
                        "relative inline-flex h-4 w-7 rounded-full transition-colors",
                        state.hearMic ? "bg-cyan-500/40" : "bg-amber-500/40",
                    )}
                >
                    <span
                        className={cn(
                            "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all",
                            state.hearMic ? "left-3.5" : "left-0.5",
                        )}
                    />
                </span>
            </button>

            {/* Transpose buttons */}
            <div className="grid grid-cols-7 gap-1">
                {[
                    { d: -12, label: "-12", title: "Down 1 octave" },
                    { d: -7, label: "-7", title: "Down a fifth" },
                    { d: -1, label: "-1", title: "Down a semitone" },
                    { d: 0, label: "0", title: "Reset", reset: true },
                    { d: 1, label: "+1", title: "Up a semitone" },
                    { d: 7, label: "+7", title: "Up a fifth" },
                    { d: 12, label: "+12", title: "Up 1 octave" },
                ].map((b) => (
                    <button
                        key={b.label}
                        onClick={() => (b.reset ? setTranspose(0) : bumpTranspose(b.d))}
                        title={b.title}
                        className={cn(
                            "h-9 rounded-lg text-xs font-semibold tabular-nums transition-all cursor-pointer",
                            "bg-white/[0.04] text-white/60 border border-white/10 hover:bg-white/[0.08] hover:text-white/85",
                            "active:scale-[0.97]",
                            b.reset && "text-amber-300/80 border-amber-500/20 hover:border-amber-500/40",
                        )}
                    >
                        {b.reset ? <RotateCcw className="w-3.5 h-3.5 mx-auto" /> : b.label}
                    </button>
                ))}
            </div>

            {/* Instrument grid grouped by family */}
            <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1 -mr-1 scrollbar-thin">
                {Object.entries(grouped).map(([family, presets]) => (
                    <div key={family} className="space-y-1">
                        <div className="text-[9px] text-white/25 uppercase tracking-widest">
                            {family}
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                            {presets.map((p) => (
                                <button
                                    key={p.id}
                                    onClick={() => setInstrument(p.id)}
                                    className={cn(
                                        "px-2 py-2 rounded-lg text-[11px] font-medium transition-all cursor-pointer text-left",
                                        state.instrument === p.id
                                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                            : "bg-white/[0.03] text-white/55 border border-transparent hover:bg-white/[0.06] hover:text-white/85",
                                    )}
                                >
                                    {p.name}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {/* Volume + Portamento */}
            <div className="space-y-2 pt-1">
                <label className="flex items-center gap-2 text-[10px] text-white/40">
                    <Volume2 className="w-3 h-3" />
                    <span className="uppercase tracking-wider">Volume</span>
                    <span className="ml-auto tabular-nums text-white/60">
                        {Math.round(state.volume * 100)}
                    </span>
                </label>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={state.volume}
                    onChange={(e) => setVolume(parseFloat(e.target.value))}
                    className="w-full accent-emerald-400"
                />

                <label className="flex items-center gap-2 text-[10px] text-white/40">
                    <span className="uppercase tracking-wider">Portamento</span>
                    <span className="ml-auto tabular-nums text-white/60">
                        {state.portamentoMs === null
                            ? "auto"
                            : `${state.portamentoMs} ms`}
                    </span>
                </label>
                <div className="flex items-center gap-2">
                    <input
                        type="range"
                        min={0}
                        max={300}
                        step={1}
                        value={state.portamentoMs ?? 20}
                        onChange={(e) => setPortamento(parseInt(e.target.value, 10))}
                        className="flex-1 accent-emerald-400"
                    />
                    <button
                        onClick={() => setState((s) => ({ ...s, portamentoMs: null }))}
                        className="text-[10px] px-2 py-1 rounded-md bg-white/[0.04] text-white/40 hover:text-white/80 cursor-pointer"
                        title="Use preset's default portamento"
                    >
                        auto
                    </button>
                </div>
            </div>

            <p className="text-[10px] text-white/30 leading-relaxed">
                Plays the detected pitch from your mic on the selected instrument.
                Sing or play a violin / guitar / kazoo / anything monophonic — the synth
                follows pitch and amplitude in real time.
            </p>
        </div>
    );
}
