"use client";

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { usePlayer } from "./player-context";
import {
    EQEngine,
    DEFAULT_BANDS,
    DEFAULT_EFFECTS,
    EQ_PRESETS,
    type EQBand,
    type EffectState,
} from "@/lib/eq-engine";

// ─── Types ───────────────────────────────────────────────────────────────

interface EQState {
    enabled: boolean;
    bands: EQBand[];
    preGain: number;         // dB, -12 to +12
    effects: EffectState;
    activePreset: string | null;
    mode: "easy" | "advanced";
}

interface EQActions {
    toggle: () => void;
    setBandGain: (index: number, gain: number) => void;
    setBandQ: (index: number, Q: number) => void;
    setPreGain: (gain: number) => void;
    applyPreset: (name: string) => void;
    resetAll: () => void;
    setEffect: <K extends keyof EffectState>(key: K, value: EffectState[K]) => void;
    setEffects: (partial: Partial<EffectState>) => void;
    setMode: (mode: "easy" | "advanced") => void;
    // Easy mode helpers (3-band)
    setEasyBass: (gain: number) => void;
    setEasyMid: (gain: number) => void;
    setEasyTreble: (gain: number) => void;
    getEasyBass: () => number;
    getEasyMid: () => number;
    getEasyTreble: () => number;
    // Engine access
    getCompressorReduction: () => number;
    connectEngine: (ctx: AudioContext, source: MediaElementAudioSourceNode, analyser: AnalyserNode) => void;
    /** Route an additional source (e.g. video) through the existing engine.
     *  Idempotent per-source. The source's existing analyser connection is
     *  preserved so visualizations keep working. */
    connectVideoSource: (source: MediaElementAudioSourceNode, analyser: AnalyserNode) => void;
}

type EQContextType = EQState & EQActions;

// ─── Storage ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "music-organizer-eq";

function loadEQState(): Partial<EQState> {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function saveEQState(state: EQState) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            enabled: state.enabled,
            bands: state.bands,
            preGain: state.preGain,
            effects: state.effects,
            activePreset: state.activePreset,
            mode: state.mode,
        }));
    } catch { /* storage full */ }
}

// ─── Context ─────────────────────────────────────────────────────────────

const EQContext = createContext<EQContextType | null>(null);

export function useEQ() {
    const ctx = useContext(EQContext);
    if (!ctx) throw new Error("useEQ must be used within EQProvider");
    return ctx;
}

// ─── Provider ────────────────────────────────────────────────────────────

export function EQProvider({ children }: { children: ReactNode }) {
    const engineRef = useRef<EQEngine | null>(null);
    const connectedRef = useRef(false);
    const videoSourcesRef = useRef<WeakSet<MediaElementAudioSourceNode>>(new WeakSet());

    const [state, setState] = useState<EQState>(() => {
        const saved = loadEQState();
        return {
            enabled: saved.enabled ?? false,
            bands: saved.bands ?? DEFAULT_BANDS.map(b => ({ ...b })),
            preGain: saved.preGain ?? 0,
            effects: saved.effects ?? { ...DEFAULT_EFFECTS },
            activePreset: saved.activePreset ?? null,
            mode: saved.mode ?? "easy",
        };
    });

    // Persist on change
    useEffect(() => {
        saveEQState(state);
    }, [state]);

    // Sync engine when state changes
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;

        if (state.enabled) {
            engine.setPreGain(Math.pow(10, state.preGain / 20));
            state.bands.forEach((b, i) => {
                engine.setBandGain(i, b.gain);
                engine.setBandQ(i, b.Q);
            });
        } else {
            // Bypass: flat gains
            engine.setPreGain(1);
            state.bands.forEach((_, i) => engine.setBandGain(i, 0));
        }
    }, [state.enabled, state.bands, state.preGain]);

    // Sync effects
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        const e = state.effects;
        const active = state.enabled;
        engine.updateCompressor(
            active && e.compressorEnabled, e.compressorThreshold, e.compressorKnee,
            e.compressorRatio, e.compressorAttack, e.compressorRelease
        );
        engine.updateReverb(active && e.reverbEnabled, e.reverbMix, e.reverbDecay);
        engine.updateDelay(active && e.delayEnabled, e.delayTime, e.delayFeedback, e.delayMix);
        engine.updateBassBoost(active && e.bassBoostEnabled, e.bassBoostAmount);
    }, [state.enabled, state.effects]);

    // Connect the engine to an existing AudioContext
    const connectEngine = useCallback((ctx: AudioContext, source: MediaElementAudioSourceNode, analyser: AnalyserNode) => {
        if (connectedRef.current) return;

        const engine = new EQEngine(ctx);
        engineRef.current = engine;

        // Disconnect source → analyser, re-route through engine
        source.disconnect();
        source.connect(engine.input);
        engine.output.connect(analyser);
        // analyser → destination is already connected

        connectedRef.current = true;
    }, []);

    // Route a second source (typically the <video> element) through the same engine.
    const connectVideoSource = useCallback((source: MediaElementAudioSourceNode, analyser: AnalyserNode) => {
        const engine = engineRef.current;
        if (!engine) return;
        if (videoSourcesRef.current.has(source)) return;
        try {
            source.disconnect(analyser);
        } catch { /* not connected */ }
        source.connect(engine.input);
        // engine.output is already connected to the analyser; one fan-in works for both.
        videoSourcesRef.current.add(source);
    }, []);

    // Auto-connect to player's audio nodes
    const player = usePlayer();
    useEffect(() => {
        if (connectedRef.current) return;
        const nodes = player.getAudioNodes();
        if (!nodes) return;
        connectEngine(nodes.ctx, nodes.source, nodes.analyser);
    });

    // Route video source through the same engine when it becomes available.
    useEffect(() => {
        if (!player.currentVideo) return;
        const vnodes = player.getVideoNodes();
        if (!vnodes) return;
        connectVideoSource(vnodes.source, vnodes.analyser);
    }, [player.currentVideo, player, connectVideoSource]);

    const toggle = useCallback(() => {
        setState(s => ({ ...s, enabled: !s.enabled }));
    }, []);

    const setBandGain = useCallback((index: number, gain: number) => {
        setState(s => {
            const bands = s.bands.map((b, i) => i === index ? { ...b, gain } : b);
            return { ...s, bands, activePreset: null };
        });
    }, []);

    const setBandQ = useCallback((index: number, Q: number) => {
        setState(s => {
            const bands = s.bands.map((b, i) => i === index ? { ...b, Q } : b);
            return { ...s, bands };
        });
    }, []);

    const setPreGain = useCallback((preGain: number) => {
        setState(s => ({ ...s, preGain }));
    }, []);

    const applyPreset = useCallback((name: string) => {
        const preset = EQ_PRESETS.find(p => p.name === name);
        if (!preset) return;
        setState(s => ({
            ...s,
            bands: s.bands.map((b, i) => ({ ...b, gain: preset.bands[i] ?? 0 })),
            activePreset: name,
            enabled: true,
        }));
    }, []);

    const resetAll = useCallback(() => {
        setState(s => ({
            ...s,
            bands: DEFAULT_BANDS.map(b => ({ ...b })),
            preGain: 0,
            effects: { ...DEFAULT_EFFECTS },
            activePreset: "Flat",
        }));
    }, []);

    const setEffect = useCallback(<K extends keyof EffectState>(key: K, value: EffectState[K]) => {
        setState(s => ({
            ...s,
            effects: { ...s.effects, [key]: value },
        }));
    }, []);

    const setEffects = useCallback((partial: Partial<EffectState>) => {
        setState(s => ({
            ...s,
            effects: { ...s.effects, ...partial },
        }));
    }, []);

    const setMode = useCallback((mode: "easy" | "advanced") => {
        setState(s => ({ ...s, mode }));
    }, []);

    // Easy mode: map 3 bands (bass=avg of 0-2, mid=avg of 3-6, treble=avg of 7-9)
    const getEasyBass = useCallback(() => {
        const { bands } = state;
        return (bands[0].gain + bands[1].gain + bands[2].gain) / 3;
    }, [state.bands]);

    const getEasyMid = useCallback(() => {
        const { bands } = state;
        return (bands[3].gain + bands[4].gain + bands[5].gain + bands[6].gain) / 4;
    }, [state.bands]);

    const getEasyTreble = useCallback(() => {
        const { bands } = state;
        return (bands[7].gain + bands[8].gain + bands[9].gain) / 3;
    }, [state.bands]);

    const setEasyBass = useCallback((gain: number) => {
        setState(s => ({
            ...s,
            bands: s.bands.map((b, i) =>
                i <= 2 ? { ...b, gain: Math.round(gain * 10) / 10 } : b
            ),
            activePreset: null,
        }));
    }, []);

    const setEasyMid = useCallback((gain: number) => {
        setState(s => ({
            ...s,
            bands: s.bands.map((b, i) =>
                i >= 3 && i <= 6 ? { ...b, gain: Math.round(gain * 10) / 10 } : b
            ),
            activePreset: null,
        }));
    }, []);

    const setEasyTreble = useCallback((gain: number) => {
        setState(s => ({
            ...s,
            bands: s.bands.map((b, i) =>
                i >= 7 ? { ...b, gain: Math.round(gain * 10) / 10 } : b
            ),
            activePreset: null,
        }));
    }, []);

    const getCompressorReduction = useCallback(() => {
        return engineRef.current?.getCompressorReduction() ?? 0;
    }, []);

    return (
        <EQContext.Provider value={{
            ...state,
            toggle,
            setBandGain,
            setBandQ,
            setPreGain,
            applyPreset,
            resetAll,
            setEffect,
            setEffects,
            setMode,
            setEasyBass,
            setEasyMid,
            setEasyTreble,
            getEasyBass,
            getEasyMid,
            getEasyTreble,
            getCompressorReduction,
            connectEngine,
            connectVideoSource,
        }}>
            {children}
        </EQContext.Provider>
    );
}
