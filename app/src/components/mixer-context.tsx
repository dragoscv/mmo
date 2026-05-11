"use client";

import {
    createContext,
    useContext,
    useRef,
    useState,
    useCallback,
    useEffect,
    useMemo,
    type ReactNode,
} from "react";
import { useRenderCount } from "@/lib/dev-debugger";
import {
    MixerEngine,
    DEFAULT_DECK_STATE,
    shiftKeyName,
    type DeckState,
    type DeckSide,
    type DeckMode,
    type FilterType,
    type ColorFxType,
    type BeatFxType,
    type PadMode,
    type CrossfaderCurve,
    type CrossfaderAssign,
    type EQMode,
    type WaveformMode,
    type SamplerSlot,
    type BeatGridState,
    type MixAction,
    type AutomixConfig,
    type AutomixMode,
    type TransitionSuggestion,
    calculateTransitionScore,
    getKeyCompatibility,
} from "@/lib/mixer-engine";
import type { Track } from "@/db/schema";
import { getTrackById } from "@/actions/tracks";
import { audioPreloadCache } from "@/lib/audio-preload-cache";
import { setDeckTime, getDeckTime, resetAllDeckTimes } from "@/lib/mixer-time-store";
import { getPersonalization } from "@/hooks/use-personalization";
import { requestConfirmLoad } from "./confirm-load-dialog";
import { uploadRecording } from "@/lib/upload-recording";
import { musicalKeyToCamelot } from "@/lib/genre-suggest";

// ─── Types ───────────────────────────────────────────────────────────────

interface MixerState {
    deckA: DeckState;
    deckB: DeckState;
    deckC: DeckState;
    deckD: DeckState;
    deckATrack: Track | null;
    deckBTrack: Track | null;
    deckCTrack: Track | null;
    deckDTrack: Track | null;
    deckMode: DeckMode;
    crossfader: number; // 0 = full A, 0.5 = center, 1 = full B
    crossfaderCurve: CrossfaderCurve;
    masterVolume: number;
    headphoneVolume: number;
    headphoneMix: number; // 0 = cue only, 1 = master only
    isActive: boolean; // whether mixer is initialized
    isRecording: boolean;
    recordingDuration: number; // ms
    eqMode: EQMode;
    tempoRange: number; // ±% (6, 10, 16, 25)
    jogSensitivity: number; // 1-10
    sessionHistory: { trackTitle: string; artist: string; deck: string; loadedAt: number; playedAt?: number }[];
    // New state fields
    waveformMode: WaveformMode;
    samplerSlots: SamplerSlot[];
    automixConfig: AutomixConfig;
    automixEnabled: boolean;
    mixHistory: MixAction[];
    transitionSuggestions: TransitionSuggestion[];
    midiClockEnabled: boolean;
    midiClockBpm: number;
    // Session restoration
    isRestoring: boolean;
    restorationProgress: number; // 0-100
    restorationLabel: string;
}

interface DeckActions {
    loadTrack: (deck: DeckSide, track: Track) => void;
    play: (deck: DeckSide) => void;
    pause: (deck: DeckSide) => void;
    togglePlay: (deck: DeckSide) => void;
    seek: (deck: DeckSide, time: number) => void;
    beatJump: (deck: DeckSide, beats: number) => void;
    nudge: (deck: DeckSide, ms: number) => void;
    nudgeRelease: (deck: DeckSide) => void;
    setVolume: (deck: DeckSide, vol: number) => void;
    setEQ: (deck: DeckSide, band: "low" | "mid" | "hi", gain: number) => void;
    toggleEQKill: (deck: DeckSide, band: "low" | "mid" | "hi") => void;
    setBpm: (deck: DeckSide, bpm: number) => void;
    syncBpm: (deck: DeckSide) => void;
    setKeyShift: (deck: DeckSide, semitones: number) => void;
    setKeyLock: (deck: DeckSide, enabled: boolean) => void;
    setFilter: (deck: DeckSide, value: number) => void;
    setFilterType: (deck: DeckSide, type: FilterType) => void;
    setColorFx: (deck: DeckSide, value: number) => void;
    setColorFxType: (deck: DeckSide, type: ColorFxType) => void;
    setBeatFx: (deck: DeckSide, type: BeatFxType) => void;
    setBeatFxAmount: (deck: DeckSide, amount: number) => void;
    toggleBeatFx: (deck: DeckSide) => void;
    setBeatFxBeatDiv: (deck: DeckSide, div: number) => void;
    setLoop: (deck: DeckSide, beats: number) => void;
    toggleLoop: (deck: DeckSide) => void;
    moveLoop: (deck: DeckSide, direction: "left" | "right") => void;
    setHotCue: (deck: DeckSide, index: number) => void;
    jumpHotCue: (deck: DeckSide, index: number) => void;
    clearHotCue: (deck: DeckSide, index: number) => void;
    ejectTrack: (deck: DeckSide) => void;
    toggleSlipMode: (deck: DeckSide) => void;
    toggleQuantize: (deck: DeckSide) => void;
    toggleHeadphoneCue: (deck: DeckSide) => void;
    setPadMode: (deck: DeckSide, mode: PadMode) => void;
    setCrossfaderAssign: (deck: DeckSide, assign: CrossfaderAssign) => void;
    setBeatGrid: (deck: DeckSide, grid: Partial<BeatGridState>) => void;
    nudgeBeatGrid: (deck: DeckSide, direction: "left" | "right") => void;
}

interface MixerActions extends DeckActions {
    setCrossfader: (value: number) => void;
    setCrossfaderCurve: (curve: CrossfaderCurve) => void;
    setMasterVolume: (value: number) => void;
    setHeadphoneVolume: (value: number) => void;
    setHeadphoneMix: (mix: number) => void;
    setEQMode: (mode: EQMode) => void;
    setTempoRange: (range: number) => void;
    setJogSensitivity: (sens: number) => void;
    setDeckMode: (mode: DeckMode) => void;
    toggleRecording: () => void;
    initMixer: () => void;
    destroyMixer: () => void;
    getDeckAnalyser: (deck: DeckSide) => AnalyserNode | null;
    getMasterAnalyser: () => AnalyserNode | null;
    getAudioInfo: () => { sampleRate: number; baseLatency: number; outputLatency: number; channelCount: number; state: string } | null;
    getDeckStems: (deck: DeckSide) => import("@/lib/stems-engine").RealtimeStemProcessor | null;
    // New actions
    setWaveformMode: (mode: WaveformMode) => void;
    triggerSampler: (slotIndex: number) => void;
    stopSampler: (slotIndex: number) => void;
    loadSample: (slotIndex: number, url: string, name?: string) => void;
    loadSampleFromFile: (slotIndex: number, file: File) => Promise<boolean>;
    clearSampler: (slotIndex: number) => void;
    toggleSamplerLoop: (slotIndex: number) => void;
    captureLoopToSampler: (deck: DeckSide, slotIndex: number) => void;
    setAutomixConfig: (config: Partial<AutomixConfig>) => void;
    toggleAutomix: () => void;
    undoMixAction: () => void;
    computeTransitionSuggestions: (deck: DeckSide) => void;
    setMidiClockEnabled: (enabled: boolean) => void;
    /** Read current playback time directly from audio element — use in rAF loops to avoid React re-renders */
    getDeckCurrentTime: (deck: DeckSide) => number;
}

type MixerContextType = MixerState & MixerActions;

// ─── Context (split: state changes often, actions are stable) ────────────

const MixerStateContext = createContext<MixerState | null>(null);
const MixerActionsContext = createContext<MixerActions | null>(null);

/** Full mixer context — returns both state + actions. Use when you need both. */
export function useMixer() {
    const state = useContext(MixerStateContext);
    const actions = useContext(MixerActionsContext);
    if (!state || !actions) throw new Error("useMixer must be used within MixerProvider");
    return { ...state, ...actions } as MixerContextType;
}

/** Only actions — components using this won't re-render on state changes. */
export function useMixerActions() {
    const actions = useContext(MixerActionsContext);
    if (!actions) throw new Error("useMixerActions must be used within MixerProvider");
    return actions;
}

/** Only state — use when you don't need to dispatch any actions. */
export function useMixerState() {
    const state = useContext(MixerStateContext);
    if (!state) throw new Error("useMixerState must be used within MixerProvider");
    return state;
}

// ─── Provider ────────────────────────────────────────────────────────────

const MIXER_STORAGE_KEY = "mmo-mixer-state";

interface PersistedDeckState {
    trackId: number | null;
    trackTitle: string;
    trackArtist: string;
    trackArtworkUrl: string | null;
    bpm: number;
    originalBpm: number;
    key: string;
    originalKey: string;
    keyShift: number;
    keyLock: boolean;
    volume: number;
    eqLow: number;
    eqMid: number;
    eqHi: number;
    eqLowKill: boolean;
    eqMidKill: boolean;
    eqHiKill: boolean;
    filter: number;
    filterType: FilterType;
    colorFx: number;
    colorFxType: ColorFxType;
    beatFxType: BeatFxType;
    beatFxAmount: number;
    beatFxOn: boolean;
    beatFxBeatDiv: number;
    loopEnabled: boolean;
    loopStart: number;
    loopEnd: number;
    loopBeats: number;
    hotCues: (number | null)[];
    currentTime: number;
    duration: number;
    headphoneCue: boolean;
    padMode: PadMode;
    crossfaderAssign: CrossfaderAssign;
    beatGrid: BeatGridState;
}

interface PersistedMixerState {
    deckA: PersistedDeckState;
    deckB: PersistedDeckState;
    deckC?: PersistedDeckState;
    deckD?: PersistedDeckState;
    deckMode?: DeckMode;
    crossfader: number;
    crossfaderCurve: CrossfaderCurve;
    masterVolume: number;
    headphoneVolume: number;
    headphoneMix: number;
    eqMode: EQMode;
    tempoRange: number;
    jogSensitivity: number;
    waveformMode: WaveformMode;
}

function loadPersistedState(): Partial<MixerState> | null {
    try {
        const raw = localStorage.getItem(MIXER_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}

function serializeDeck(deck: DeckState, liveTime: number): PersistedDeckState {
    return {
        trackId: deck.trackId,
        trackTitle: deck.trackTitle,
        trackArtist: deck.trackArtist,
        trackArtworkUrl: deck.trackArtworkUrl,
        bpm: deck.bpm,
        originalBpm: deck.originalBpm,
        key: deck.key,
        originalKey: deck.originalKey,
        keyShift: deck.keyShift,
        keyLock: deck.keyLock,
        volume: deck.volume,
        eqLow: deck.eqLow,
        eqMid: deck.eqMid,
        eqHi: deck.eqHi,
        eqLowKill: deck.eqLowKill,
        eqMidKill: deck.eqMidKill,
        eqHiKill: deck.eqHiKill,
        filter: deck.filter,
        filterType: deck.filterType,
        colorFx: deck.colorFx,
        colorFxType: deck.colorFxType,
        beatFxType: deck.beatFxType,
        beatFxAmount: deck.beatFxAmount,
        beatFxOn: deck.beatFxOn,
        beatFxBeatDiv: deck.beatFxBeatDiv,
        loopEnabled: deck.loopEnabled,
        loopStart: deck.loopStart,
        loopEnd: deck.loopEnd,
        loopBeats: deck.loopBeats,
        hotCues: deck.hotCues,
        // currentTime is sourced live from the external time store rather
        // than React state (state's `deck.currentTime` was removed from the
        // per-tick update path and is stale).
        currentTime: liveTime,
        duration: deck.duration,
        headphoneCue: deck.headphoneCue,
        padMode: deck.padMode,
        crossfaderAssign: deck.crossfaderAssign,
        beatGrid: deck.beatGrid,
    };
}

function savePersistedState(state: MixerState) {
    try {
        const persisted: PersistedMixerState = {
            deckA: serializeDeck(state.deckA, getDeckTime("A")),
            deckB: serializeDeck(state.deckB, getDeckTime("B")),
            deckC: serializeDeck(state.deckC, getDeckTime("C")),
            deckD: serializeDeck(state.deckD, getDeckTime("D")),
            deckMode: state.deckMode,
            crossfader: state.crossfader,
            crossfaderCurve: state.crossfaderCurve,
            masterVolume: state.masterVolume,
            headphoneVolume: state.headphoneVolume,
            headphoneMix: state.headphoneMix,
            eqMode: state.eqMode,
            tempoRange: state.tempoRange,
            jogSensitivity: state.jogSensitivity,
            waveformMode: state.waveformMode,
        };
        localStorage.setItem(MIXER_STORAGE_KEY, JSON.stringify(persisted));
    } catch { /* ignore */ }
}

type DeckStateKey = "deckA" | "deckB" | "deckC" | "deckD";
type DeckTrackKey = "deckATrack" | "deckBTrack" | "deckCTrack" | "deckDTrack";
const DECK_STATE_KEY: Record<DeckSide, DeckStateKey> = { A: "deckA", B: "deckB", C: "deckC", D: "deckD" };
const DECK_TRACK_KEY: Record<DeckSide, DeckTrackKey> = { A: "deckATrack", B: "deckBTrack", C: "deckCTrack", D: "deckDTrack" };
const ALL_SIDES: DeckSide[] = ["A", "B", "C", "D"];

export function MixerProvider({ children }: { children: ReactNode }) {
    useRenderCount("MixerProvider");
    const engineRef = useRef<MixerEngine | null>(null);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
    const [state, setState] = useState<MixerState>(() => {
        const newStateFields = {
            waveformMode: "rgb" as WaveformMode,
            samplerSlots: Array.from({ length: 8 }, (_, i) => ({
                id: i, name: `Slot ${i + 1}`, buffer: null, isPlaying: false, volume: 0.8, isLooping: false,
            })),
            automixConfig: { enabled: false, mode: "fade" as AutomixMode, fadeDuration: 8, minPlayTime: 60 },
            automixEnabled: false,
            mixHistory: [] as MixAction[],
            transitionSuggestions: [] as TransitionSuggestion[],
            midiClockEnabled: false,
            midiClockBpm: 120,
            isRestoring: false,
            restorationProgress: 0,
            restorationLabel: "",
        };
        const persisted = loadPersistedState() as PersistedMixerState | null;
        if (persisted) {
            // Restore deck state — keep isPlaying false (user must press play), but restore position
            const restoreDeck = (pd: Partial<PersistedDeckState> | undefined): DeckState => ({
                ...DEFAULT_DECK_STATE,
                ...pd,
                isPlaying: false,
                isLoaded: false,
                currentTime: pd?.currentTime ?? 0,
                duration: pd?.duration ?? 0,
            });
            return {
                deckA: restoreDeck(persisted.deckA),
                deckB: restoreDeck(persisted.deckB),
                deckC: restoreDeck(persisted.deckC),
                deckD: restoreDeck(persisted.deckD),
                deckATrack: null,
                deckBTrack: null,
                deckCTrack: null,
                deckDTrack: null,
                deckMode: persisted.deckMode ?? "2deck" as DeckMode,
                crossfader: persisted.crossfader ?? 0.5,
                crossfaderCurve: persisted.crossfaderCurve ?? "smooth" as CrossfaderCurve,
                masterVolume: persisted.masterVolume ?? 0.8,
                headphoneVolume: persisted.headphoneVolume ?? 0.8,
                headphoneMix: persisted.headphoneMix ?? 0.5,
                isActive: false,
                isRecording: false,
                recordingDuration: 0,
                eqMode: persisted.eqMode ?? "eq" as EQMode,
                tempoRange: persisted.tempoRange ?? 10,
                jogSensitivity: persisted.jogSensitivity ?? 5,
                sessionHistory: [],
                ...newStateFields,
                waveformMode: persisted.waveformMode ?? "rgb" as WaveformMode,
                // NOTE: don't preemptively set isRestoring=true here. The
                // restoration effect (which only runs after initMixer) is the
                // single source of truth — otherwise the SessionRestoreIndicator
                // shows "Initializing..." forever on pages that never mount the
                // mixer (e.g. /live).
                isRestoring: false,
                restorationProgress: 0,
                restorationLabel: "",
            };
        }
        return {
            deckA: { ...DEFAULT_DECK_STATE },
            deckB: { ...DEFAULT_DECK_STATE },
            deckC: { ...DEFAULT_DECK_STATE },
            deckD: { ...DEFAULT_DECK_STATE },
            deckATrack: null,
            deckBTrack: null,
            deckCTrack: null,
            deckDTrack: null,
            deckMode: "2deck" as DeckMode,
            crossfader: 0.5,
            crossfaderCurve: "smooth" as CrossfaderCurve,
            masterVolume: 0.8,
            headphoneVolume: 0.8,
            headphoneMix: 0.5,
            isActive: false,
            isRecording: false,
            recordingDuration: 0,
            eqMode: "eq" as EQMode,
            tempoRange: 10,
            jogSensitivity: 5,
            sessionHistory: [],
            ...newStateFields,
            isRestoring: false,
            restorationProgress: 0,
            restorationLabel: "",
        };
    });

    // Helper to update a single deck
    const updateDeck = useCallback((deck: DeckSide, update: Partial<DeckState>) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => ({
            ...prev,
            [key]: { ...(prev[key] as DeckState), ...update },
        }));
    }, []);

    // ─── rAF-coalesced state patches ─────────────────────────────────────
    // High-frequency continuous controls (knobs, faders, crossfader) used to
    // call `setState` once per pointermove — on a high-DPI mouse that's
    // ~120 Hz of full-context-tree re-renders, which is exactly why
    // mid-range Intel laptops felt laggy when dragging the crossfader.
    //
    // The fix: the audio engine is still called synchronously on every event
    // (audio stays buttery), but React state patches are merged into a
    // single setState per animation frame. This caps React's render cost at
    // the display refresh rate regardless of input event frequency.
    //
    // `engineRef` calls remain outside this — audio must not be deferred.
    const pendingGlobalRef = useRef<Partial<MixerState> | null>(null);
    const pendingDeckRef = useRef<Partial<Record<DeckSide, Partial<DeckState>>>>({});
    const flushRafRef = useRef<number | null>(null);

    const flushPending = useCallback(() => {
        flushRafRef.current = null;
        const globalPatch = pendingGlobalRef.current;
        const deckPatch = pendingDeckRef.current;
        pendingGlobalRef.current = null;
        pendingDeckRef.current = {};
        const hasDeck = (Object.keys(deckPatch) as DeckSide[]).length > 0;
        if (!globalPatch && !hasDeck) return;
        setState(prev => {
            let next = prev;
            if (globalPatch) next = { ...next, ...globalPatch };
            if (hasDeck) {
                const merged: Partial<MixerState> = {};
                for (const side of Object.keys(deckPatch) as DeckSide[]) {
                    const k = DECK_STATE_KEY[side];
                    merged[k] = { ...(next[k] as DeckState), ...deckPatch[side] };
                }
                next = { ...next, ...merged };
            }
            return next;
        });
    }, []);

    const scheduleFlush = useCallback(() => {
        if (flushRafRef.current != null) return;
        if (typeof requestAnimationFrame === "undefined") {
            // SSR / non-DOM env — flush synchronously.
            flushPending();
            return;
        }
        flushRafRef.current = requestAnimationFrame(flushPending);
    }, [flushPending]);

    /** Coalesce a global state patch into the next animation frame. */
    const patchGlobal = useCallback((patch: Partial<MixerState>) => {
        pendingGlobalRef.current = { ...pendingGlobalRef.current, ...patch };
        scheduleFlush();
    }, [scheduleFlush]);

    /** Coalesce a per-deck patch into the next animation frame. */
    const patchDeck = useCallback((deck: DeckSide, patch: Partial<DeckState>) => {
        pendingDeckRef.current[deck] = { ...pendingDeckRef.current[deck], ...patch };
        scheduleFlush();
    }, [scheduleFlush]);

    useEffect(() => () => {
        if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
    }, []);

    // Live playback time is broadcast through an external `useSyncExternalStore`
    // so only leaf components that actually display a clock re-render on
    // every tick. The 4 Hz `onTimeUpdate` emitter used to go through
    // `setState` which forced the whole provider + MixerView tree to
    // reconcile — measurements showed ~400 renders across 6 minutes of idle
    // playback. Now: zero React re-renders for time ticks.
    const batchTimeUpdate = useCallback((deck: DeckSide, time: number) => {
        setDeckTime(deck, time);
    }, []);

    const getDeckEngine = useCallback((deck: DeckSide) => {
        if (!engineRef.current) return null;
        return engineRef.current.getDeck(deck);
    }, []);

    // ─── Lifecycle ──────────────────────────────────────────────────────

    const initMixer = useCallback(() => {
        if (engineRef.current) return;
        const engine = new MixerEngine();

        // Wire up time tracking for all 4 decks
        for (const side of ALL_SIDES) {
            const eng = engine.getDeck(side);
            eng.onTimeUpdate = (t) => batchTimeUpdate(side, t);
            eng.onLoaded = (d) => updateDeck(side, { duration: d, isLoaded: true });
            eng.onEnded = () => updateDeck(side, { isPlaying: false });
        }

        // Load persisted MIDI settings and apply to engine
        try {
            const raw = localStorage.getItem("mmo-midi-settings");
            if (raw) {
                const midiSettings = JSON.parse(raw);
                if (midiSettings.crossfaderCurve) engine.setCrossfaderCurve(midiSettings.crossfaderCurve);
                if (midiSettings.tempoRange != null) setState(prev => ({ ...prev, tempoRange: midiSettings.tempoRange }));
                if (midiSettings.jogSensitivity != null) setState(prev => ({ ...prev, jogSensitivity: midiSettings.jogSensitivity }));
            }
        } catch { /* ignore */ }

        engineRef.current = engine;
        setState(prev => ({ ...prev, isActive: true }));
    }, [updateDeck]);

    const destroyMixer = useCallback(() => {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        engineRef.current?.destroy();
        engineRef.current = null;
        resetAllDeckTimes();
        setState(prev => ({
            deckA: { ...DEFAULT_DECK_STATE },
            deckB: { ...DEFAULT_DECK_STATE },
            deckC: { ...DEFAULT_DECK_STATE },
            deckD: { ...DEFAULT_DECK_STATE },
            deckATrack: null,
            deckBTrack: null,
            deckCTrack: null,
            deckDTrack: null,
            deckMode: prev.deckMode,
            crossfader: 0.5,
            crossfaderCurve: "smooth",
            masterVolume: 0.8,
            headphoneVolume: 0.8,
            headphoneMix: 0.5,
            isActive: false,
            isRecording: false,
            recordingDuration: 0,
            eqMode: "eq",
            tempoRange: 10,
            jogSensitivity: 5,
            sessionHistory: [],
            waveformMode: prev.waveformMode,
            samplerSlots: prev.samplerSlots,
            automixConfig: prev.automixConfig,
            automixEnabled: false,
            mixHistory: [],
            transitionSuggestions: [],
            midiClockEnabled: false,
            midiClockBpm: 120,
            isRestoring: false,
            restorationProgress: 0,
            restorationLabel: "",
        }));
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            engineRef.current?.destroy();
        };
    }, []);

    // Persist state to localStorage (debounced, skip time-only changes)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const stateRef = useRef(state);
    const lastSavedStateRef = useRef<string>("");
    useEffect(() => { stateRef.current = state; });
    useEffect(() => {
        // Quick fingerprint excluding volatile fields (currentTime, isPlaying, recordingDuration)
        const fingerprint = `${state.deckA.trackId}|${state.deckB.trackId}|${state.deckC.trackId}|${state.deckD.trackId}|` +
            `${state.crossfader}|${state.masterVolume}|${state.deckMode}|${state.eqMode}|` +
            `${state.deckA.volume}|${state.deckB.volume}|${state.deckA.eqLow}|${state.deckA.eqMid}|${state.deckA.eqHi}|` +
            `${state.deckB.eqLow}|${state.deckB.eqMid}|${state.deckB.eqHi}|` +
            `${state.deckA.filter}|${state.deckB.filter}|${state.deckA.bpm}|${state.deckB.bpm}|` +
            `${state.waveformMode}|${state.headphoneVolume}|${state.headphoneMix}|${state.tempoRange}`;
        if (fingerprint === lastSavedStateRef.current) return; // skip time-only changes
        lastSavedStateRef.current = fingerprint;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => savePersistedState(state), 500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [state]);

    // Final accurate save on tab close — reads currentTime from engine for precision
    useEffect(() => {
        const handleBeforeUnload = () => {
            const engine = engineRef.current;
            if (engine) {
                // Push the engine's authoritative time into the store first
                // so `savePersistedState` (which now reads from the store)
                // captures the most accurate final position.
                for (const side of ALL_SIDES) {
                    const t = engine.getDeck(side).getCurrentTime();
                    if (t > 0) setDeckTime(side, t);
                }
            }
            savePersistedState(stateRef.current);
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, []);

    // Auto-suspend AudioContext when all decks are paused (save CPU)
    const suspendTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine || !state.isActive) return;
        const anyPlaying = state.deckA.isPlaying || state.deckB.isPlaying ||
            state.deckC.isPlaying || state.deckD.isPlaying || state.isRecording;
        if (anyPlaying) {
            // Cancel pending suspend and ensure running
            if (suspendTimerRef.current) { clearTimeout(suspendTimerRef.current); suspendTimerRef.current = undefined; }
            engine.ensureRunning();
        } else {
            // Suspend after 30s of silence to save CPU/battery
            if (!suspendTimerRef.current) {
                suspendTimerRef.current = setTimeout(() => {
                    engine.suspend();
                    suspendTimerRef.current = undefined;
                }, 30_000);
            }
        }
        return () => { if (suspendTimerRef.current) { clearTimeout(suspendTimerRef.current); suspendTimerRef.current = undefined; } };
    }, [state.deckA.isPlaying, state.deckB.isPlaying, state.deckC.isPlaying, state.deckD.isPlaying, state.isRecording, state.isActive]);

    // Auto-reload persisted tracks and apply ALL state to engine after init
    const hasRestoredRef = useRef(false);
    useEffect(() => {
        if (!state.isActive || hasRestoredRef.current) return;
        hasRestoredRef.current = true;
        const engine = engineRef.current;
        if (!engine) return;

        const allDecks: { side: DeckSide; deck: DeckState }[] = ALL_SIDES.map(side => ({
            side,
            deck: state[DECK_STATE_KEY[side]] as DeckState,
        }));
        const decksWithTracks = allDecks.filter(d => d.deck.trackId);
        if (decksWithTracks.length === 0) {
            setState(prev => ({ ...prev, isRestoring: false, restorationProgress: 100, restorationLabel: "" }));
            return;
        }

        // Progress helper
        const setProgress = (progress: number, label: string) => {
            setState(prev => ({ ...prev, restorationProgress: progress, restorationLabel: label, isRestoring: progress < 100 }));
        };

        setProgress(5, "Restoring mixer settings...");

        // ─── Restore global mixer settings ──────────────────────────────
        engine.setCrossfader(state.crossfader);
        engine.setCrossfaderCurve(state.crossfaderCurve);
        engine.setMasterVolume(state.masterVolume);
        engine.setHeadphoneVolume(state.headphoneVolume);
        engine.setHeadphoneMix(state.headphoneMix);

        // Crossfader assignments per deck
        for (const side of ALL_SIDES) {
            engine.setCrossfaderAssign(side, (state[DECK_STATE_KEY[side]] as DeckState).crossfaderAssign);
        }

        setProgress(15, "Restoring EQ & effects...");

        // Pre-fetch all deck tracks into cache for resilience
        const trackIdsToPreload = decksWithTracks
            .map(d => d.deck.trackId)
            .filter((id): id is number => !!id);
        if (trackIdsToPreload.length > 0) {
            audioPreloadCache.preloadMany(trackIdsToPreload);
        }

        let decksLoaded = 0;
        const progressPerDeck = 75 / decksWithTracks.length; // spread remaining 75% across decks

        // ─── Restore each deck ──────────────────────────────────────────
        const restoreDeckEngine = (side: DeckSide, deck: DeckState, baseProgress: number) => {
            const eng = engine.getDeck(side);

            eng.setEQMode(state.eqMode);
            eng.setVolume(deck.volume);
            eng.setEQ("low", deck.eqLow);
            eng.setEQ("mid", deck.eqMid);
            eng.setEQ("hi", deck.eqHi);
            if (deck.eqLowKill) eng.setEQKill("low", true);
            if (deck.eqMidKill) eng.setEQKill("mid", true);
            if (deck.eqHiKill) eng.setEQKill("hi", true);
            if (deck.filter !== 0) eng.setFilter(deck.filter, deck.filterType);
            if (deck.colorFx !== 0) eng.setColorFx(deck.colorFx, deck.colorFxType);
            if (deck.beatFxOn) eng.setBeatFx(deck.beatFxType, deck.beatFxAmount, deck.bpm, deck.beatFxBeatDiv);
            if (deck.keyShift !== 0) eng.setKeyShift(deck.keyShift);
            if (deck.keyLock) eng.setKeyLock(true);
            if (deck.headphoneCue) eng.setHeadphoneCue(true);

            if (deck.trackId) {
                setProgress(baseProgress, `Loading Deck ${side} track...`);
                const savedTime = deck.currentTime;
                eng.loadTrack(deck.trackId);
                if (deck.bpm > 0 && deck.originalBpm > 0 && deck.bpm !== deck.originalBpm) {
                    eng.setTempo(deck.bpm / deck.originalBpm);
                }
                // One-shot wrapper: restore-time / restore-loop must run only on
                // THIS track's first `loadedmetadata`. We unwrap immediately so
                // that subsequent loads (a new track on the same deck, or a
                // blob-URL upgrade firing `loadedmetadata` again) don't replay
                // the captured persisted loop state — which would silently
                // re-enable the previous loop on the new track and produce a
                // "ghost loop" the user can't see in the UI.
                const baseOnLoaded = eng.onLoaded;
                eng.onLoaded = (duration) => {
                    eng.onLoaded = baseOnLoaded;
                    baseOnLoaded?.(duration);
                    if (savedTime > 0 && savedTime < duration) {
                        eng.seek(savedTime);
                        updateDeck(side, { duration, isLoaded: true });
                        setDeckTime(side, savedTime);
                    }
                    if (deck.loopEnabled && deck.loopStart >= 0 && deck.loopEnd > deck.loopStart) {
                        eng.enableLoop(deck.loopStart, deck.loopEnd);
                    }
                    decksLoaded++;
                    if (decksLoaded >= decksWithTracks.length) {
                        setProgress(100, "Session restored");
                        setTimeout(() => {
                            setState(prev => ({ ...prev, isRestoring: false, restorationLabel: "" }));
                        }, 1500);
                    } else {
                        setProgress(baseProgress + progressPerDeck * 0.8, `Deck ${side} ready, loading next...`);
                    }
                };
                getTrackById(deck.trackId).then(t => {
                    if (t) setState(prev => ({ ...prev, [DECK_TRACK_KEY[side]]: t }));
                });
            }
        };

        decksWithTracks.forEach((d, i) => {
            restoreDeckEngine(d.side, d.deck, 20 + i * progressPerDeck);
        });
    }, [state.isActive, updateDeck]);

    // ─── Deck Actions ───────────────────────────────────────────────────

    const loadTrackImmediate = useCallback((deck: DeckSide, track: Track) => {
        console.log("[Mixer] loadTrack called:", deck, track.id, track.title);
        if (!engineRef.current) {
            console.log("[Mixer] No engine, calling initMixer...");
            initMixer();
        }
        const eng = getDeckEngine(deck);
        if (!eng) {
            console.warn("[Mixer] getDeckEngine returned null for deck", deck);
            return;
        }
        console.log("[Mixer] Loading track into engine, trackId:", track.id);

        eng.loadTrack(track.id);
        // Add to session history
        engineRef.current?.addToHistory({ title: track.title || track.filename, artist: track.artist || "Unknown" }, deck);
        // Auto-gain: use track's gain/loudness metadata if available, else measure peak.
        // One-shot wrapper: must unwrap before invoking inner work so that any
        // subsequent `loadedmetadata` (e.g., the blob-URL upgrade fired by
        // `audioPreloadCache.preload(...).then(...)` swapping audio.src) does
        // NOT re-run auto-gain measurement and, more importantly, does not
        // accumulate a chain of stale wrappers that could replay state from
        // a previous track load.
        const baseOnLoaded = eng.onLoaded;
        eng.onLoaded = (duration) => {
            eng.onLoaded = baseOnLoaded;
            baseOnLoaded?.(duration);
            // Simple auto-gain: measure peak in first 10 seconds via analyser
            // Target -14 LUFS (roughly 0.2 linear RMS for typical music)
            const analyserNode = eng.analyser;
            if (analyserNode) {
                const data = new Uint8Array(analyserNode.frequencyBinCount);
                let maxPeak = 0;
                let sampleCount = 0;
                const checkPeak = () => {
                    analyserNode.getByteFrequencyData(data);
                    let sum = 0;
                    for (let i = 0; i < data.length; i++) sum += data[i];
                    const avg = sum / data.length / 255;
                    if (avg > maxPeak) maxPeak = avg;
                    sampleCount++;
                    if (sampleCount < 30 && maxPeak < 0.9) {
                        requestAnimationFrame(checkPeak);
                    } else {
                        // Set auto-gain: louder tracks get less gain, quieter tracks get more
                        const targetLevel = 0.4;
                        const correction = maxPeak > 0.01 ? targetLevel / maxPeak : 1;
                        const clampedGain = Math.max(0.3, Math.min(3, correction));
                        eng.setAutoGain(clampedGain);
                        updateDeck(deck, { autoGain: clampedGain });
                    }
                };
                // Delay first check to let audio buffer fill
                setTimeout(checkPeak, 200);
            }
        };
        setState(prev => ({
            ...prev,
            [DECK_TRACK_KEY[deck]]: track,
            sessionHistory: engineRef.current?.sessionHistory || prev.sessionHistory,
        }));
        updateDeck(deck, {
            trackId: track.id,
            trackTitle: track.title || track.filename,
            trackArtist: track.artist || "Unknown",
            trackArtworkUrl: track.artworkUrl || null,
            isPlaying: false,
            isLoaded: false,
            currentTime: 0,
            duration: 0,
            bpm: track.bpm || 120,
            originalBpm: track.bpm || 120,
            // Prefer the Camelot code; fall back to deriving it from the
            // musical key (e.g. "Am" → "8A") so tracks imported with only
            // a musical-key tag still display a key in the mixer. As a
            // last resort, keep the raw musical-key string so the user
            // sees *something* instead of an empty placeholder.
            key: track.keyCamelot
                || (track.keyMusical && (musicalKeyToCamelot(track.keyMusical) || track.keyMusical))
                || "",
            originalKey: track.keyCamelot
                || (track.keyMusical && (musicalKeyToCamelot(track.keyMusical) || track.keyMusical))
                || "",
            keyShift: 0,
            loopEnabled: false,
            loopStart: 0,
            loopEnd: 0,
            eqLow: 0,
            eqMid: 0,
            eqHi: 0,
            eqLowKill: false,
            eqMidKill: false,
            eqHiKill: false,
            filter: 0,
            hotCues: [null, null, null, null, null, null, null, null],
        });

        // Auto-queue stems analysis if track hasn't been analyzed
        if (!track.stemsStatus) {
            import("@/actions/stems").then(({ updateStemsStatus }) => {
                updateStemsStatus(track.id, "pending").catch(() => { });
            });
            import("sonner").then(({ toast }) => {
                toast("Stems ready", {
                    description: `${track.title || track.filename} — toggle stems in the mixer panel`,
                    icon: "🎛️",
                    duration: 3000,
                });
            });
        }
    }, [initMixer, getDeckEngine, updateDeck]);

    const loadTrack = useCallback((deck: DeckSide, track: Track) => {
        // Check if target deck is playing and confirmation is enabled
        const deckKey = DECK_STATE_KEY[deck];
        const deckState = stateRef.current[deckKey] as DeckState;
        if (deckState.isPlaying && getPersonalization().confirmLoadOnPlayingDeck) {
            // Show confirmation dialog, then load if confirmed
            requestConfirmLoad(deck, track).then(confirmed => {
                if (confirmed) loadTrackImmediate(deck, track);
            });
            return;
        }
        loadTrackImmediate(deck, track);
    }, [loadTrackImmediate]);

    const play = useCallback((deck: DeckSide) => {
        getDeckEngine(deck)?.play();
        updateDeck(deck, { isPlaying: true });
        // Mark session history as played
        engineRef.current?.markPlayed(deck);
    }, [getDeckEngine, updateDeck]);

    const pause = useCallback((deck: DeckSide) => {
        getDeckEngine(deck)?.pause();
        updateDeck(deck, { isPlaying: false });
    }, [getDeckEngine, updateDeck]);

    const togglePlay = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const isPlaying = prev[key].isPlaying;
            if (isPlaying) {
                getDeckEngine(deck)?.pause();
            } else {
                getDeckEngine(deck)?.play();
            }
            return { ...prev, [key]: { ...prev[key], isPlaying: !isPlaying } };
        });
    }, [getDeckEngine]);

    const seek = useCallback((deck: DeckSide, time: number) => {
        getDeckEngine(deck)?.seek(time);
        // Mirror to the time store so every subscriber sees the jump
        // immediately — the next engine tick would only arrive 250 ms later.
        setDeckTime(deck, time);
    }, [getDeckEngine]);

    const beatJump = useCallback((deck: DeckSide, beats: number) => {
        const key = DECK_STATE_KEY[deck];
        const prev = stateRef.current[key] as DeckState;
        const beatDuration = 60 / prev.bpm;
        const base = getDeckTime(deck);
        let targetTime = base + beats * beatDuration;
        if (prev.quantize) {
            targetTime = getDeckEngine(deck)?.quantizeTime(targetTime, prev.bpm) ?? targetTime;
        }
        targetTime = Math.max(0, Math.min(targetTime, prev.duration));
        getDeckEngine(deck)?.seek(targetTime);
        setDeckTime(deck, targetTime);
    }, [getDeckEngine]);

    // Per-deck auto-release timers for continuous jog nudge: when MIDI ticks
    // stop arriving the bend decays back to base. Without this the playback
    // rate would stay offset forever after the last jog tick.
    const nudgeReleaseTimers = useRef<Map<DeckSide, ReturnType<typeof setTimeout>>>(new Map());

    const nudge = useCallback((deck: DeckSide, intensity: number) => {
        // `intensity` is a signed strength in roughly -1..+1.
        // Positive = speed up, negative = slow down. Maps to ±15% pitch bend
        // (matches DeckEngine's internal clamp).
        const eng = getDeckEngine(deck);
        if (!eng) return;
        const clamped = Math.max(-1, Math.min(1, intensity));
        eng.nudge(clamped * 0.15);

        // Auto-release if no further jog tick arrives within 200 ms (jog stopped).
        const timers = nudgeReleaseTimers.current;
        const prev = timers.get(deck);
        if (prev) clearTimeout(prev);
        timers.set(deck, setTimeout(() => {
            eng.releaseNudge();
            timers.delete(deck);
        }, 200));
    }, [getDeckEngine]);

    const nudgeRelease = useCallback((deck: DeckSide) => {
        const timers = nudgeReleaseTimers.current;
        const prev = timers.get(deck);
        if (prev) { clearTimeout(prev); timers.delete(deck); }
        getDeckEngine(deck)?.releaseNudge();
    }, [getDeckEngine]);

    const setVolume = useCallback((deck: DeckSide, vol: number) => {
        getDeckEngine(deck)?.setVolume(vol);
        patchDeck(deck, { volume: vol });
    }, [getDeckEngine, patchDeck]);

    const setEQ = useCallback((deck: DeckSide, band: "low" | "mid" | "hi", gain: number) => {
        getDeckEngine(deck)?.setEQ(band, gain);
        const update = band === "low" ? { eqLow: gain } : band === "mid" ? { eqMid: gain } : { eqHi: gain };
        patchDeck(deck, update);
    }, [getDeckEngine, patchDeck]);

    const toggleEQKill = useCallback((deck: DeckSide, band: "low" | "mid" | "hi") => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const killKey = band === "low" ? "eqLowKill" : band === "mid" ? "eqMidKill" : "eqHiKill";
            const newKill = !deckState[killKey];
            getDeckEngine(deck)?.setEQKill(band, newKill);
            const gainKey = band === "low" ? "eqLow" : band === "mid" ? "eqMid" : "eqHi";
            return {
                ...prev,
                [key]: {
                    ...deckState,
                    [killKey]: newKill,
                    [gainKey]: newKill ? -26 : 0,
                },
            };
        });
    }, [getDeckEngine]);

    const setBpm = useCallback((deck: DeckSide, bpm: number) => {
        // Read originalBpm from the ref (cheap & current) and the engine call
        // happens immediately so audio stays smooth even at 120 Hz pointer
        // events; React state coalesces to one update per frame.
        const deckState = stateRef.current[DECK_STATE_KEY[deck]] as DeckState;
        const originalBpm = pendingDeckRef.current[deck]?.originalBpm ?? deckState.originalBpm;
        const ratio = bpm / originalBpm;
        getDeckEngine(deck)?.setTempo(ratio);
        patchDeck(deck, { bpm });
    }, [getDeckEngine, patchDeck]);

    const syncBpm = useCallback((deck: DeckSide) => {
        // Sync pairs: A↔B, C↔D
        const SYNC_PAIR: Record<DeckSide, DeckSide> = { A: "B", B: "A", C: "D", D: "C" };
        const otherKey = DECK_STATE_KEY[SYNC_PAIR[deck]];
        setState(prev => {
            const targetBpm = (prev[otherKey] as DeckState).bpm;
            const deckKey = DECK_STATE_KEY[deck];
            const deckState = prev[deckKey] as DeckState;
            if (!targetBpm || !deckState.originalBpm) return prev;
            const ratio = targetBpm / deckState.originalBpm;
            getDeckEngine(deck)?.setTempo(ratio);
            return { ...prev, [deckKey]: { ...deckState, bpm: targetBpm } };
        });
    }, [getDeckEngine]);

    const setKeyShift = useCallback((deck: DeckSide, semitones: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setKeyShift(semitones);
            return {
                ...prev,
                [key]: {
                    ...deckState,
                    keyShift: semitones,
                    key: shiftKeyName(deckState.originalKey, semitones),
                },
            };
        });
    }, [getDeckEngine]);

    const setFilterAction = useCallback((deck: DeckSide, value: number) => {
        const filterType = pendingDeckRef.current[deck]?.filterType
            ?? (stateRef.current[DECK_STATE_KEY[deck]] as DeckState).filterType;
        getDeckEngine(deck)?.setFilter(value, filterType);
        patchDeck(deck, { filter: value });
    }, [getDeckEngine, patchDeck]);

    const setFilterType = useCallback((deck: DeckSide, type: FilterType) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setFilter(deckState.filter, type);
            return { ...prev, [key]: { ...deckState, filterType: type } };
        });
    }, [getDeckEngine]);

    const setColorFxAction = useCallback((deck: DeckSide, value: number) => {
        const colorFxType = pendingDeckRef.current[deck]?.colorFxType
            ?? (stateRef.current[DECK_STATE_KEY[deck]] as DeckState).colorFxType;
        getDeckEngine(deck)?.setColorFx(value, colorFxType);
        patchDeck(deck, { colorFx: value });
    }, [getDeckEngine, patchDeck]);

    const setColorFxType = useCallback((deck: DeckSide, type: ColorFxType) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setColorFx(deckState.colorFx, type);
            return { ...prev, [key]: { ...deckState, colorFxType: type } };
        });
    }, [getDeckEngine]);

    const setLoop = useCallback((deck: DeckSide, beats: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const beatDuration = 60 / deckState.bpm;
            const loopLength = beatDuration * beats;
            let loopStart = getDeckTime(deck);
            // Quantize loop start to beat grid if quantize is on
            if (deckState.quantize && deckState.bpm > 0) {
                loopStart = getDeckEngine(deck)?.quantizeTime(loopStart, deckState.bpm) ?? loopStart;
            }
            const loopEnd = loopStart + loopLength;
            getDeckEngine(deck)?.enableLoop(loopStart, loopEnd);
            return {
                ...prev,
                [key]: { ...deckState, loopEnabled: true, loopStart, loopEnd, loopBeats: beats },
            };
        });
    }, [getDeckEngine]);

    const toggleLoop = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            if (deckState.loopEnabled) {
                getDeckEngine(deck)?.disableLoop();
                return { ...prev, [key]: { ...deckState, loopEnabled: false } };
            } else {
                const beatDuration = 60 / deckState.bpm;
                const loopLength = beatDuration * deckState.loopBeats;
                let loopStart = getDeckTime(deck);
                if (deckState.quantize && deckState.bpm > 0) {
                    loopStart = getDeckEngine(deck)?.quantizeTime(loopStart, deckState.bpm) ?? loopStart;
                }
                const loopEnd = loopStart + loopLength;
                getDeckEngine(deck)?.enableLoop(loopStart, loopEnd);
                return { ...prev, [key]: { ...deckState, loopEnabled: true, loopStart, loopEnd } };
            }
        });
    }, [getDeckEngine]);

    const moveLoop = useCallback((deck: DeckSide, direction: "left" | "right") => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const beatDuration = 60 / deckState.bpm;
            const quarterBar = beatDuration; // quarter of a 4-beat bar
            const offset = direction === "right" ? quarterBar : -quarterBar;
            getDeckEngine(deck)?.moveLoop(offset);
            return {
                ...prev,
                [key]: {
                    ...deckState,
                    loopStart: deckState.loopStart + offset,
                    loopEnd: deckState.loopEnd + offset,
                },
            };
        });
    }, [getDeckEngine]);

    const setHotCue = useCallback((deck: DeckSide, index: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const hotCues = [...deckState.hotCues];
            let cueTime = getDeckTime(deck);
            // Quantize hot cue position to beat grid if quantize is on
            if (deckState.quantize && deckState.bpm > 0) {
                cueTime = getDeckEngine(deck)?.quantizeTime(cueTime, deckState.bpm) ?? cueTime;
            }
            hotCues[index] = cueTime;
            return { ...prev, [key]: { ...deckState, hotCues } };
        });
    }, [getDeckEngine]);

    const jumpHotCue = useCallback((deck: DeckSide, index: number) => {
        const key = DECK_STATE_KEY[deck];
        const deckState = stateRef.current[key] as DeckState;
        const time = deckState.hotCues[index];
        if (time != null) {
            getDeckEngine(deck)?.seek(time);
            setDeckTime(deck, time);
        }
    }, [getDeckEngine]);

    const clearHotCue = useCallback((deck: DeckSide, index: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const hotCues = [...deckState.hotCues];
            hotCues[index] = null;
            return { ...prev, [key]: { ...deckState, hotCues } };
        });
    }, []);

    const ejectTrack = useCallback((deck: DeckSide) => {
        const eng = getDeckEngine(deck);
        if (eng) {
            eng.pause();
            eng.audio.src = "";
        }
        setState(prev => ({
            ...prev,
            [DECK_TRACK_KEY[deck]]: null,
        }));
        updateDeck(deck, { ...DEFAULT_DECK_STATE });
    }, [getDeckEngine, updateDeck]);

    // ─── New Deck Actions ───────────────────────────────────────────────

    const setKeyLock = useCallback((deck: DeckSide, enabled: boolean) => {
        getDeckEngine(deck)?.setKeyLock(enabled);
        updateDeck(deck, { keyLock: enabled });
    }, [getDeckEngine, updateDeck]);

    const setBeatFxAction = useCallback((deck: DeckSide, type: BeatFxType) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(type, deckState.beatFxAmount, deckState.bpm, deckState.beatFxBeatDiv);
            }
            return { ...prev, [key]: { ...deckState, beatFxType: type } };
        });
    }, [getDeckEngine]);

    const setBeatFxAmount = useCallback((deck: DeckSide, amount: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, amount, deckState.bpm, deckState.beatFxBeatDiv);
            }
            return { ...prev, [key]: { ...deckState, beatFxAmount: amount } };
        });
    }, [getDeckEngine]);

    const toggleBeatFx = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const newOn = !deckState.beatFxOn;
            if (newOn) {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, deckState.beatFxAmount, deckState.bpm, deckState.beatFxBeatDiv);
            } else {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, 0, deckState.bpm, deckState.beatFxBeatDiv);
            }
            return { ...prev, [key]: { ...deckState, beatFxOn: newOn } };
        });
    }, [getDeckEngine]);

    const setBeatFxBeatDiv = useCallback((deck: DeckSide, div: number) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, deckState.beatFxAmount, deckState.bpm, div);
            }
            return { ...prev, [key]: { ...deckState, beatFxBeatDiv: div } };
        });
    }, [getDeckEngine]);

    const toggleSlipMode = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const newSlip = !deckState.slipMode;
            const eng = getDeckEngine(deck);
            if (newSlip) {
                eng?.startSlip();
            } else {
                const resumePos = eng?.stopSlip();
                if (resumePos != null) {
                    eng?.seek(resumePos);
                }
            }
            return { ...prev, [key]: { ...deckState, slipMode: newSlip } };
        });
    }, [getDeckEngine]);

    const toggleQuantize = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const d = prev[key] as DeckState;
            return { ...prev, [key]: { ...d, quantize: !d.quantize } };
        });
    }, []);

    const toggleHeadphoneCue = useCallback((deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const deckState = prev[key];
            const newCue = !deckState.headphoneCue;
            getDeckEngine(deck)?.setHeadphoneCue(newCue);
            return { ...prev, [key]: { ...deckState, headphoneCue: newCue } };
        });
    }, [getDeckEngine]);

    const setPadMode = useCallback((deck: DeckSide, mode: PadMode) => {
        updateDeck(deck, { padMode: mode });
    }, [updateDeck]);

    // ─── Master Controls ────────────────────────────────────────────────

    const setCrossfader = useCallback((value: number) => {
        engineRef.current?.setCrossfader(value);
        patchGlobal({ crossfader: value });
    }, [patchGlobal]);

    const setCrossfaderCurve = useCallback((curve: CrossfaderCurve) => {
        engineRef.current?.setCrossfaderCurve(curve);
        setState(prev => ({ ...prev, crossfaderCurve: curve }));
    }, []);

    const setMasterVolume = useCallback((value: number) => {
        engineRef.current?.setMasterVolume(value);
        patchGlobal({ masterVolume: value });
    }, [patchGlobal]);

    const setHeadphoneVolume = useCallback((value: number) => {
        engineRef.current?.setHeadphoneVolume(value);
        patchGlobal({ headphoneVolume: value });
    }, [patchGlobal]);

    const setHeadphoneMix = useCallback((mix: number) => {
        engineRef.current?.setHeadphoneMix(mix);
        patchGlobal({ headphoneMix: mix });
    }, [patchGlobal]);

    const setEQModeAction = useCallback((mode: EQMode) => {
        engineRef.current?.deckA.setEQMode(mode);
        engineRef.current?.deckB.setEQMode(mode);
        setState(prev => ({ ...prev, eqMode: mode }));
    }, []);

    const setTempoRange = useCallback((range: number) => {
        setState(prev => ({ ...prev, tempoRange: range }));
    }, []);

    const setJogSensitivity = useCallback((sens: number) => {
        setState(prev => ({ ...prev, jogSensitivity: sens }));
    }, []);

    const toggleRecording = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;

        if (engine.isRecording) {
            engine.stopRecordingAsync().then(result => {
                if (result) {
                    void uploadRecording({
                        source: "mixer",
                        blob: result.blob,
                        durationMs: result.duration,
                    });
                }
            });
            if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
            setState(prev => ({ ...prev, isRecording: false, recordingDuration: 0 }));
        } else {
            const success = engine.startRecording();
            if (success) {
                const startTime = Date.now();
                recordingTimerRef.current = setInterval(() => {
                    setState(prev => ({ ...prev, recordingDuration: Date.now() - startTime }));
                }, 1000);
                setState(prev => ({ ...prev, isRecording: true, recordingDuration: 0 }));
            }
        }
    }, []);

    const getDeckAnalyser = useCallback((deck: DeckSide) => {
        return getDeckEngine(deck)?.analyser ?? null;
    }, [getDeckEngine]);

    const getDeckStems = useCallback((deck: DeckSide) => {
        return getDeckEngine(deck)?.stemProcessor ?? null;
    }, [getDeckEngine]);

    const getDeckCurrentTime = useCallback((deck: DeckSide) => {
        return getDeckEngine(deck)?.getCurrentTime() ?? 0;
    }, [getDeckEngine]);

    const getMasterAnalyser = useCallback(() => {
        return engineRef.current?.masterAnalyser ?? null;
    }, []);

    const getAudioInfo = useCallback(() => {
        return engineRef.current?.getAudioInfo() ?? null;
    }, []);

    // ─── New Actions ─────────────────────────────────────────────────

    const setDeckMode = useCallback((mode: DeckMode) => {
        setState(prev => ({ ...prev, deckMode: mode }));
        try { localStorage.setItem("mmo-mixer-deck-mode", mode); } catch { /* ignore */ }
    }, []);

    const setWaveformMode = useCallback((mode: WaveformMode) => {
        setState(prev => ({ ...prev, waveformMode: mode }));
        try { localStorage.setItem("mmo-mixer-wf-mode", mode); } catch { /* ignore */ }
    }, []);

    const setCrossfaderAssign = useCallback((deck: DeckSide, assign: CrossfaderAssign) => {
        engineRef.current?.setCrossfaderAssign(deck, assign);
        updateDeck(deck, { crossfaderAssign: assign });
    }, [updateDeck]);

    const setBeatGrid = useCallback((deck: DeckSide, grid: Partial<BeatGridState>) => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => ({
            ...prev,
            [key]: { ...prev[key], beatGrid: { ...prev[key].beatGrid, ...grid } },
        }));
    }, []);

    const nudgeBeatGrid = useCallback((deck: DeckSide, direction: "left" | "right") => {
        const key = DECK_STATE_KEY[deck];
        setState(prev => {
            const grid = prev[key].beatGrid;
            if (grid.isLocked) return prev;
            const nudgeAmount = 0.01; // 10ms nudge
            const newOffset = grid.offset + (direction === "right" ? nudgeAmount : -nudgeAmount);
            return {
                ...prev,
                [key]: { ...prev[key], beatGrid: { ...grid, offset: newOffset } },
            };
        });
    }, []);

    const triggerSampler = useCallback((slotIndex: number) => {
        engineRef.current?.sampler.trigger(slotIndex);
        setState(prev => ({
            ...prev,
            samplerSlots: prev.samplerSlots.map((s, i) =>
                i === slotIndex ? { ...s, isPlaying: true } : s
            ),
        }));
    }, []);

    const stopSampler = useCallback((slotIndex: number) => {
        engineRef.current?.sampler.stop(slotIndex);
        setState(prev => ({
            ...prev,
            samplerSlots: prev.samplerSlots.map((s, i) =>
                i === slotIndex ? { ...s, isPlaying: false } : s
            ),
        }));
    }, []);

    const loadSample = useCallback(async (slotIndex: number, url: string, name?: string) => {
        const success = await engineRef.current?.sampler.loadSample(slotIndex, url, name);
        if (success) {
            const slots = engineRef.current?.sampler.slots;
            if (slots) {
                setState(prev => ({
                    ...prev,
                    samplerSlots: slots.map(s => ({ ...s })),
                }));
            }
        }
    }, []);

    const loadSampleFromFile = useCallback(async (slotIndex: number, file: File): Promise<boolean> => {
        const engine = engineRef.current;
        if (!engine) return false;
        try {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await engine.ctx.decodeAudioData(arrayBuffer);
            engine.sampler.loadBuffer(slotIndex, audioBuffer, file.name.replace(/\.[^.]+$/, ""));
            const slots = engine.sampler.slots;
            setState(prev => ({
                ...prev,
                samplerSlots: slots.map(s => ({ ...s })),
            }));
            return true;
        } catch {
            return false;
        }
    }, []);

    const clearSampler = useCallback((slotIndex: number) => {
        engineRef.current?.sampler.clear(slotIndex);
        setState(prev => ({
            ...prev,
            samplerSlots: prev.samplerSlots.map((s, i) =>
                i === slotIndex ? { id: i, name: `Slot ${i + 1}`, buffer: null, isPlaying: false, volume: 0.8, isLooping: false } : s
            ),
        }));
    }, []);

    const toggleSamplerLoop = useCallback((slotIndex: number) => {
        engineRef.current?.sampler.toggleLoop(slotIndex);
        setState(prev => ({
            ...prev,
            samplerSlots: prev.samplerSlots.map((s, i) =>
                i === slotIndex ? { ...s, isLooping: !s.isLooping } : s
            ),
        }));
    }, []);

    const captureLoopToSampler = useCallback(async (deck: DeckSide, slotIndex: number) => {
        const engine = engineRef.current;
        const deckEngine = getDeckEngine(deck);
        if (!engine || !deckEngine) return;

        const key = DECK_STATE_KEY[deck];
        const deckState = state[key];
        if (!deckState.loopEnabled) return;

        const success = await engine.sampler.captureFromDeck(deckEngine, slotIndex, deckState.loopStart, deckState.loopEnd);
        if (success) {
            const slots = engine.sampler.slots;
            setState(prev => ({
                ...prev,
                samplerSlots: slots.map(s => ({ ...s })),
            }));
        }
    }, [getDeckEngine, state]);

    const setAutomixConfig = useCallback((config: Partial<AutomixConfig>) => {
        engineRef.current?.setAutomixConfig(config);
        setState(prev => ({
            ...prev,
            automixConfig: { ...prev.automixConfig, ...config },
        }));
    }, []);

    const toggleAutomix = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;

        setState(prev => {
            const newEnabled = !prev.automixEnabled;
            if (newEnabled) {
                engine.startAutomix((_fromDeck, _toDeck) => {
                    // Automix transition callback
                    engine.performAutomixFade(_fromDeck, engine.automixConfig.fadeDuration);
                });
            } else {
                engine.stopAutomix();
            }
            return { ...prev, automixEnabled: newEnabled };
        });
    }, []);

    const undoMixAction = useCallback(() => {
        const action = engineRef.current?.undoLastAction();
        if (action) {
            setState(prev => ({
                ...prev,
                mixHistory: engineRef.current?.mixHistory || [],
            }));
        }
    }, []);

    const computeTransitionSuggestions = useCallback(async (deck: DeckSide) => {
        const key = DECK_STATE_KEY[deck];
        const deckState = state[key];
        if (!deckState.bpm || !deckState.key) return;

        // Fetch library tracks for comparison
        try {
            const { getTracks } = await import("@/actions/tracks");
            const result = await getTracks({ pageSize: 100, sort: "bpm", order: "asc" });
            const tracks = result.tracks;

            const suggestions: TransitionSuggestion[] = tracks
                .filter(t => t.id !== deckState.trackId && t.bpm && t.keyCamelot)
                .map(t => {
                    const { score, reason } = calculateTransitionScore(
                        deckState.bpm, deckState.key, 5,
                        t.bpm!, t.keyCamelot!, t.energy || 5,
                    );
                    return {
                        targetTrackId: t.id,
                        targetTitle: t.title || t.filename,
                        targetArtist: t.artist || "Unknown",
                        score,
                        keyCompatibility: getKeyCompatibility(deckState.key, t.keyCamelot!),
                        bpmDiff: Math.abs(deckState.bpm - t.bpm!),
                        energyDiff: (t.energy || 5) - 5,
                        reason,
                    };
                })
                .sort((a, b) => b.score - a.score)
                .slice(0, 10);

            setState(prev => ({ ...prev, transitionSuggestions: suggestions }));
        } catch { /* ignore */ }
    }, [state]);

    const setMidiClockEnabled = useCallback((enabled: boolean) => {
        setState(prev => ({ ...prev, midiClockEnabled: enabled }));
    }, []);

    // Memoize actions object — stable reference, only changes if callbacks change
    // (they won't because they're all useCallback with stable deps)
    const actions = useMemo<MixerActions>(() => ({
        loadTrack,
        play,
        pause,
        togglePlay,
        seek,
        beatJump,
        nudge,
        nudgeRelease,
        setVolume,
        setEQ,
        toggleEQKill,
        setBpm,
        syncBpm,
        setKeyShift,
        setKeyLock,
        setFilter: setFilterAction,
        setFilterType,
        setColorFx: setColorFxAction,
        setColorFxType,
        setBeatFx: setBeatFxAction,
        setBeatFxAmount,
        toggleBeatFx,
        setBeatFxBeatDiv,
        setLoop,
        toggleLoop,
        moveLoop,
        setHotCue,
        jumpHotCue,
        clearHotCue,
        ejectTrack,
        toggleSlipMode,
        toggleQuantize,
        toggleHeadphoneCue,
        setPadMode,
        setCrossfader,
        setCrossfaderCurve,
        setMasterVolume,
        setHeadphoneVolume,
        setHeadphoneMix,
        setEQMode: setEQModeAction,
        setTempoRange,
        setJogSensitivity,
        toggleRecording,
        initMixer,
        destroyMixer,
        getDeckAnalyser,
        getDeckStems,
        getMasterAnalyser,
        getAudioInfo,
        setDeckMode,
        setWaveformMode,
        setCrossfaderAssign,
        setBeatGrid,
        nudgeBeatGrid,
        triggerSampler,
        stopSampler,
        loadSample,
        loadSampleFromFile,
        clearSampler,
        toggleSamplerLoop,
        captureLoopToSampler,
        setAutomixConfig,
        toggleAutomix,
        undoMixAction,
        computeTransitionSuggestions,
        setMidiClockEnabled,
        getDeckCurrentTime,
    }), [
        loadTrack, play, pause, togglePlay, seek, beatJump, nudge, nudgeRelease,
        setVolume, setEQ, toggleEQKill, setBpm, syncBpm, setKeyShift, setKeyLock,
        setFilterAction, setFilterType, setColorFxAction, setColorFxType,
        setBeatFxAction, setBeatFxAmount, toggleBeatFx, setBeatFxBeatDiv,
        setLoop, toggleLoop, moveLoop, setHotCue, jumpHotCue, clearHotCue,
        ejectTrack, toggleSlipMode, toggleQuantize, toggleHeadphoneCue, setPadMode,
        setCrossfader, setCrossfaderCurve, setMasterVolume, setHeadphoneVolume, setHeadphoneMix,
        setEQModeAction, setTempoRange, setJogSensitivity, toggleRecording,
        initMixer, destroyMixer, getDeckAnalyser, getDeckStems, getMasterAnalyser, getAudioInfo,
        setDeckMode, setWaveformMode, setCrossfaderAssign, setBeatGrid, nudgeBeatGrid,
        triggerSampler, stopSampler, loadSample, loadSampleFromFile, clearSampler,
        toggleSamplerLoop, captureLoopToSampler, setAutomixConfig, toggleAutomix,
        undoMixAction, computeTransitionSuggestions, setMidiClockEnabled, getDeckCurrentTime,
    ]);

    return (
        <MixerActionsContext.Provider value={actions}>
            <MixerStateContext.Provider value={state}>
                {children}
            </MixerStateContext.Provider>
        </MixerActionsContext.Provider>
    );
}
