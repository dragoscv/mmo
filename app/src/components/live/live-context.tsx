"use client";

/**
 * LiveContext — React provider that owns a single LiveEngine instance,
 * subscribes to state changes, and runs the rAF meter loop.
 *
 * Children read state via `useLive()` and call action methods on the engine.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { LiveEngine, type LiveEngineState } from "@/lib/live-engine";
import type { FxInsert, FxType } from "@/lib/audio-fx-engine";
import { useRenderCount } from "@/lib/dev-debugger";
import { FX_DEFAULTS } from "@/lib/audio-fx-engine";
import { useWebRTCAudioStream, type WebRTCAudioStreamApi } from "@/components/remote/use-webrtc-audio-stream";
import { uploadRecording } from "@/lib/upload-recording";
import { liveMetersStore, type LiveMetersSnapshot } from "@/components/live/live-meters-store";

const REFRESH_HZ_STORAGE_KEY = "live-ui-refresh-hz";
const REFRESH_HZ_EVENT = "mmo-ui-refresh-hz-changed";
const REFRESH_HZ_DEFAULT = 4;
// Allow the slider to genuinely slow the meters loop. The Tuner / Coach become
// glanceable at 1-2Hz; peak meters tolerate it because they smooth via decay.
const METER_HZ_FLOOR = 1;
const METER_HZ_CEIL = 30;

function readRefreshHz(): number {
    try {
        const raw = typeof window !== "undefined" ? localStorage.getItem(REFRESH_HZ_STORAGE_KEY) : null;
        const n = raw ? parseFloat(raw) : NaN;
        if (!isFinite(n)) return REFRESH_HZ_DEFAULT;
        return Math.max(METER_HZ_FLOOR, Math.min(METER_HZ_CEIL, n));
    } catch {
        return REFRESH_HZ_DEFAULT;
    }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiveContextValue extends LiveEngineState {
    // Engine reference (escape hatch for advanced bridge use)
    engine: LiveEngine | null;
    isReady: boolean;
    // Voice state (live, not in engine.state)
    voiceActive: boolean;
    voiceInputDevices: MediaDeviceInfo[];
    voiceInputDeviceId: string;
    voiceChain: FxInsert[];
    voiceInputGain: number;
    voiceOutputGain: number;
    voicePeakL: number;
    voicePeakR: number;

    // Master
    setMasterVolume: (v: number) => void;
    setMonitorVolume: (v: number) => void;
    // Tempo / Key
    setTempo: (bpm: number) => void;
    setKey: (idx: number) => void;
    setScale: (idx: number) => void;
    tapBpm: () => void;
    // Metronome
    toggleMetronome: () => void;
    setMetronomeMonitorOnly: (b: boolean) => void;
    setMetronomeVolume: (v: number) => void;
    // Recording
    toggleRecording: () => void;
    // Backing
    loadBackingFromFile: (file: File) => Promise<void>;
    loadBackingFromUrl: (url: string) => Promise<void>;
    unloadBacking: () => Promise<void>;
    backingToggle: () => void;
    backingStop: () => void;
    backingSeek: (s: number) => void;
    setBackingVolume: (v: number) => void;
    setBackingTempoRatio: (r: number) => void;
    setBackingPitchSemis: (s: number) => void;
    setBackingLoop: (b: boolean) => void;
    // Voice
    voiceStart: (deviceId?: string) => Promise<void>;
    voiceStop: () => Promise<void>;
    voiceSetInputDevice: (id: string) => Promise<void>;
    voiceSetInputGain: (v: number) => void;
    voiceSetOutputGain: (v: number) => void;
    voiceAddEffect: (type: FxType) => void;
    voiceRemoveEffect: (id: string) => void;
    voiceToggleEffect: (id: string) => void;
    voiceUpdateParam: (id: string, param: string, value: number) => void;
    voiceClearChain: () => void;
    voiceLoadPreset: (chain: FxInsert[]) => void;
    // Looper
    toggleLooper: (id: number) => void;
    clearLooper: (id: number) => void;
    setLooperVolume: (id: number, v: number) => void;
    toggleLooperMute: (id: number) => void;
    setLooperBeatLength: (b: number) => void;
    stopAllLoopers: () => void;
    // Pads
    loadPad: (id: number, file: File) => Promise<void>;
    triggerPad: (id: number) => void;
    stopPad: (id: number) => void;
    setPadVolume: (id: number, v: number) => void;
    setPadLoop: (id: number, loop: boolean) => void;
    clearPad: (id: number) => void;
    // WebRTC audio streaming with the connected remote peer
    stream: WebRTCAudioStreamApi;
}

const LiveContextRef = createContext<LiveContextValue | null>(null);

export function useLive(): LiveContextValue {
    const ctx = useContext(LiveContextRef);
    if (!ctx) throw new Error("useLive must be used within <LiveProvider>");
    return ctx;
}

export function useLiveOptional(): LiveContextValue | null {
    return useContext(LiveContextRef);
}

// ─── Provider ────────────────────────────────────────────────────────────────

const VOICE_CHAIN_STORAGE_KEY = "live-voice-chain";
const SETTINGS_STORAGE_KEY = "live-settings";

function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

export function LiveProvider({ children }: { children: ReactNode }) {
    useRenderCount("LiveProvider");
    const engineRef = useRef<LiveEngine | null>(null);
    // `stateTick` increments on actual engine state mutations (volume, tempo,
    // recording start/stop, …) — NOT every animation frame. Realtime meter
    // values are pushed to `liveMetersStore` and consumed via useLiveMeters.
    const [stateTick, setStateTick] = useState(0);
    const [isReady, setIsReady] = useState(false);

    // Voice-specific local state
    const [voiceActive, setVoiceActive] = useState(false);
    const [voiceInputDevices, setVoiceInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [voiceInputDeviceId, setVoiceInputDeviceId] = useState("default");
    const [voiceChain, setVoiceChain] = useState<FxInsert[]>([]);
    const [voiceInputGain, setVoiceInputGainState] = useState(1.0);
    const [voiceOutputGain, setVoiceOutputGainState] = useState(0.85);
    const voicePeaksRef = useRef({ peakL: 0, peakR: 0 });

    // Init engine on mount
    useEffect(() => {
        const engine = new LiveEngine();
        engineRef.current = engine;
        // Expose the engine's AudioContext globally so the Live Settings
        // modal can call setSinkId() to switch output devices.
        (window as unknown as { __mmo_live_ctx?: AudioContext }).__mmo_live_ctx = engine.ctx;
        engine.onStateChange = () => {
            setStateTick(t => t + 1);
        };

        // Restore persisted settings
        try {
            const savedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
            if (savedSettings) {
                const s = JSON.parse(savedSettings);
                if (typeof s.masterVolume === "number") engine.setMasterVolume(s.masterVolume);
                if (typeof s.monitorVolume === "number") engine.setMonitorVolume(s.monitorVolume);
                if (typeof s.tempo === "number") engine.setTempo(s.tempo);
                if (typeof s.keyIndex === "number") engine.setKey(s.keyIndex);
                if (typeof s.scaleIndex === "number") engine.setScale(s.scaleIndex);
                if (typeof s.metronomeMonitorOnly === "boolean") engine.setMetronomeMonitorOnly(s.metronomeMonitorOnly);
                if (typeof s.metronomeVolume === "number") engine.setMetronomeVolume(s.metronomeVolume);
            }
            const savedChain = localStorage.getItem(VOICE_CHAIN_STORAGE_KEY);
            if (savedChain) {
                const parsed = JSON.parse(savedChain) as FxInsert[];
                setVoiceChain(parsed);
                engine.voice.setChain(parsed);
            }
        } catch { /* ignore */ }

        // Enumerate input devices
        engine.voice.enumerateInputDevices().then(devs => setVoiceInputDevices(devs));

        setIsReady(true);

        // ─── Meter loop ──────────────────────────────────────────────
        // Throttled to the user's configured refresh rate (clamped 4-30Hz for
        // meters specifically — tuner & coach can be slower if user prefers,
        // but peak meters look frozen below ~4fps). Pauses entirely when the
        // tab is hidden. Publishes to `liveMetersStore` instead of forcing
        // React re-renders so the rest of the page stays at full framerate.
        let raf = 0;
        let lastTickAt = 0;
        let intervalMs = 1000 / readRefreshHz();
        const onRefreshChange = () => { intervalMs = 1000 / readRefreshHz(); };
        window.addEventListener(REFRESH_HZ_EVENT, onRefreshChange);
        const onStorage = (e: StorageEvent) => { if (e.key === REFRESH_HZ_STORAGE_KEY) onRefreshChange(); };
        window.addEventListener("storage", onStorage);

        const loop = (now: number) => {
            if (now - lastTickAt >= intervalMs) {
                lastTickAt = now;
                const m = engine.tickMeters();
                voicePeaksRef.current.peakL = m.voiceMeter.peakL;
                voicePeaksRef.current.peakR = m.voiceMeter.peakR;
                const s = engine.state;
                const ac = engine.voice.getAutoCorrectStatus();
                // When the native (companion) engine is running it is the
                // sole writer for the voice / master / tuner fields below.
                // The browser engine sees silence in that case, and writing
                // its zeros at the same Hz as the native mirror would race
                // and visibly flicker the meters / tuner. We always publish
                // recording + backing positions (the browser engine still
                // owns those paths even in native mode).
                const nativeRunning = liveMetersStore.getSnapshot().nativeRunning;
                const base: Partial<LiveMetersSnapshot> = {
                    isLimiting: s.isLimiting,
                    autoCorrectTargetMidi: ac.targetMidi ?? -1,
                    autoCorrectSourceMidi: ac.sourceMidi ?? NaN,
                    autoCorrectActive: ac.active,
                    recordingDuration: s.recordingDuration,
                    backingPosition: s.backingPosition,
                };
                if (!nativeRunning) {
                    Object.assign(base, {
                        masterPeakL: s.masterPeakL,
                        masterPeakR: s.masterPeakR,
                        voicePeakL: m.voiceMeter.peakL,
                        voicePeakR: m.voiceMeter.peakR,
                        voiceRms: m.voiceMeter.rms,
                        tunerNote: s.tunerNote,
                        tunerNoteIndex: m.voiceMeter.pitch.noteIndex,
                        tunerCents: s.tunerCents,
                        tunerFrequency: s.tunerFrequency,
                        tunerConfidence: s.tunerConfidence,
                    });
                }
                liveMetersStore.publish(base);
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);

        const onVisibility = () => {
            if (document.hidden) {
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
            } else if (raf === 0) {
                lastTickAt = 0;
                raf = requestAnimationFrame(loop);
            }
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            document.removeEventListener("visibilitychange", onVisibility);
            window.removeEventListener(REFRESH_HZ_EVENT, onRefreshChange);
            window.removeEventListener("storage", onStorage);
            if (raf) cancelAnimationFrame(raf);
            liveMetersStore.reset();
            void engine.destroy();
            engineRef.current = null;
        };
    }, []);

    // Persist settings periodically
    useEffect(() => {
        if (!engineRef.current) return;
        const s = engineRef.current.state;
        const id = setTimeout(() => {
            try {
                localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
                    masterVolume: s.masterVolume,
                    monitorVolume: s.monitorVolume,
                    tempo: s.tempo,
                    keyIndex: s.keyIndex,
                    scaleIndex: s.scaleIndex,
                    metronomeMonitorOnly: s.metronomeMonitorOnly,
                    metronomeVolume: s.metronomeVolume,
                }));
            } catch { /* ignore */ }
        }, 500);
        return () => clearTimeout(id);
    });

    // Persist voice chain when it changes
    useEffect(() => {
        try {
            localStorage.setItem(VOICE_CHAIN_STORAGE_KEY, JSON.stringify(voiceChain));
        } catch { /* ignore */ }
    }, [voiceChain]);

    // ─── Action wrappers ────────────────────────────────────────────────

    const setMasterVolume = useCallback((v: number) => engineRef.current?.setMasterVolume(v), []);
    const setMonitorVolume = useCallback((v: number) => engineRef.current?.setMonitorVolume(v), []);
    const setTempo = useCallback((v: number) => engineRef.current?.setTempo(v), []);
    const setKey = useCallback((v: number) => engineRef.current?.setKey(v), []);
    const setScale = useCallback((v: number) => engineRef.current?.setScale(v), []);
    const tapBpm = useCallback(() => engineRef.current?.tapBpm(), []);
    const toggleMetronome = useCallback(() => engineRef.current?.toggleMetronome(), []);
    const setMetronomeMonitorOnly = useCallback((b: boolean) => engineRef.current?.setMetronomeMonitorOnly(b), []);
    const setMetronomeVolume = useCallback((v: number) => engineRef.current?.setMetronomeVolume(v), []);
    const toggleRecording = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;
        if (engine.state.isRecording) {
            void engine.stopRecordingAsync().then(result => {
                if (!result) return;
                void uploadRecording({
                    source: "live",
                    blob: result.blob,
                    durationMs: result.duration,
                    metadata: {
                        tempo: engine.state.tempo,
                        keyIndex: engine.state.keyIndex,
                        scaleIndex: engine.state.scaleIndex,
                        backingName: engine.state.backingName,
                    },
                });
            });
        } else {
            void engine.startRecording();
        }
    }, []);

    const loadBackingFromFile = useCallback(async (file: File) => { await engineRef.current?.loadBackingTrack(file); }, []);
    const loadBackingFromUrl = useCallback(async (url: string) => { await engineRef.current?.loadBackingTrack(url); }, []);
    const unloadBacking = useCallback(async () => { await engineRef.current?.unloadBackingTrack(); }, []);
    const backingToggle = useCallback(() => engineRef.current?.backingToggle(), []);
    const backingStop = useCallback(() => engineRef.current?.backingStop(), []);
    const backingSeek = useCallback((s: number) => engineRef.current?.backingSeek(s), []);
    const setBackingVolume = useCallback((v: number) => engineRef.current?.setBackingVolume(v), []);
    const setBackingTempoRatio = useCallback((r: number) => engineRef.current?.setBackingTempoRatio(r), []);
    const setBackingPitchSemis = useCallback((s: number) => engineRef.current?.setBackingPitchSemis(s), []);
    const setBackingLoop = useCallback((b: boolean) => engineRef.current?.setBackingLoop(b), []);

    // ── Voice ──
    const voiceStart = useCallback(async (deviceId?: string) => {
        const e = engineRef.current;
        if (!e) return;
        if (e.ctx.state === "suspended") await e.ctx.resume();
        const ok = await e.voice.startInput(deviceId ?? voiceInputDeviceId);
        if (ok) {
            setVoiceActive(true);
            // Refresh device list (now we have permission, labels populate)
            const devs = await e.voice.enumerateInputDevices();
            setVoiceInputDevices(devs);
        }
    }, [voiceInputDeviceId]);

    const voiceStop = useCallback(async () => {
        await engineRef.current?.voice.stopInput();
        setVoiceActive(false);
    }, []);

    const voiceSetInputDevice = useCallback(async (id: string) => {
        setVoiceInputDeviceId(id);
        if (voiceActive) {
            await engineRef.current?.voice.startInput(id);
        }
    }, [voiceActive]);

    // ── Native takeover ──────────────────────────────────────────────
    //
    // When the native (companion) audio engine is running, the browser's
    // voice path MUST step out of the way so the user hears ONE sound,
    // consistently, regardless of which window has focus.
    //
    // Two distinct browser-side audio sources can leak through if we're
    // not careful:
    //
    //   1. MIC CAPTURE — the browser's MediaStream still routes the same
    //      physical input to the FX chain → speakers. Two consumers of
    //      the same mic = two slightly out-of-phase processed copies.
    //
    //   2. FX CHAIN MONITOR PATH — even after we stop the mic, the
    //      browser's FX chain (Noise Suppression, Compressor, Reverb,
    //      etc.) is still wired voice.output → voiceMonitorGain →
    //      mainBus → speakers. Reverb tails, compressor noise floor and
    //      makeup gain on the empty signal still produce audible
    //      artefacts that change with focus because Chromium adjusts
    //      worklet message-port scheduling for hidden / occluded tabs.
    //
    // We close BOTH leaks while native is running:
    //   - stopInput() → release the mic device (also avoids the dual
    //     capture problem on the OS side).
    //   - setVoiceMonitor(false) → ramp voiceMonitorGain to zero so the
    //     FX chain output is muted at the bus. The FX chain itself
    //     keeps running (so it stays warm and the user can A/B native
    //     vs browser instantly with no glitch), but contributes zero
    //     signal to the speakers. Loopers + backing tracks are
    //     UNAFFECTED — they connect to mainBus on different paths.
    //
    // Note: native engine only does pitch correction. The browser FX
    // chain (Noise Sup, Compressor, Reverb) is intentionally bypassed
    // when native is on; that's the latency / fidelity trade-off the
    // user has explicitly opted into by clicking Native ON.
    useEffect(() => {
        if (!voiceActive) return;
        let prevNative = false;
        const apply = async (running: boolean) => {
            if (running === prevNative) return;
            prevNative = running;
            const e = engineRef.current;
            if (!e) return;
            if (running) {
                // Native took over — close both browser audio paths.
                try { await e.voice.stopInput(); } catch { /* ignore */ }
                try { e.setVoiceMonitor(false); } catch { /* ignore */ }
            } else {
                // Native released — restore both browser paths.
                try { e.setVoiceMonitor(true); } catch { /* ignore */ }
                try { await e.voice.startInput(voiceInputDeviceId); } catch { /* ignore */ }
            }
        };
        // Apply current state on mount / re-run.
        void apply(liveMetersStore.getSnapshot().nativeRunning);
        const unsub = liveMetersStore.subscribe(() => {
            void apply(liveMetersStore.getSnapshot().nativeRunning);
        });
        return () => { unsub(); };
    }, [voiceActive, voiceInputDeviceId]);

    const voiceSetInputGain = useCallback((v: number) => {
        const e = engineRef.current;
        if (!e) return;
        const clamped = Math.max(0, Math.min(2, v));
        setVoiceInputGainState(clamped);
        e.voice.input.gain.value = clamped;
    }, []);

    const voiceSetOutputGain = useCallback((v: number) => {
        const e = engineRef.current;
        if (!e) return;
        const clamped = Math.max(0, Math.min(2, v));
        setVoiceOutputGainState(clamped);
        e.voice.output.gain.value = clamped;
    }, []);

    const voiceAddEffect = useCallback((type: FxType) => {
        const newInsert: FxInsert = {
            id: uid(),
            type,
            enabled: true,
            params: { ...FX_DEFAULTS[type] },
        };
        setVoiceChain(prev => {
            const next = [...prev, newInsert];
            engineRef.current?.voice.setChain(next);
            return next;
        });
    }, []);

    const voiceRemoveEffect = useCallback((id: string) => {
        setVoiceChain(prev => {
            const next = prev.filter(i => i.id !== id);
            engineRef.current?.voice.setChain(next);
            return next;
        });
    }, []);

    const voiceToggleEffect = useCallback((id: string) => {
        setVoiceChain(prev => {
            const next = prev.map(i => i.id === id ? { ...i, enabled: !i.enabled } : i);
            engineRef.current?.voice.setChain(next);
            return next;
        });
    }, []);

    const voiceUpdateParam = useCallback((id: string, param: string, value: number) => {
        setVoiceChain(prev => prev.map(i =>
            i.id === id ? { ...i, params: { ...i.params, [param]: value } } : i
        ));
        engineRef.current?.voice.updateInsertParam(id, param, value);
    }, []);

    const voiceClearChain = useCallback(() => {
        setVoiceChain([]);
        engineRef.current?.voice.setChain([]);
    }, []);

    const voiceLoadPreset = useCallback((chain: FxInsert[]) => {
        // Clone with fresh ids so the same preset can be loaded repeatedly
        // without colliding with existing inserts.
        const cloned: FxInsert[] = chain.map(i => ({
            id: uid(),
            type: i.type,
            enabled: i.enabled,
            params: { ...i.params },
        }));
        setVoiceChain(cloned);
        engineRef.current?.voice.setChain(cloned);
    }, []);

    // ── Looper ──
    const toggleLooper = useCallback((id: number) => engineRef.current?.toggleLooper(id), []);
    const clearLooper = useCallback((id: number) => engineRef.current?.clearLooper(id), []);
    const setLooperVolume = useCallback((id: number, v: number) => engineRef.current?.setLooperVolume(id, v), []);
    const toggleLooperMute = useCallback((id: number) => engineRef.current?.toggleLooperMute(id), []);
    const setLooperBeatLength = useCallback((b: number) => engineRef.current?.setLooperBeatLength(b), []);
    const stopAllLoopers = useCallback(() => engineRef.current?.stopAllLoopers(), []);

    // ── Pads ──
    const loadPad = useCallback(async (id: number, file: File) => { await engineRef.current?.loadPad(id, file); }, []);
    const triggerPad = useCallback((id: number) => engineRef.current?.triggerPad(id), []);
    const stopPad = useCallback((id: number) => engineRef.current?.stopPad(id), []);
    const setPadVolume = useCallback((id: number, v: number) => engineRef.current?.setPadVolume(id, v), []);
    const setPadLoop = useCallback((id: number, loop: boolean) => engineRef.current?.setPadLoop(id, loop), []);
    const clearPad = useCallback((id: number) => engineRef.current?.clearPad(id), []);

    // ── WebRTC streaming ──
    const stream = useWebRTCAudioStream({
        enabled: isReady,
        getOutputStream: () => {
            const e = engineRef.current;
            if (!e) throw new Error("Live engine not ready");
            return e.getOutputStream();
        },
        onRemoteStream: (s) => {
            engineRef.current?.attachRemoteInput(s);
        },
    });

    const engine = engineRef.current;
    const state = engine?.state;

    // Memoize the context value so consumers using `useLive()` don't re-render
    // on every meter tick. `stateTick` increments only when the engine notifies
    // an actual state mutation; meter ticks bypass this entirely and update
    // the external meters store instead.
    const value: LiveContextValue | null = useMemo(() => {
        if (!state || !engine) return null;
        return {
            engine,
            isReady,
            voiceActive,
            voiceInputDevices,
            voiceInputDeviceId,
            voiceChain,
            voiceInputGain,
            voiceOutputGain,
            voicePeakL: voicePeaksRef.current.peakL,
            voicePeakR: voicePeaksRef.current.peakR,
            ...state,
            setMasterVolume, setMonitorVolume,
            setTempo, setKey, setScale, tapBpm,
            toggleMetronome, setMetronomeMonitorOnly, setMetronomeVolume,
            toggleRecording,
            loadBackingFromFile, loadBackingFromUrl, unloadBacking,
            backingToggle, backingStop, backingSeek,
            setBackingVolume, setBackingTempoRatio, setBackingPitchSemis, setBackingLoop,
            voiceStart, voiceStop, voiceSetInputDevice,
            voiceSetInputGain, voiceSetOutputGain,
            voiceAddEffect, voiceRemoveEffect, voiceToggleEffect, voiceUpdateParam, voiceClearChain, voiceLoadPreset,
            toggleLooper, clearLooper, setLooperVolume, toggleLooperMute, setLooperBeatLength, stopAllLoopers,
            loadPad, triggerPad, stopPad, setPadVolume, setPadLoop, clearPad,
            stream,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        engine, stateTick, isReady,
        voiceActive, voiceInputDevices, voiceInputDeviceId, voiceChain,
        voiceInputGain, voiceOutputGain,
        stream,
        // Action callbacks are all useCallback'd with stable deps and don't need to be listed here.
    ]);

    return (
        <LiveContextRef.Provider value={value}>
            {value ? children : (
                <div className="flex items-center justify-center h-full text-white/40 text-sm">
                    Initializing live engine…
                </div>
            )}
        </LiveContextRef.Provider>
    );
}
