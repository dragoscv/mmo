"use client";

import {
    createContext,
    useContext,
    useRef,
    useState,
    useCallback,
    useEffect,
    type ReactNode,
} from "react";
import {
    MixerEngine,
    DEFAULT_DECK_STATE,
    shiftKeyName,
    type DeckState,
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

// ─── Types ───────────────────────────────────────────────────────────────

interface MixerState {
    deckA: DeckState;
    deckB: DeckState;
    deckATrack: Track | null;
    deckBTrack: Track | null;
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
    loadTrack: (deck: "A" | "B", track: Track) => void;
    play: (deck: "A" | "B") => void;
    pause: (deck: "A" | "B") => void;
    togglePlay: (deck: "A" | "B") => void;
    seek: (deck: "A" | "B", time: number) => void;
    beatJump: (deck: "A" | "B", beats: number) => void;
    nudge: (deck: "A" | "B", ms: number) => void;
    nudgeRelease: (deck: "A" | "B") => void;
    setVolume: (deck: "A" | "B", vol: number) => void;
    setEQ: (deck: "A" | "B", band: "low" | "mid" | "hi", gain: number) => void;
    toggleEQKill: (deck: "A" | "B", band: "low" | "mid" | "hi") => void;
    setBpm: (deck: "A" | "B", bpm: number) => void;
    syncBpm: (deck: "A" | "B") => void;
    setKeyShift: (deck: "A" | "B", semitones: number) => void;
    setKeyLock: (deck: "A" | "B", enabled: boolean) => void;
    setFilter: (deck: "A" | "B", value: number) => void;
    setFilterType: (deck: "A" | "B", type: FilterType) => void;
    setColorFx: (deck: "A" | "B", value: number) => void;
    setColorFxType: (deck: "A" | "B", type: ColorFxType) => void;
    setBeatFx: (deck: "A" | "B", type: BeatFxType) => void;
    setBeatFxAmount: (deck: "A" | "B", amount: number) => void;
    toggleBeatFx: (deck: "A" | "B") => void;
    setBeatFxBeatDiv: (deck: "A" | "B", div: number) => void;
    setLoop: (deck: "A" | "B", beats: number) => void;
    toggleLoop: (deck: "A" | "B") => void;
    moveLoop: (deck: "A" | "B", direction: "left" | "right") => void;
    setHotCue: (deck: "A" | "B", index: number) => void;
    jumpHotCue: (deck: "A" | "B", index: number) => void;
    clearHotCue: (deck: "A" | "B", index: number) => void;
    ejectTrack: (deck: "A" | "B") => void;
    toggleSlipMode: (deck: "A" | "B") => void;
    toggleQuantize: (deck: "A" | "B") => void;
    toggleHeadphoneCue: (deck: "A" | "B") => void;
    setPadMode: (deck: "A" | "B", mode: PadMode) => void;
    setCrossfaderAssign: (deck: "A" | "B", assign: CrossfaderAssign) => void;
    setBeatGrid: (deck: "A" | "B", grid: Partial<BeatGridState>) => void;
    nudgeBeatGrid: (deck: "A" | "B", direction: "left" | "right") => void;
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
    toggleRecording: () => void;
    initMixer: () => void;
    destroyMixer: () => void;
    getDeckAnalyser: (deck: "A" | "B") => AnalyserNode | null;
    getMasterAnalyser: () => AnalyserNode | null;
    getAudioInfo: () => { sampleRate: number; baseLatency: number; outputLatency: number; channelCount: number; state: string } | null;
    // New actions
    setWaveformMode: (mode: WaveformMode) => void;
    triggerSampler: (slotIndex: number) => void;
    stopSampler: (slotIndex: number) => void;
    loadSample: (slotIndex: number, url: string, name?: string) => void;
    loadSampleFromFile: (slotIndex: number, file: File) => Promise<boolean>;
    clearSampler: (slotIndex: number) => void;
    toggleSamplerLoop: (slotIndex: number) => void;
    captureLoopToSampler: (deck: "A" | "B", slotIndex: number) => void;
    setAutomixConfig: (config: Partial<AutomixConfig>) => void;
    toggleAutomix: () => void;
    undoMixAction: () => void;
    computeTransitionSuggestions: (deck: "A" | "B") => void;
    setMidiClockEnabled: (enabled: boolean) => void;
    /** Read current playback time directly from audio element — use in rAF loops to avoid React re-renders */
    getDeckCurrentTime: (deck: "A" | "B") => number;
}

type MixerContextType = MixerState & MixerActions;

// ─── Context ─────────────────────────────────────────────────────────────

const MixerContext = createContext<MixerContextType | null>(null);

export function useMixer() {
    const ctx = useContext(MixerContext);
    if (!ctx) throw new Error("useMixer must be used within MixerProvider");
    return ctx;
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

function serializeDeck(deck: DeckState): PersistedDeckState {
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
        currentTime: deck.currentTime,
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
            deckA: serializeDeck(state.deckA),
            deckB: serializeDeck(state.deckB),
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

export function MixerProvider({ children }: { children: ReactNode }) {
    const engineRef = useRef<MixerEngine | null>(null);
    const recordingTimerRef = useRef<ReturnType<typeof setInterval>>();
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
                // currentTime and duration are restored from persisted (will seek after engine loads)
                currentTime: pd?.currentTime ?? 0,
                duration: pd?.duration ?? 0,
            });
            return {
                deckA: restoreDeck(persisted.deckA),
                deckB: restoreDeck(persisted.deckB),
                deckATrack: null,
                deckBTrack: null,
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
                isRestoring: !!(persisted.deckA?.trackId || persisted.deckB?.trackId),
                restorationProgress: 0,
                restorationLabel: "Initializing...",
            };
        }
        return {
            deckA: { ...DEFAULT_DECK_STATE },
            deckB: { ...DEFAULT_DECK_STATE },
            deckATrack: null,
            deckBTrack: null,
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
    const updateDeck = useCallback((deck: "A" | "B", update: Partial<DeckState>) => {
        setState(prev => ({
            ...prev,
            [deck === "A" ? "deckA" : "deckB"]: {
                ...prev[deck === "A" ? "deckA" : "deckB"],
                ...update,
            },
        }));
    }, []);

    const getDeckEngine = useCallback((deck: "A" | "B") => {
        if (!engineRef.current) return null;
        return deck === "A" ? engineRef.current.deckA : engineRef.current.deckB;
    }, []);

    // ─── Lifecycle ──────────────────────────────────────────────────────

    const initMixer = useCallback(() => {
        if (engineRef.current) return;
        const engine = new MixerEngine();

        // Wire up time tracking
        engine.deckA.onTimeUpdate = (t) => updateDeck("A", { currentTime: t });
        engine.deckB.onTimeUpdate = (t) => updateDeck("B", { currentTime: t });
        engine.deckA.onLoaded = (d) => updateDeck("A", { duration: d, isLoaded: true });
        engine.deckB.onLoaded = (d) => updateDeck("B", { duration: d, isLoaded: true });
        engine.deckA.onEnded = () => updateDeck("A", { isPlaying: false });
        engine.deckB.onEnded = () => updateDeck("B", { isPlaying: false });

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
        setState({
            deckA: { ...DEFAULT_DECK_STATE },
            deckB: { ...DEFAULT_DECK_STATE },
            deckATrack: null,
            deckBTrack: null,
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
        });
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            engineRef.current?.destroy();
        };
    }, []);

    // Persist state to localStorage (debounced)
    const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const stateRef = useRef(state);
    stateRef.current = state;
    useEffect(() => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => savePersistedState(state), 500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [state]);

    // Final accurate save on tab close — reads currentTime from engine for precision
    useEffect(() => {
        const handleBeforeUnload = () => {
            const engine = engineRef.current;
            const s = stateRef.current;
            const finalState = { ...s };
            if (engine) {
                finalState.deckA = { ...s.deckA, currentTime: engine.deckA.getCurrentTime() || s.deckA.currentTime };
                finalState.deckB = { ...s.deckB, currentTime: engine.deckB.getCurrentTime() || s.deckB.currentTime };
            }
            savePersistedState(finalState);
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, []);

    // Auto-reload persisted tracks and apply ALL state to engine after init
    const hasRestoredRef = useRef(false);
    useEffect(() => {
        if (!state.isActive || hasRestoredRef.current) return;
        hasRestoredRef.current = true;
        const engine = engineRef.current;
        if (!engine) return;

        const hasTracksToRestore = !!(state.deckA.trackId || state.deckB.trackId);
        if (!hasTracksToRestore) {
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
        engine.setCrossfaderAssign("A", state.deckA.crossfaderAssign);
        engine.setCrossfaderAssign("B", state.deckB.crossfaderAssign);

        setProgress(15, "Restoring EQ & effects...");

        // Track how many decks need loading to know when fully done
        const decksToLoad = [state.deckA, state.deckB].filter(d => d.trackId).length;
        let decksLoaded = 0;

        // ─── Restore each deck ──────────────────────────────────────────
        const restoreDeckEngine = (side: "A" | "B", deck: DeckState, baseProgress: number) => {
            const eng = side === "A" ? engine.deckA : engine.deckB;
            if (!eng) return;

            // Apply EQ mode
            eng.setEQMode(state.eqMode);

            // Apply volume
            eng.setVolume(deck.volume);

            // Apply EQ
            eng.setEQ("low", deck.eqLow);
            eng.setEQ("mid", deck.eqMid);
            eng.setEQ("hi", deck.eqHi);
            if (deck.eqLowKill) eng.setEQKill("low", true);
            if (deck.eqMidKill) eng.setEQKill("mid", true);
            if (deck.eqHiKill) eng.setEQKill("hi", true);

            // Apply filter
            if (deck.filter !== 0) eng.setFilter(deck.filter, deck.filterType);

            // Apply color FX
            if (deck.colorFx !== 0) eng.setColorFx(deck.colorFx, deck.colorFxType);

            // Apply beat FX
            if (deck.beatFxOn) eng.setBeatFx(deck.beatFxType, deck.beatFxAmount, deck.bpm, deck.beatFxBeatDiv);

            // Apply key shift & key lock
            if (deck.keyShift !== 0) eng.setKeyShift(deck.keyShift);
            if (deck.keyLock) eng.setKeyLock(true);

            // Apply headphone cue
            if (deck.headphoneCue) eng.setHeadphoneCue(true);

            // Load track & seek to persisted position once loaded
            if (deck.trackId) {
                setProgress(baseProgress, `Loading Deck ${side} track...`);
                const savedTime = deck.currentTime;
                eng.loadTrack(deck.trackId);

                // Apply tempo
                if (deck.bpm > 0 && deck.originalBpm > 0 && deck.bpm !== deck.originalBpm) {
                    eng.setTempo(deck.bpm / deck.originalBpm);
                }

                // After track loads: seek to saved position and restore loop
                const existingOnLoaded = eng.onLoaded;
                eng.onLoaded = (duration) => {
                    existingOnLoaded?.(duration);
                    // Seek to the saved position
                    if (savedTime > 0 && savedTime < duration) {
                        eng.seek(savedTime);
                        updateDeck(side, { currentTime: savedTime, duration, isLoaded: true });
                    }
                    // Restore loop
                    if (deck.loopEnabled && deck.loopStart >= 0 && deck.loopEnd > deck.loopStart) {
                        eng.enableLoop(deck.loopStart, deck.loopEnd);
                    }
                    // Track completion
                    decksLoaded++;
                    if (decksLoaded >= decksToLoad) {
                        setProgress(100, "Session restored");
                        // Auto-hide after a short delay
                        setTimeout(() => {
                            setState(prev => ({ ...prev, isRestoring: false, restorationLabel: "" }));
                        }, 1500);
                    } else {
                        setProgress(70, `Deck ${side} ready, loading next...`);
                    }
                };

                // Fetch full Track object from DB
                setProgress(baseProgress + 10, `Fetching Deck ${side} metadata...`);
                getTrackById(deck.trackId).then(t => {
                    if (t) setState(prev => ({ ...prev, [side === "A" ? "deckATrack" : "deckBTrack"]: t }));
                });
            }
        };

        restoreDeckEngine("A", state.deckA, 25);
        restoreDeckEngine("B", state.deckB, 55);
    }, [state.isActive, updateDeck]);

    // ─── Deck Actions ───────────────────────────────────────────────────

    const loadTrack = useCallback((deck: "A" | "B", track: Track) => {
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
        // Auto-gain: use track's gain/loudness metadata if available, else measure peak
        const existingOnLoaded = eng.onLoaded;
        eng.onLoaded = (duration) => {
            existingOnLoaded?.(duration);
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
            [deck === "A" ? "deckATrack" : "deckBTrack"]: track,
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
            key: track.keyCamelot || "",
            originalKey: track.keyCamelot || "",
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
    }, [initMixer, getDeckEngine, updateDeck]);

    const play = useCallback((deck: "A" | "B") => {
        getDeckEngine(deck)?.play();
        updateDeck(deck, { isPlaying: true });
        // Mark session history as played
        engineRef.current?.markPlayed(deck);
    }, [getDeckEngine, updateDeck]);

    const pause = useCallback((deck: "A" | "B") => {
        getDeckEngine(deck)?.pause();
        updateDeck(deck, { isPlaying: false });
    }, [getDeckEngine, updateDeck]);

    const togglePlay = useCallback((deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const seek = useCallback((deck: "A" | "B", time: number) => {
        getDeckEngine(deck)?.seek(time);
        updateDeck(deck, { currentTime: time });
    }, [getDeckEngine, updateDeck]);

    const beatJump = useCallback((deck: "A" | "B", beats: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const beatDuration = 60 / deckState.bpm;
            let targetTime = deckState.currentTime + beats * beatDuration;
            // If quantize is on, snap to beat grid
            if (deckState.quantize) {
                targetTime = getDeckEngine(deck)?.quantizeTime(targetTime, deckState.bpm) ?? targetTime;
            }
            targetTime = Math.max(0, Math.min(targetTime, deckState.duration));
            getDeckEngine(deck)?.seek(targetTime);
            return { ...prev, [key]: { ...deckState, currentTime: targetTime } };
        });
    }, [getDeckEngine]);

    const nudge = useCallback((deck: "A" | "B", ms: number) => {
        // ms is now treated as a direction/strength indicator:
        // positive = speed up, negative = slow down
        // Convert ms to a pitch bend strength (larger ms = stronger bend)
        const strength = Math.min(0.08, Math.abs(ms) / 1000);
        getDeckEngine(deck)?.nudgeBurst(ms > 0 ? 1 : -1, strength);
    }, [getDeckEngine]);

    const nudgeRelease = useCallback((deck: "A" | "B") => {
        getDeckEngine(deck)?.releaseNudge();
    }, [getDeckEngine]);

    const setVolume = useCallback((deck: "A" | "B", vol: number) => {
        getDeckEngine(deck)?.setVolume(vol);
        updateDeck(deck, { volume: vol });
    }, [getDeckEngine, updateDeck]);

    const setEQ = useCallback((deck: "A" | "B", band: "low" | "mid" | "hi", gain: number) => {
        getDeckEngine(deck)?.setEQ(band, gain);
        const update = band === "low" ? { eqLow: gain } : band === "mid" ? { eqMid: gain } : { eqHi: gain };
        updateDeck(deck, update);
    }, [getDeckEngine, updateDeck]);

    const toggleEQKill = useCallback((deck: "A" | "B", band: "low" | "mid" | "hi") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const setBpm = useCallback((deck: "A" | "B", bpm: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const ratio = bpm / deckState.originalBpm;
            getDeckEngine(deck)?.setTempo(ratio);
            return { ...prev, [key]: { ...deckState, bpm } };
        });
    }, [getDeckEngine]);

    const syncBpm = useCallback((deck: "A" | "B") => {
        const otherKey = deck === "A" ? "deckB" : "deckA";
        setState(prev => {
            const targetBpm = prev[otherKey].bpm;
            const deckKey = deck === "A" ? "deckA" : "deckB";
            const deckState = prev[deckKey];
            const ratio = targetBpm / deckState.originalBpm;
            getDeckEngine(deck)?.setTempo(ratio);
            return { ...prev, [deckKey]: { ...deckState, bpm: targetBpm } };
        });
    }, [getDeckEngine]);

    const setKeyShift = useCallback((deck: "A" | "B", semitones: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const setFilterAction = useCallback((deck: "A" | "B", value: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setFilter(value, deckState.filterType);
            return { ...prev, [key]: { ...deckState, filter: value } };
        });
    }, [getDeckEngine]);

    const setFilterType = useCallback((deck: "A" | "B", type: FilterType) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setFilter(deckState.filter, type);
            return { ...prev, [key]: { ...deckState, filterType: type } };
        });
    }, [getDeckEngine]);

    const setColorFxAction = useCallback((deck: "A" | "B", value: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setColorFx(value, deckState.colorFxType);
            return { ...prev, [key]: { ...deckState, colorFx: value } };
        });
    }, [getDeckEngine]);

    const setColorFxType = useCallback((deck: "A" | "B", type: ColorFxType) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            getDeckEngine(deck)?.setColorFx(deckState.colorFx, type);
            return { ...prev, [key]: { ...deckState, colorFxType: type } };
        });
    }, [getDeckEngine]);

    const setLoop = useCallback((deck: "A" | "B", beats: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const beatDuration = 60 / deckState.bpm;
            const loopLength = beatDuration * beats;
            let loopStart = deckState.currentTime;
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

    const toggleLoop = useCallback((deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            if (deckState.loopEnabled) {
                getDeckEngine(deck)?.disableLoop();
                return { ...prev, [key]: { ...deckState, loopEnabled: false } };
            } else {
                const beatDuration = 60 / deckState.bpm;
                const loopLength = beatDuration * deckState.loopBeats;
                let loopStart = deckState.currentTime;
                if (deckState.quantize && deckState.bpm > 0) {
                    loopStart = getDeckEngine(deck)?.quantizeTime(loopStart, deckState.bpm) ?? loopStart;
                }
                const loopEnd = loopStart + loopLength;
                getDeckEngine(deck)?.enableLoop(loopStart, loopEnd);
                return { ...prev, [key]: { ...deckState, loopEnabled: true, loopStart, loopEnd } };
            }
        });
    }, [getDeckEngine]);

    const moveLoop = useCallback((deck: "A" | "B", direction: "left" | "right") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const setHotCue = useCallback((deck: "A" | "B", index: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const hotCues = [...deckState.hotCues];
            let cueTime = deckState.currentTime;
            // Quantize hot cue position to beat grid if quantize is on
            if (deckState.quantize && deckState.bpm > 0) {
                cueTime = getDeckEngine(deck)?.quantizeTime(cueTime, deckState.bpm) ?? cueTime;
            }
            hotCues[index] = cueTime;
            return { ...prev, [key]: { ...deckState, hotCues } };
        });
    }, [getDeckEngine]);

    const jumpHotCue = useCallback((deck: "A" | "B", index: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const time = deckState.hotCues[index];
            if (time != null) {
                getDeckEngine(deck)?.seek(time);
                return { ...prev, [key]: { ...deckState, currentTime: time } };
            }
            return prev;
        });
    }, [getDeckEngine]);

    const clearHotCue = useCallback((deck: "A" | "B", index: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const hotCues = [...deckState.hotCues];
            hotCues[index] = null;
            return { ...prev, [key]: { ...deckState, hotCues } };
        });
    }, []);

    const ejectTrack = useCallback((deck: "A" | "B") => {
        const eng = getDeckEngine(deck);
        if (eng) {
            eng.pause();
            eng.audio.src = "";
        }
        setState(prev => ({
            ...prev,
            [deck === "A" ? "deckATrack" : "deckBTrack"]: null,
        }));
        updateDeck(deck, { ...DEFAULT_DECK_STATE });
    }, [getDeckEngine, updateDeck]);

    // ─── New Deck Actions ───────────────────────────────────────────────

    const setKeyLock = useCallback((deck: "A" | "B", enabled: boolean) => {
        getDeckEngine(deck)?.setKeyLock(enabled);
        updateDeck(deck, { keyLock: enabled });
    }, [getDeckEngine, updateDeck]);

    const setBeatFxAction = useCallback((deck: "A" | "B", type: BeatFxType) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(type, deckState.beatFxAmount, deckState.bpm, deckState.beatFxBeatDiv);
            }
            return { ...prev, [key]: { ...deckState, beatFxType: type } };
        });
    }, [getDeckEngine]);

    const setBeatFxAmount = useCallback((deck: "A" | "B", amount: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, amount, deckState.bpm, deckState.beatFxBeatDiv);
            }
            return { ...prev, [key]: { ...deckState, beatFxAmount: amount } };
        });
    }, [getDeckEngine]);

    const toggleBeatFx = useCallback((deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const setBeatFxBeatDiv = useCallback((deck: "A" | "B", div: number) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            if (deckState.beatFxOn) {
                getDeckEngine(deck)?.setBeatFx(deckState.beatFxType, deckState.beatFxAmount, deckState.bpm, div);
            }
            return { ...prev, [key]: { ...deckState, beatFxBeatDiv: div } };
        });
    }, [getDeckEngine]);

    const toggleSlipMode = useCallback((deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const toggleQuantize = useCallback((deck: "A" | "B") => {
        updateDeck(deck, { quantize: !(deck === "A" ? state.deckA : state.deckB).quantize });
    }, [updateDeck, state.deckA.quantize, state.deckB.quantize]);

    const toggleHeadphoneCue = useCallback((deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => {
            const deckState = prev[key];
            const newCue = !deckState.headphoneCue;
            getDeckEngine(deck)?.setHeadphoneCue(newCue);
            return { ...prev, [key]: { ...deckState, headphoneCue: newCue } };
        });
    }, [getDeckEngine]);

    const setPadMode = useCallback((deck: "A" | "B", mode: PadMode) => {
        updateDeck(deck, { padMode: mode });
    }, [updateDeck]);

    // ─── Master Controls ────────────────────────────────────────────────

    const setCrossfader = useCallback((value: number) => {
        engineRef.current?.setCrossfader(value);
        setState(prev => ({ ...prev, crossfader: value }));
    }, []);

    const setCrossfaderCurve = useCallback((curve: CrossfaderCurve) => {
        engineRef.current?.setCrossfaderCurve(curve);
        setState(prev => ({ ...prev, crossfaderCurve: curve }));
    }, []);

    const setMasterVolume = useCallback((value: number) => {
        engineRef.current?.setMasterVolume(value);
        setState(prev => ({ ...prev, masterVolume: value }));
    }, []);

    const setHeadphoneVolume = useCallback((value: number) => {
        engineRef.current?.setHeadphoneVolume(value);
        setState(prev => ({ ...prev, headphoneVolume: value }));
    }, []);

    const setHeadphoneMix = useCallback((mix: number) => {
        engineRef.current?.setHeadphoneMix(mix);
        setState(prev => ({ ...prev, headphoneMix: mix }));
    }, []);

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
                    // Download the recording
                    const url = URL.createObjectURL(result.blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `mix-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.webm`;
                    a.click();
                    URL.revokeObjectURL(url);
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

    const getDeckAnalyser = useCallback((deck: "A" | "B") => {
        return getDeckEngine(deck)?.analyser ?? null;
    }, [getDeckEngine]);

    const getDeckCurrentTime = useCallback((deck: "A" | "B") => {
        return getDeckEngine(deck)?.getCurrentTime() ?? 0;
    }, [getDeckEngine]);

    const getMasterAnalyser = useCallback(() => {
        return engineRef.current?.masterAnalyser ?? null;
    }, []);

    const getAudioInfo = useCallback(() => {
        return engineRef.current?.getAudioInfo() ?? null;
    }, []);

    // ─── New Actions ─────────────────────────────────────────────────

    const setWaveformMode = useCallback((mode: WaveformMode) => {
        setState(prev => ({ ...prev, waveformMode: mode }));
        try { localStorage.setItem("mmo-mixer-wf-mode", mode); } catch { /* ignore */ }
    }, []);

    const setCrossfaderAssign = useCallback((deck: "A" | "B", assign: CrossfaderAssign) => {
        engineRef.current?.setCrossfaderAssign(deck, assign);
        updateDeck(deck, { crossfaderAssign: assign });
    }, [updateDeck]);

    const setBeatGrid = useCallback((deck: "A" | "B", grid: Partial<BeatGridState>) => {
        const key = deck === "A" ? "deckA" : "deckB";
        setState(prev => ({
            ...prev,
            [key]: { ...prev[key], beatGrid: { ...prev[key].beatGrid, ...grid } },
        }));
    }, []);

    const nudgeBeatGrid = useCallback((deck: "A" | "B", direction: "left" | "right") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    const captureLoopToSampler = useCallback(async (deck: "A" | "B", slotIndex: number) => {
        const engine = engineRef.current;
        const deckEngine = getDeckEngine(deck);
        if (!engine || !deckEngine) return;

        const key = deck === "A" ? "deckA" : "deckB";
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

    const computeTransitionSuggestions = useCallback(async (deck: "A" | "B") => {
        const key = deck === "A" ? "deckA" : "deckB";
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

    return (
        <MixerContext.Provider
            value={{
                ...state,
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
                getMasterAnalyser,
                getAudioInfo,
                // New actions
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
            }}
        >
            {children}
        </MixerContext.Provider>
    );
}
