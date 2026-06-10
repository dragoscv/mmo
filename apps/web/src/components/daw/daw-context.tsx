"use client";

import {
    createContext,
    useContext,
    useCallback,
    useRef,
    useState,
    useEffect,
    useMemo,
    type ReactNode,
} from "react";
import { useRenderCount } from "@/lib/dev-debugger";
import { useProjectAutosave } from "@/hooks/use-project-autosave";
import { getProject as fetchProjectFromServer } from "@/actions/projects";
import {
    DAWEngine,
    createDefaultProject,
    createDefaultTrack,
    createDefaultStepPattern,
    createClip,
    createId,
    saveProject,
    loadProject,
    getActiveProjectId,
    DEFAULT_SYNTH_CONFIG,
    DEFAULT_EFFECT_PARAMS,
    type DAWProject,
    type DAWTrack,
    type Clip,
    type MidiNote,
    type AutomationLane,
    type AutomationPoint,
    type InsertEffect,
    type SendConfig,
    type EffectType,
    type TrackType,
    type ClipType,
    type ToolMode,
    type SnapValue,
    type LoopRegion,
    type SynthConfig,
    type StepSequencerPattern,
    type AudioClipData,
} from "@/lib/daw-engine";
import {
    type HistoryState,
    type HistoryEntry,
    createHistory,
    pushHistory,
    undoHistory,
    redoHistory,
    jumpToHistory,
    getCurrentSnapshot,
    canUndo as histCanUndo,
    canRedo as histCanRedo,
    resetHistory,
} from "@/lib/history-engine";
import { getDAWSettings } from "@/hooks/use-daw-settings";
import {
    type ClipboardState,
    type ClipboardEntry,
    loadClipboard,
    saveClipboard,
    addToClipboard,
    removeFromClipboard,
    togglePinClipboard,
    setActiveClipboard,
    getActiveEntry,
    clearClipboard,
} from "@/lib/clipboard-manager";

// ═══════════════════════════════════════════════════════════════════════════
// Voice Processor Bridge (for remote control)
// ═══════════════════════════════════════════════════════════════════════════

export interface VPFxInsertSnapshot {
    id: string;
    type: string;
    enabled: boolean;
    params: Record<string, number>;
}

export interface VPRemoteState {
    isActive: boolean;
    inputGain: number;
    outputGain: number;
    selectedKey: number;
    selectedScale: number;
    chain: VPFxInsertSnapshot[];
    peakL: number;
    peakR: number;
    rms: number;
    pitchNote: string;
    pitchCents: number;
    pitchConfidence: number;
}

import type { FxType } from "@/lib/audio-fx-engine";

export interface VPCommandHandlers {
    toggleActive: () => void;
    setInputGain: (v: number) => void;
    setOutputGain: (v: number) => void;
    setKey: (k: number) => void;
    setScale: (s: number) => void;
    addEffect: (type: FxType) => void;
    removeEffect: (id: string) => void;
    toggleEffect: (id: string) => void;
    updateParam: (insertId: string, param: string, value: number) => void;
    autoDetect: () => void;
}

export interface VPBridge {
    getState: () => VPRemoteState;
    handlers: VPCommandHandlers;
}

// ═══════════════════════════════════════════════════════════════════════════
// State Types
// ═══════════════════════════════════════════════════════════════════════════

interface DAWState {
    project: DAWProject;
    isPlaying: boolean;
    isRecording: boolean;
    currentBeat: number;
    playbackMode: "pattern" | "song";
    currentStepIndex: number; // current step in step sequencer
    activeClipIds: string[]; // clips currently under playhead
    tool: ToolMode;
    snap: SnapValue;
    metronomeOn: boolean;
    metronomeVolume: number;
    zoom: number;           // pixels per beat
    scrollX: number;        // beats
    scrollY: number;        // pixels
    selectedTrackId: string | null;
    selectedClipId: string | null;
    selectedNotes: Set<string>;
    clipboard: ClipboardState;
    history: HistoryState<DAWProject>;
    showPianoRoll: boolean;
    showMixer: boolean;
    showStepSequencer: boolean;
    showBrowser: boolean;
    showEffectsRack: boolean;
    showSynth: boolean;
    showAutomation: boolean;
    showHistory: boolean;
    showClipboard: boolean;
    showVoiceProcessor: boolean;
    pianoRollTrackId: string | null;
    pianoRollClipId: string | null;
    synthConfig: SynthConfig;
    stepPattern: StepSequencerPattern;
    // Metering
    masterPeakL: number;
    masterPeakR: number;
    // Browser
    browserTab: "files" | "samples" | "presets" | "plugins";
    // Project management
    projectList: { id: string; name: string; modifiedAt: number; tempo: number; trackCount: number }[];
    showProjectModal: boolean;
    showSettingsModal: boolean;
    showExportModal: boolean;
    isDirty: boolean;
    focusMode: boolean;
}

interface DAWActions {
    // Transport
    play: () => void;
    stop: () => void;
    pause: () => void;
    togglePlay: () => void;
    record: () => void;
    seek: (beat: number) => void;
    setTempo: (bpm: number) => void;
    setTimeSignature: (num: number, den: number) => void;
    toggleMetronome: () => void;
    setPlaybackMode: (mode: "pattern" | "song") => void;
    togglePlaybackMode: () => void;
    setMetronomeVolume: (vol: number) => void;
    toggleLoop: () => void;
    setLoopRegion: (start: number, end: number) => void;
    // Tools
    setTool: (tool: ToolMode) => void;
    setSnap: (snap: SnapValue) => void;
    setZoom: (zoom: number) => void;
    setScroll: (x: number, y: number) => void;
    // Tracks
    addTrack: (type: TrackType) => void;
    removeTrack: (id: string) => void;
    renameTrack: (id: string, name: string) => void;
    setTrackVolume: (id: string, vol: number) => void;
    setTrackPan: (id: string, pan: number) => void;
    toggleTrackMute: (id: string) => void;
    toggleTrackSolo: (id: string) => void;
    toggleTrackArm: (id: string) => void;
    setTrackColor: (id: string, color: string) => void;
    setTrackHeight: (id: string, height: number) => void;
    reorderTrack: (id: string, newIndex: number) => void;
    selectTrack: (id: string | null) => void;
    duplicateTrack: (id: string) => void;
    freezeTrack: (id: string) => void;
    // Clips
    addClip: (trackId: string, type: ClipType, position: number, length: number, name?: string) => Clip;
    removeClip: (clipId: string) => void;
    moveClip: (clipId: string, newTrackId: string, newPosition: number) => void;
    resizeClip: (clipId: string, newLength: number) => void;
    splitClip: (clipId: string, position: number) => void;
    duplicateClip: (clipId: string) => void;
    muteClip: (clipId: string) => void;
    setClipColor: (clipId: string, color: string) => void;
    selectClip: (clipId: string | null) => void;
    loadAudioIntoClip: (clipId: string, url: string, name?: string) => Promise<void>;
    loadFileIntoClip: (clipId: string, file: File) => Promise<void>;
    // Audio editing
    setClipGain: (clipId: string, gain: number) => void;
    setClipFade: (clipId: string, fadeIn: number, fadeOut: number) => void;
    reverseClip: (clipId: string) => void;
    setClipPitch: (clipId: string, semitones: number) => void;
    setClipTimeStretch: (clipId: string, ratio: number) => void;
    normalizeClip: (clipId: string) => void;
    // Piano Roll / MIDI
    addNote: (clipId: string, note: Omit<MidiNote, "id">) => void;
    removeNote: (clipId: string, noteId: string) => void;
    moveNote: (clipId: string, noteId: string, pitch: number, start: number) => void;
    resizeNote: (clipId: string, noteId: string, duration: number) => void;
    setNoteVelocity: (clipId: string, noteId: string, velocity: number) => void;
    selectNotes: (noteIds: string[]) => void;
    clearSelection: () => void;
    openPianoRoll: (trackId: string, clipId: string) => void;
    closePianoRoll: () => void;
    // Synth
    playSynthNote: (pitch: number, velocity?: number) => string;
    stopSynthNote: (noteId: string) => void;
    setSynthConfig: (config: Partial<SynthConfig>) => void;
    // Step Sequencer
    toggleStep: (trackIdx: number, stepIdx: number) => void;
    setStepVelocity: (trackIdx: number, stepIdx: number, velocity: number) => void;
    setPatternSteps: (steps: number) => void;
    setPatternSwing: (swing: number) => void;
    clearPattern: () => void;
    // Effects
    addInsert: (trackId: string, type: EffectType) => void;
    removeInsert: (trackId: string, insertId: string) => void;
    toggleInsert: (trackId: string, insertId: string) => void;
    setInsertParam: (trackId: string, insertId: string, param: string, value: number) => void;
    setSidechainSource: (trackId: string, insertId: string, sourceTrackId: string | undefined) => void;
    reorderInserts: (trackId: string, fromIndex: number, toIndex: number) => void;
    // Sends
    addSend: (trackId: string, returnTrackId: string) => void;
    removeSend: (trackId: string, returnTrackId: string) => void;
    setSendAmount: (trackId: string, returnTrackId: string, amount: number) => void;
    // Automation
    addAutomationLane: (trackId: string, parameter: string) => void;
    removeAutomationLane: (laneId: string) => void;
    addAutomationPoint: (laneId: string, time: number, value: number) => void;
    removeAutomationPoint: (laneId: string, pointIndex: number) => void;
    moveAutomationPoint: (laneId: string, pointIndex: number, time: number, value: number) => void;
    setAutomationLaneMode: (laneId: string, mode: "read" | "write" | "touch" | "latch") => void;
    recordAutomationTouch: (laneId: string, value: number) => void;
    releaseAutomationTouch: (laneId: string) => void;
    toggleAutomationVisibility: () => void;
    // Panels
    togglePanel: (panel: "pianoRoll" | "mixer" | "stepSequencer" | "browser" | "effectsRack" | "synth" | "automation" | "history" | "clipboard" | "voiceProcessor") => void;
    // Project
    newProject: (name?: string) => void;
    openProject: (id: string) => void;
    saveCurrentProject: () => void;
    renameProject: (name: string) => void;
    setProjectModal: (open: boolean) => void;
    setSettingsModal: (open: boolean) => void;
    setExportModal: (open: boolean) => void;
    toggleFocusMode: () => void;
    setBrowserTab: (tab: "files" | "samples" | "presets" | "plugins") => void;
    // Undo / Redo / History
    undo: () => void;
    redo: () => void;
    jumpToHistoryEntry: (index: number) => void;
    // Clipboard
    copyClips: (clipIds: string[]) => void;
    cutClips: (clipIds: string[]) => void;
    copyNotes: (clipId: string, noteIds: string[]) => void;
    cutNotes: (clipId: string, noteIds: string[]) => void;
    copyTrack: (trackId: string) => void;
    pasteClips: (trackId: string, position: number) => void;
    pasteNotes: (clipId: string, startBeat: number) => void;
    pasteTrack: () => void;
    removeClipboardEntry: (id: string) => void;
    togglePinClipboardEntry: (id: string) => void;
    setActiveClipboardEntry: (index: number) => void;
    clearAllClipboard: () => void;
    // Import from library
    importTrackFromLibrary: (trackFilepath: string, trackTitle: string, newProject?: boolean) => Promise<void>;
    // Master
    setMasterVolume: (vol: number) => void;
    // Export
    exportProject: (
        format: "wav" | "mp3" | "flac" | "ogg",
        options: {
            bitRate?: number;
            bitDepth?: 16 | 24 | 32;
            sampleRate?: number;
            channels?: 1 | 2;
            normalize?: boolean;
            limitPeak?: boolean;
            tailSec?: number;
            onProgress?: (pct: number) => void;
        },
    ) => Promise<{ blob: Blob; duration: number } | null>;
    // Engine access
    getEngine: () => DAWEngine | null;
    // Voice Processor bridge (for remote)
    registerVPBridge: (bridge: VPBridge) => void;
    unregisterVPBridge: () => void;
    getVPBridge: () => VPBridge | null;
    // Stems
    separateClipToStems: (clipId: string) => Promise<void>;
}

type DAWContextType = DAWState & DAWActions;

// ═══════════════════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════════════════

const DAWStateContext = createContext<DAWState | null>(null);
const DAWActionsContext = createContext<DAWActions | null>(null);

export function useDAW(): DAWContextType {
    const state = useContext(DAWStateContext);
    const actions = useContext(DAWActionsContext);
    if (!state || !actions) throw new Error("useDAW must be used within DAWProvider");
    return { ...state, ...actions };
}

export function useDAWState(): DAWState {
    const state = useContext(DAWStateContext);
    if (!state) throw new Error("useDAWState must be used within DAWProvider");
    return state;
}

export function useDAWActions(): DAWActions {
    const actions = useContext(DAWActionsContext);
    if (!actions) throw new Error("useDAWActions must be used within DAWProvider");
    return actions;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

function loadInitialProject(): DAWProject {
    if (typeof window === "undefined") return createDefaultProject();
    // Check URL params first
    const params = new URLSearchParams(window.location.search);
    const urlProjectId = params.get("project");
    if (urlProjectId) {
        const saved = loadProject(urlProjectId);
        if (saved) return saved;
    }
    const activeId = getActiveProjectId();
    if (activeId) {
        const saved = loadProject(activeId);
        if (saved) return saved;
    }
    return createDefaultProject();
}

const DAW_UI_STATE_KEY = "daw_ui_state";

interface PersistentUIState {
    tool: string;
    snap: string;
    zoom: number;
    showPianoRoll: boolean;
    showMixer: boolean;
    showStepSequencer: boolean;
    showBrowser: boolean;
    showEffectsRack: boolean;
    showSynth: boolean;
    showAutomation: boolean;
    showHistory: boolean;
    showClipboard: boolean;
    showVoiceProcessor: boolean;
    focusMode: boolean;
    metronomeOn: boolean;
    metronomeVolume: number;
    browserTab: string;
}

function loadUIState(): Partial<PersistentUIState> {
    if (typeof window === "undefined") return {};
    try {
        const raw = localStorage.getItem(DAW_UI_STATE_KEY);
        if (!raw) return {};
        return JSON.parse(raw) as Partial<PersistentUIState>;
    } catch {
        return {};
    }
}

function saveUIState(state: DAWState) {
    try {
        const uiState: PersistentUIState = {
            tool: state.tool,
            snap: state.snap,
            zoom: state.zoom,
            showPianoRoll: state.showPianoRoll,
            showMixer: state.showMixer,
            showStepSequencer: state.showStepSequencer,
            showBrowser: state.showBrowser,
            showEffectsRack: state.showEffectsRack,
            showSynth: state.showSynth,
            showAutomation: state.showAutomation,
            showHistory: state.showHistory,
            showClipboard: state.showClipboard,
            showVoiceProcessor: state.showVoiceProcessor,
            focusMode: state.focusMode,
            metronomeOn: state.metronomeOn,
            metronomeVolume: state.metronomeVolume,
            browserTab: state.browserTab,
        };
        localStorage.setItem(DAW_UI_STATE_KEY, JSON.stringify(uiState));
    } catch {
        // Silently fail
    }
}

function updateProjectUrl(projectId: string) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("project", projectId);
    window.history.replaceState({}, "", url.toString());
}

/** Fetch+decode audio for every clip in `doc` that has a sourceUrl but no
 *  decoded buffer, then patch state with the loaded buffer + waveform peaks.
 *  Used after loading from localStorage AND after server hydration / polling
 *  hot-swap, so Maestro-added clips are actually audible. */
function hydrateClipAudioBuffers(
    engine: DAWEngine,
    doc: DAWProject,
    setState: React.Dispatch<React.SetStateAction<DAWState>>,
) {
    const todo: { trackId: string; clipId: string; sourceUrl: string; name: string }[] = [];
    for (const track of doc.tracks) {
        for (const clip of track.clips) {
            if (clip.type === "audio" && clip.audio?.sourceUrl && !clip.audio.buffer) {
                todo.push({
                    trackId: track.id,
                    clipId: clip.id,
                    sourceUrl: clip.audio.sourceUrl,
                    name: clip.audio.name || clip.name,
                });
            }
        }
    }
    if (todo.length === 0) return;
    void Promise.all(todo.map(async ({ trackId, clipId, sourceUrl, name }) => {
        try {
            const buffer = await engine.loadAudioBuffer(sourceUrl);
            const peaks = engine.computeWaveformPeaks(buffer);
            setState(prev => ({
                ...prev,
                project: {
                    ...prev.project,
                    tracks: prev.project.tracks.map(t => t.id !== trackId ? t : {
                        ...t,
                        clips: t.clips.map(c => c.id !== clipId ? c : {
                            ...c,
                            audio: {
                                ...c.audio!,
                                buffer,
                                waveformPeaks: peaks,
                                duration: buffer.duration,
                                name,
                            },
                            length: engine.secondsToBeats(buffer.duration, prev.project.tempo),
                        }),
                    }),
                },
            }));
        } catch {
            // Clip stays empty; user can re-import manually.
        }
    }));
}

export function DAWProvider({ children }: { children: ReactNode }) {
    useRenderCount("DAWProvider");
    const engineRef = useRef<DAWEngine | null>(null);
    const meterRAF = useRef<number>(0);
    // Always start with default project for SSR hydration consistency.
    // Saved project is loaded in the engine-init useEffect below.
    // UI state is restored from localStorage after hydration to avoid hydration mismatch.
    const [state, setState] = useState<DAWState>(() => ({
        project: createDefaultProject(),
        isPlaying: false,
        isRecording: false,
        currentBeat: 0,
        playbackMode: "song",
        currentStepIndex: -1,
        activeClipIds: [],
        tool: "select",
        snap: "1/4",
        metronomeOn: false,
        metronomeVolume: 0.5,
        zoom: 40,
        scrollX: 0,
        scrollY: 0,
        selectedTrackId: null,
        selectedClipId: null,
        selectedNotes: new Set(),
        clipboard: loadClipboard(),
        history: createHistory(createDefaultProject(), "New Project", 100),
        showPianoRoll: false,
        showMixer: true,
        showStepSequencer: false,
        showBrowser: false,
        showEffectsRack: false,
        showSynth: false,
        showAutomation: false,
        showHistory: false,
        showClipboard: false,
        showVoiceProcessor: false,
        pianoRollTrackId: null,
        pianoRollClipId: null,
        synthConfig: DEFAULT_SYNTH_CONFIG,
        stepPattern: createDefaultStepPattern(),
        masterPeakL: 0,
        masterPeakR: 0,
        browserTab: "files",
        projectList: [],
        showProjectModal: false,
        showSettingsModal: false,
        showExportModal: false,
        isDirty: false,
        focusMode: true,
    }));

    // Cloud autosave write-through. localStorage `saveProject` keeps a
    // local cache for instant boot; this hook fans the same edits out to
    // the cloud (debounced 800ms) and queues them in IndexedDB when
    // offline. The hook is a no-op when there is no signed-in session;
    // it never throws and never blocks UI updates.
    useProjectAutosave({
        kind: "daw",
        externalId: state.project.id,
        name: state.project.name,
        document: state.project as unknown as Record<string, unknown>,
        extras: {
            bpm: state.project.tempo,
        },
    });

    // Restore persisted UI state after hydration (client-only)
    useEffect(() => {
        const savedUI = loadUIState();
        if (Object.keys(savedUI).length > 0) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only localStorage hydration after SSR
            setState(prev => ({
                ...prev,
                tool: (savedUI.tool as DAWState["tool"]) || prev.tool,
                snap: (savedUI.snap as DAWState["snap"]) || prev.snap,
                metronomeOn: savedUI.metronomeOn ?? prev.metronomeOn,
                metronomeVolume: savedUI.metronomeVolume ?? prev.metronomeVolume,
                zoom: savedUI.zoom ?? prev.zoom,
                showPianoRoll: savedUI.showPianoRoll ?? prev.showPianoRoll,
                showMixer: savedUI.showMixer ?? prev.showMixer,
                showStepSequencer: savedUI.showStepSequencer ?? prev.showStepSequencer,
                showBrowser: savedUI.showBrowser ?? prev.showBrowser,
                showEffectsRack: savedUI.showEffectsRack ?? prev.showEffectsRack,
                showSynth: savedUI.showSynth ?? prev.showSynth,
                showAutomation: savedUI.showAutomation ?? prev.showAutomation,
                focusMode: savedUI.focusMode ?? prev.focusMode,
                browserTab: (savedUI.browserTab as DAWState["browserTab"]) || prev.browserTab,
            }));
        }
    }, []);

    // Persist UI state on relevant changes
    const uiStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current);
        uiStateTimerRef.current = setTimeout(() => saveUIState(state), 300);
        return () => { if (uiStateTimerRef.current) clearTimeout(uiStateTimerRef.current); };
    }, [
        state.tool, state.snap, state.zoom, state.metronomeOn, state.metronomeVolume,
        state.showPianoRoll, state.showMixer, state.showStepSequencer, state.showBrowser,
        state.showEffectsRack, state.showSynth, state.showAutomation, state.focusMode,
        state.browserTab,
    ]);

    // Initialize engine
    useEffect(() => {
        const engine = new DAWEngine();
        engineRef.current = engine;

        engine.onBeatUpdate = (beat) => {
            setState(prev => {
                // Compute active clip IDs (clips the playhead is currently inside)
                const activeClips: string[] = [];
                for (const track of prev.project.tracks) {
                    if (track.muted) continue;
                    for (const clip of track.clips) {
                        if (clip.muted) continue;
                        if (beat >= clip.position && beat < clip.position + clip.length) {
                            activeClips.push(clip.id);
                        }
                    }
                }
                return { ...prev, currentBeat: beat, activeClipIds: activeClips };
            });
        };

        engine.onStepUpdate = (step) => {
            setState(prev => ({ ...prev, currentStepIndex: step }));
        };

        engine.onPlaybackEnd = () => {
            setState(prev => ({ ...prev, isPlaying: false, currentBeat: 0, activeClipIds: [], currentStepIndex: -1 }));
        };

        // Wire up recording callback — creates an audio clip from the recorded buffer
        engine.onRecordingData = (trackId: string, buffer: AudioBuffer) => {
            setState(prev => {
                const track = prev.project.tracks.find(t => t.id === trackId);
                if (!track) return prev;

                const startBeat = engine.getRecordingStartBeat();
                const lengthBeats = engine.secondsToBeats(buffer.duration, prev.project.tempo);
                const peaks = engine.computeWaveformPeaks(buffer);
                const clipId = createId();
                const clip = createClip("audio", trackId, startBeat, lengthBeats, `Recording ${new Date().toLocaleTimeString()}`);
                clip.id = clipId;
                clip.audio = {
                    buffer,
                    waveformPeaks: peaks,
                    duration: buffer.duration,
                    sampleRate: buffer.sampleRate,
                    channels: buffer.numberOfChannels,
                    name: clip.name,
                    sourceUrl: "",
                    startOffset: 0,
                    gain: 1,
                    fadeIn: 0,
                    fadeOut: 0,
                    pitchShift: 0,
                    timeStretch: 1,
                    reversed: false,
                };

                return {
                    ...prev,
                    project: {
                        ...prev.project,
                        tracks: prev.project.tracks.map(t =>
                            t.id !== trackId ? t : { ...t, clips: [...t.clips, clip] }
                        ),
                    },
                };
            });
        };

        // Wire up MIDI recording callback — creates a MIDI clip from recorded notes
        engine.onMidiRecordingData = (trackId: string, notes: MidiNote[]) => {
            setState(prev => {
                const track = prev.project.tracks.find(t => t.id === trackId);
                if (!track || notes.length === 0) return prev;

                const startBeat = engine.getRecordingStartBeat();
                const maxEnd = Math.max(...notes.map(n => n.start + n.duration));
                const lengthBeats = Math.max(4, Math.ceil(maxEnd / 4) * 4); // round up to 4-beat bars
                const clipId = createId();
                const clip = createClip("midi", trackId, startBeat, lengthBeats, `MIDI Recording ${new Date().toLocaleTimeString()}`);
                clip.id = clipId;
                clip.midi = {
                    notes,
                    instrumentId: track.instrumentId || "synth",
                };

                return {
                    ...prev,
                    project: {
                        ...prev.project,
                        tracks: prev.project.tracks.map(t =>
                            t.id !== trackId ? t : { ...t, clips: [...t.clips, clip] }
                        ),
                    },
                };
            });
        };

        // Load saved project from localStorage (client-only, after hydration).
        // If the URL specifies a project that isn't in local cache, keep the URL
        // as-is so the server-hydration effect below can fetch it; otherwise
        // align the URL to whatever we loaded.
        const saved = loadInitialProject();
        const urlParams = new URLSearchParams(window.location.search);
        const urlProjectId = urlParams.get("project");
        // eslint-disable-next-line react-hooks/set-state-in-effect -- engine initialization with persisted project
        setState(prev => ({ ...prev, project: saved }));
        if (!urlProjectId || urlProjectId === saved.id) {
            updateProjectUrl(saved.id);
        }

        // Create channels for initial tracks
        for (const track of saved.tracks) {
            engine.createChannel(track.id, track.type);
        }
        engine.createChannel(saved.masterTrack.id, "master");

        // Reload audio buffers for clips that have sourceUrl but lost buffer on save
        hydrateClipAudioBuffers(engine, saved, setState);

        return () => {
            cancelAnimationFrame(meterRAF.current);
            engine.destroy();
            engineRef.current = null;
        };

    }, []);

    // Server-side project hydration: if the URL has ?project=<id> but our
    // local cache didn't have it (e.g. project was created on another device,
    // or written by Maestro), fetch the JSON document from the server and
    // hot-swap it into state. Runs once after mount.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const urlProjectId = params.get("project");
        if (!urlProjectId) return;
        let cancelled = false;
        (async () => {
            try {
                const server = await fetchProjectFromServer("daw", urlProjectId);
                if (cancelled || !server) return;
                const doc = server.document as unknown as DAWProject;
                if (!doc || !Array.isArray(doc.tracks)) return;
                setState(prev => {
                    // If state already shows this exact project from localStorage, keep it.
                    if (prev.project.id === doc.id && prev.project.tracks.length > 0) return prev;
                    const engine = engineRef.current;
                    if (engine) {
                        prev.project.tracks.forEach(t => engine.removeChannel(t.id));
                        doc.tracks.forEach(t => engine.createChannel(t.id, t.type));
                        if (doc.masterTrack) engine.createChannel(doc.masterTrack.id, "master");
                    }
                    return {
                        ...prev,
                        project: doc,
                        isPlaying: false,
                        isRecording: false,
                        currentBeat: 0,
                        selectedTrackId: null,
                        selectedClipId: null,
                        history: createHistory(doc, "Loaded from cloud"),
                        isDirty: false,
                    };
                });
                updateProjectUrl(doc.id);
                // Decode any clip audio that arrived from the server.
                const engine = engineRef.current;
                if (engine) hydrateClipAudioBuffers(engine, doc, setState);
                // Also persist to localStorage so subsequent reloads are instant
                try { saveProject(doc); } catch { /* ignore */ }
            } catch {
                // Server unreachable or unauthenticated — keep local state
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Periodic poll for external updates (e.g. Maestro edits while the UI is open).
    // Compares server's `updatedAt` against our last applied timestamp; if newer
    // AND we are not in the middle of typing locally (no dirty state), hot-swap.
    // 4 s interval keeps it cheap.
    const lastAppliedAtRef = useRef<string | null>(null);
    useEffect(() => {
        if (typeof window === "undefined") return;
        const interval = window.setInterval(async () => {
            try {
                const externalId = state.project.id;
                if (!externalId) return;
                if (state.isDirty) return; // don't trash unsaved local edits
                const server = await fetchProjectFromServer("daw", externalId);
                if (!server) return;
                const serverAt = server.updatedAt ?? "";
                if (!serverAt) return;
                if (lastAppliedAtRef.current === serverAt) return;
                // First observation: just record, don't reload.
                if (lastAppliedAtRef.current === null) {
                    lastAppliedAtRef.current = serverAt;
                    return;
                }
                const doc = server.document as unknown as DAWProject;
                if (!doc || !Array.isArray(doc.tracks)) return;
                // Only swap if the doc actually differs from what we have.
                const stale = JSON.stringify({ t: state.project.tempo, c: state.project.tracks.length, n: state.project.tracks.reduce((acc, t) => acc + t.clips.length, 0) })
                    !== JSON.stringify({ t: doc.tempo, c: doc.tracks.length, n: doc.tracks.reduce((acc: number, t: { clips: unknown[] }) => acc + (t.clips?.length ?? 0), 0) });
                if (!stale) {
                    lastAppliedAtRef.current = serverAt;
                    return;
                }
                lastAppliedAtRef.current = serverAt;
                setState(prev => {
                    if (prev.isDirty) return prev;
                    const engine = engineRef.current;
                    if (engine) {
                        prev.project.tracks.forEach(t => engine.removeChannel(t.id));
                        doc.tracks.forEach(t => engine.createChannel(t.id, t.type));
                        if (doc.masterTrack) engine.createChannel(doc.masterTrack.id, "master");
                    }
                    return {
                        ...prev,
                        project: doc,
                        history: createHistory(doc, "Refreshed from cloud"),
                        isDirty: false,
                    };
                });
                const engine = engineRef.current;
                if (engine) hydrateClipAudioBuffers(engine, doc, setState);
                try { saveProject(doc); } catch { /* ignore */ }
            } catch { /* ignore poll errors */ }
        }, 4000);
        return () => window.clearInterval(interval);
    }, [state.project.id, state.isDirty, state.project.tempo, state.project.tracks]);

    // Mirror current project id into URL on every change so the link is always
    // shareable (covers hot-swap from cloud poll, autosave-created ids, etc.).
    useEffect(() => {
        if (!state.project.id) return;
        updateProjectUrl(state.project.id);
    }, [state.project.id]);

    // Sync step pattern and playback mode to engine
    useEffect(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.setStepPattern(state.stepPattern);
        engine.setPlaybackMode(state.playbackMode);
    }, [state.stepPattern, state.playbackMode]);

    // Metering loop
    useEffect(() => {
        const updateMeters = () => {
            const engine = engineRef.current;
            if (engine && state.isPlaying) {
                const master = engine.getMasterPeaks();
                setState(prev => ({
                    ...prev,
                    masterPeakL: master.left,
                    masterPeakR: master.right,
                }));
            }
            meterRAF.current = requestAnimationFrame(updateMeters);
        };
        meterRAF.current = requestAnimationFrame(updateMeters);
        return () => cancelAnimationFrame(meterRAF.current);
    }, [state.isPlaying]);

    // Push named entry to history before mutating project
    const pushUndoNamed = useCallback((label: string, icon?: string) => {
        setState(prev => ({
            ...prev,
            history: pushHistory(prev.history, prev.project, label, icon),
            isDirty: true,
        }));
    }, []);

    const updateProject = useCallback((updater: (project: DAWProject) => DAWProject) => {
        setState(prev => {
            const updated = updater(prev.project);
            return { ...prev, project: { ...updated, modifiedAt: Date.now() }, isDirty: true };
        });
    }, []);

    const updateTrack = useCallback((trackId: string, updater: (track: DAWTrack) => DAWTrack) => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => t.id === trackId ? updater(t) : t),
        }));
    }, [updateProject]);

    // Forward-declared so the lower-half action setters can call into
    // automation recording without violating the useCallback order rules.
    // The actual implementation is defined far below alongside the rest
    // of the automation API; assigned via the ref-update useEffect just
    // after. Calls before assignment are no-ops, which is what we want
    // during the first render anyway.
    const recordParamLanesRef = useRef<(trackId: string, parameter: string, value: number) => void>(() => {});
    const recordParamLanes = useCallback((trackId: string, parameter: string, value: number) => {
        recordParamLanesRef.current(trackId, parameter, value);
    }, []);

    const findClip = useCallback((clipId: string): { track: DAWTrack; clip: Clip } | null => {
        for (const track of state.project.tracks) {
            const clip = track.clips.find(c => c.id === clipId);
            if (clip) return { track, clip };
        }
        return null;
    }, [state.project.tracks]);

    // ─── Transport ───────────────────────────────────────────────────────

    const play = useCallback(() => {
        const engine = engineRef.current;
        if (!engine) return;
        engine.ensureRunning();
        engine.play(state.project, state.currentBeat);
        setState(prev => ({ ...prev, isPlaying: true }));
    }, [state.project, state.currentBeat]);

    const stop = useCallback(() => {
        const engine = engineRef.current;
        if (engine) {
            if (state.isRecording) {
                engine.stopRecording();
            }
            engine.stop();
        }
        setState(prev => ({ ...prev, isPlaying: false, isRecording: false, currentBeat: 0, activeClipIds: [], currentStepIndex: -1 }));
    }, [state.isRecording]);

    const pause = useCallback(() => {
        engineRef.current?.pause();
        setState(prev => ({ ...prev, isPlaying: false, activeClipIds: [] }));
    }, []);

    const togglePlay = useCallback(() => {
        if (state.isPlaying) pause(); else play();
    }, [state.isPlaying, pause, play]);

    const record = useCallback(async () => {
        const engine = engineRef.current;
        if (!engine) return;

        // If already recording, stop recording
        if (state.isRecording) {
            engine.stopRecording();
            engine.pause();
            setState(prev => ({ ...prev, isPlaying: false, isRecording: false }));
            return;
        }

        // Find an armed track to record into
        if (!state.selectedTrackId) return;
        const track = state.project.tracks.find(t => t.id === state.selectedTrackId && t.armed);
        if (!track) return;

        engine.ensureRunning();

        if (track.type === "midi") {
            // MIDI recording: capture incoming MIDI notes into a clip
            engine.startMidiRecording(track.id, state.currentBeat);
            engine.play(state.project, state.currentBeat);
            setState(prev => ({ ...prev, isPlaying: true, isRecording: true }));
        } else {
            // Audio recording: capture from input device through channel FX
            const settings = getDAWSettings();
            const deviceId = settings.audioInputDeviceId;
            const success = await engine.startRecording(track.id, deviceId, state.currentBeat);
            if (success) {
                engine.play(state.project, state.currentBeat);
                setState(prev => ({ ...prev, isPlaying: true, isRecording: true }));
            }
        }
    }, [state.selectedTrackId, state.project, state.currentBeat, state.isRecording]);

    const seek = useCallback((beat: number) => {
        const clamped = Math.max(0, beat);
        engineRef.current?.seek(clamped);
        setState(prev => ({ ...prev, currentBeat: clamped }));
    }, []);

    const setTempo = useCallback((bpm: number) => {
        pushUndoNamed(`Set Tempo to ${bpm} BPM`, "Gauge");
        updateProject(p => ({ ...p, tempo: Math.max(20, Math.min(999, bpm)) }));
    }, [pushUndoNamed, updateProject]);

    const setTimeSignature = useCallback((num: number, den: number) => {
        pushUndoNamed(`Set Time Signature ${num}/${den}`, "Clock");
        updateProject(p => ({ ...p, timeSignature: { numerator: num, denominator: den } }));
    }, [pushUndoNamed, updateProject]);

    const toggleMetronome = useCallback(() => {
        setState(prev => {
            const newOn = !prev.metronomeOn;
            engineRef.current?.setMetronomeVolume(newOn ? prev.metronomeVolume : 0);
            return { ...prev, metronomeOn: newOn };
        });
    }, []);

    const setMetronomeVolume = useCallback((vol: number) => {
        engineRef.current?.setMetronomeVolume(vol);
        setState(prev => ({ ...prev, metronomeVolume: vol }));
    }, []);

    const toggleLoop = useCallback(() => {
        updateProject(p => ({
            ...p,
            loopRegion: { ...p.loopRegion, enabled: !p.loopRegion.enabled },
        }));
    }, [updateProject]);

    const setLoopRegion = useCallback((start: number, end: number) => {
        updateProject(p => ({
            ...p,
            loopRegion: { ...p.loopRegion, start, end },
        }));
    }, [updateProject]);

    const setPlaybackMode = useCallback((mode: "pattern" | "song") => {
        engineRef.current?.setPlaybackMode(mode);
        setState(prev => ({ ...prev, playbackMode: mode }));
    }, []);

    const togglePlaybackMode = useCallback(() => {
        setState(prev => {
            const next = prev.playbackMode === "pattern" ? "song" : "pattern";
            engineRef.current?.setPlaybackMode(next);
            return { ...prev, playbackMode: next };
        });
    }, []);

    // ─── Tools ───────────────────────────────────────────────────────────

    const setTool = useCallback((tool: ToolMode) => {
        setState(prev => ({ ...prev, tool }));
    }, []);

    const setSnap = useCallback((snap: SnapValue) => {
        setState(prev => ({ ...prev, snap }));
    }, []);

    const setZoom = useCallback((zoom: number) => {
        setState(prev => ({ ...prev, zoom: Math.max(10, Math.min(200, zoom)) }));
    }, []);

    const setScroll = useCallback((x: number, y: number) => {
        setState(prev => ({ ...prev, scrollX: Math.max(0, x), scrollY: Math.max(0, y) }));
    }, []);

    // ─── Track Management ────────────────────────────────────────────────

    const addTrack = useCallback((type: TrackType) => {
        const names: Record<TrackType, string> = { audio: "Audio", midi: "MIDI", return: "Return", master: "Master" };
        const count = state.project.tracks.filter(t => t.type === type).length + 1;
        pushUndoNamed(`Add ${names[type]} Track ${count}`, "Plus");
        const track = createDefaultTrack(type, `${names[type]} ${count}`);
        if (type === "midi") track.instrumentId = "synth";
        engineRef.current?.createChannel(track.id, type);
        updateProject(p => ({ ...p, tracks: [...p.tracks, track] }));
    }, [pushUndoNamed, state.project.tracks, updateProject]);

    const removeTrack = useCallback((id: string) => {
        const track = state.project.tracks.find(t => t.id === id);
        pushUndoNamed(`Delete Track "${track?.name || id}"`, "Trash2");
        engineRef.current?.removeChannel(id);
        updateProject(p => ({ ...p, tracks: p.tracks.filter(t => t.id !== id) }));
    }, [pushUndoNamed, state.project.tracks, updateProject]);

    const renameTrack = useCallback((id: string, name: string) => {
        updateTrack(id, t => ({ ...t, name }));
    }, [updateTrack]);

    const setTrackVolume = useCallback((id: string, vol: number) => {
        engineRef.current?.getChannel(id)?.setVolume(vol);
        updateTrack(id, t => ({ ...t, volume: vol }));
        recordParamLanes(id, "volume", vol);
    }, [updateTrack, recordParamLanes]);

    const setTrackPan = useCallback((id: string, pan: number) => {
        engineRef.current?.getChannel(id)?.setPan(pan);
        updateTrack(id, t => ({ ...t, pan }));
        recordParamLanes(id, "pan", pan);
    }, [updateTrack, recordParamLanes]);

    const toggleTrackMute = useCallback((id: string) => {
        updateTrack(id, t => {
            const muted = !t.muted;
            engineRef.current?.getChannel(id)?.setMuted(muted);
            return { ...t, muted };
        });
    }, [updateTrack]);

    const toggleTrackSolo = useCallback((id: string) => {
        updateTrack(id, t => ({ ...t, soloed: !t.soloed }));
    }, [updateTrack]);

    const toggleTrackArm = useCallback((id: string) => {
        updateTrack(id, t => ({ ...t, armed: !t.armed }));
    }, [updateTrack]);

    const setTrackColor = useCallback((id: string, color: string) => {
        updateTrack(id, t => ({ ...t, color }));
    }, [updateTrack]);

    const setTrackHeight = useCallback((id: string, height: number) => {
        updateTrack(id, t => ({ ...t, height: Math.max(40, Math.min(300, height)) }));
    }, [updateTrack]);

    const reorderTrack = useCallback((id: string, newIndex: number) => {
        pushUndoNamed("Reorder Track", "ArrowUpDown");
        updateProject(p => {
            const tracks = [...p.tracks];
            const oldIdx = tracks.findIndex(t => t.id === id);
            if (oldIdx < 0) return p;
            const [moved] = tracks.splice(oldIdx, 1);
            tracks.splice(newIndex, 0, moved);
            return { ...p, tracks };
        });
    }, [pushUndoNamed, updateProject]);

    const selectTrack = useCallback((id: string | null) => {
        setState(prev => ({ ...prev, selectedTrackId: id }));
    }, []);

    const duplicateTrack = useCallback((id: string) => {
        const source = state.project.tracks.find(t => t.id === id);
        if (!source) return;
        pushUndoNamed(`Duplicate Track "${source.name}"`, "Copy");
        const newTrack: DAWTrack = {
            ...source,
            id: createId(),
            name: `${source.name} (Copy)`,
            clips: source.clips.map(c => ({ ...c, id: createId(), trackId: createId() })),
        };
        newTrack.clips.forEach(c => { c.trackId = newTrack.id; });
        engineRef.current?.createChannel(newTrack.id, newTrack.type);
        updateProject(p => ({
            ...p,
            tracks: [...p.tracks.slice(0, p.tracks.findIndex(t => t.id === id) + 1), newTrack, ...p.tracks.slice(p.tracks.findIndex(t => t.id === id) + 1)],
        }));
    }, [pushUndoNamed, state.project.tracks, updateProject]);

    const freezeTrack = useCallback((id: string) => {
        updateTrack(id, t => ({ ...t, frozen: !t.frozen }));
    }, [updateTrack]);

    // ─── Clip Management ─────────────────────────────────────────────────

    const addClip = useCallback((trackId: string, type: ClipType, position: number, length: number, name?: string): Clip => {
        pushUndoNamed(`Add ${type} Clip`, "Plus");
        const clip = createClip(type, trackId, position, length, name || `Clip ${Date.now()}`);
        updateTrack(trackId, t => ({ ...t, clips: [...t.clips, clip] }));
        return clip;
    }, [pushUndoNamed, updateTrack]);

    const removeClip = useCallback((clipId: string) => {
        const found = findClip(clipId);
        pushUndoNamed(`Delete Clip "${found?.clip.name || clipId}"`, "Trash2");
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                clips: t.clips.filter(c => c.id !== clipId),
            })),
        }));
    }, [pushUndoNamed, findClip, updateProject]);

    const moveClip = useCallback((clipId: string, newTrackId: string, newPosition: number) => {
        pushUndoNamed("Move Clip", "Move");
        updateProject(p => {
            let movedClip: Clip | null = null;
            const tracks = p.tracks.map(t => ({
                ...t,
                clips: t.clips.filter(c => {
                    if (c.id === clipId) { movedClip = { ...c, trackId: newTrackId, position: Math.max(0, newPosition) }; return false; }
                    return true;
                }),
            }));
            if (movedClip) {
                return { ...p, tracks: tracks.map(t => t.id === newTrackId ? { ...t, clips: [...t.clips, movedClip!] } : t) };
            }
            return { ...p, tracks };
        });
    }, [pushUndoNamed, updateProject]);

    const resizeClip = useCallback((clipId: string, newLength: number) => {
        const found = findClip(clipId);
        if (!found) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, length: Math.max(0.25, newLength) } : c),
        }));
    }, [findClip, updateTrack]);

    const splitClip = useCallback((clipId: string, position: number) => {
        pushUndoNamed("Split Clip", "Scissors");
        const found = findClip(clipId);
        if (!found) return;
        const { track, clip } = found;
        const relPos = position - clip.position;
        if (relPos <= 0 || relPos >= clip.length) return;

        const clip1: Clip = { ...clip, length: relPos };
        const clip2: Clip = {
            ...clip,
            id: createId(),
            position: clip.position + relPos,
            length: clip.length - relPos,
            name: `${clip.name} (split)`,
        };
        if (clip2.midi) {
            clip2.midi = {
                ...clip2.midi,
                notes: clip.midi!.notes.filter(n => n.start >= relPos).map(n => ({ ...n, start: n.start - relPos })),
            };
            clip1.midi = {
                ...clip1.midi!,
                notes: clip.midi!.notes.filter(n => n.start < relPos),
            };
        }
        updateTrack(track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? clip1 : c).concat(clip2),
        }));
    }, [pushUndoNamed, findClip, updateTrack]);

    const duplicateClip = useCallback((clipId: string) => {
        const found = findClip(clipId);
        if (!found) return;
        pushUndoNamed(`Duplicate Clip "${found.clip.name}"`, "Copy");
        const newClip: Clip = {
            ...found.clip,
            id: createId(),
            position: found.clip.position + found.clip.length,
            name: `${found.clip.name} (copy)`,
        };
        updateTrack(found.track.id, t => ({ ...t, clips: [...t.clips, newClip] }));
    }, [pushUndoNamed, findClip, updateTrack]);

    const muteClip = useCallback((clipId: string) => {
        const found = findClip(clipId);
        if (!found) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, muted: !c.muted } : c),
        }));
    }, [findClip, updateTrack]);

    const setClipColor = useCallback((clipId: string, color: string) => {
        const found = findClip(clipId);
        if (!found) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, color } : c),
        }));
    }, [findClip, updateTrack]);

    const selectClip = useCallback((clipId: string | null) => {
        setState(prev => ({ ...prev, selectedClipId: clipId }));
    }, []);

    const loadAudioIntoClip = useCallback(async (clipId: string, url: string, name?: string) => {
        const engine = engineRef.current;
        if (!engine) return;
        const buffer = await engine.loadAudioBuffer(url);
        const peaks = engine.computeWaveformPeaks(buffer);
        setState(prev => {
            const tempo = prev.project.tempo;
            return {
                ...prev,
                project: {
                    ...prev.project,
                    tracks: prev.project.tracks.map(t => {
                        const hasClip = t.clips.some(c => c.id === clipId);
                        if (!hasClip) return t;
                        return {
                            ...t,
                            clips: t.clips.map(c => c.id !== clipId || !c.audio ? c : {
                                ...c,
                                audio: {
                                    ...c.audio,
                                    buffer,
                                    sourceUrl: url,
                                    name: name || url.split("/").pop() || "Audio",
                                    duration: buffer.duration,
                                    waveformPeaks: peaks,
                                },
                                length: engine.secondsToBeats(buffer.duration, tempo),
                            }),
                        };
                    }),
                },
                isDirty: true,
            };
        });
    }, []);

    const loadFileIntoClip = useCallback(async (clipId: string, file: File) => {
        const engine = engineRef.current;
        if (!engine) return;
        const buffer = await engine.loadAudioFile(file);
        const peaks = engine.computeWaveformPeaks(buffer);
        const url = URL.createObjectURL(file);
        setState(prev => {
            const tempo = prev.project.tempo;
            return {
                ...prev,
                project: {
                    ...prev.project,
                    tracks: prev.project.tracks.map(t => {
                        const hasClip = t.clips.some(c => c.id === clipId);
                        if (!hasClip) return t;
                        return {
                            ...t,
                            clips: t.clips.map(c => c.id !== clipId || !c.audio ? c : {
                                ...c,
                                name: file.name,
                                audio: {
                                    ...c.audio,
                                    buffer,
                                    sourceUrl: url,
                                    name: file.name,
                                    duration: buffer.duration,
                                    waveformPeaks: peaks,
                                },
                                length: engine.secondsToBeats(buffer.duration, tempo),
                            }),
                        };
                    }),
                },
                isDirty: true,
            };
        });
    }, []);

    // ─── Audio Clip Editing ──────────────────────────────────────────────

    const setClipGain = useCallback((clipId: string, gain: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, gain } } : c),
        }));
    }, [findClip, updateTrack]);

    const setClipFade = useCallback((clipId: string, fadeIn: number, fadeOut: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, fadeIn, fadeOut } } : c),
        }));
    }, [findClip, updateTrack]);

    const reverseClip = useCallback((clipId: string) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, reversed: !c.audio!.reversed } } : c),
        }));
    }, [findClip, updateTrack]);

    const setClipPitch = useCallback((clipId: string, semitones: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, pitchShift: semitones } } : c),
        }));
    }, [findClip, updateTrack]);

    const setClipTimeStretch = useCallback((clipId: string, ratio: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, timeStretch: ratio } } : c),
        }));
    }, [findClip, updateTrack]);

    const normalizeClip = useCallback((clipId: string) => {
        const found = findClip(clipId);
        if (!found?.clip.audio?.buffer) return;
        const data = found.clip.audio.buffer.getChannelData(0);
        let max = 0;
        for (let i = 0; i < data.length; i++) {
            const abs = Math.abs(data[i]);
            if (abs > max) max = abs;
        }
        if (max > 0) {
            const normalizeGain = 1 / max;
            updateTrack(found.track.id, t => ({
                ...t,
                clips: t.clips.map(c => c.id === clipId ? { ...c, audio: { ...c.audio!, gain: normalizeGain } } : c),
            }));
        }
    }, [findClip, updateTrack]);

    // ─── Piano Roll / MIDI ───────────────────────────────────────────────

    const addNote = useCallback((clipId: string, note: Omit<MidiNote, "id">) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        const newNote: MidiNote = { ...note, id: createId() };
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? {
                ...c,
                midi: { ...c.midi!, notes: [...c.midi!.notes, newNote] },
            } : c),
        }));
    }, [findClip, updateTrack]);

    const removeNote = useCallback((clipId: string, noteId: string) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? {
                ...c,
                midi: { ...c.midi!, notes: c.midi!.notes.filter(n => n.id !== noteId) },
            } : c),
        }));
    }, [findClip, updateTrack]);

    const moveNote = useCallback((clipId: string, noteId: string, pitch: number, start: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? {
                ...c,
                midi: {
                    ...c.midi!,
                    notes: c.midi!.notes.map(n => n.id === noteId ? { ...n, pitch: Math.max(0, Math.min(127, pitch)), start: Math.max(0, start) } : n),
                },
            } : c),
        }));
    }, [findClip, updateTrack]);

    const resizeNote = useCallback((clipId: string, noteId: string, duration: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? {
                ...c,
                midi: {
                    ...c.midi!,
                    notes: c.midi!.notes.map(n => n.id === noteId ? { ...n, duration: Math.max(0.0625, duration) } : n),
                },
            } : c),
        }));
    }, [findClip, updateTrack]);

    const setNoteVelocity = useCallback((clipId: string, noteId: string, velocity: number) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c => c.id === clipId ? {
                ...c,
                midi: {
                    ...c.midi!,
                    notes: c.midi!.notes.map(n => n.id === noteId ? { ...n, velocity: Math.max(1, Math.min(127, velocity)) } : n),
                },
            } : c),
        }));
    }, [findClip, updateTrack]);

    const selectNotes = useCallback((noteIds: string[]) => {
        setState(prev => ({ ...prev, selectedNotes: new Set(noteIds) }));
    }, []);

    const clearSelection = useCallback(() => {
        setState(prev => ({ ...prev, selectedNotes: new Set(), selectedClipId: null }));
    }, []);

    const openPianoRoll = useCallback((trackId: string, clipId: string) => {
        setState(prev => ({ ...prev, showPianoRoll: true, pianoRollTrackId: trackId, pianoRollClipId: clipId }));
    }, []);

    const closePianoRoll = useCallback(() => {
        setState(prev => ({ ...prev, showPianoRoll: false, pianoRollTrackId: null, pianoRollClipId: null }));
    }, []);

    // ─── Synth ───────────────────────────────────────────────────────────

    const playSynthNote = useCallback((pitch: number, velocity: number = 100): string => {
        const engine = engineRef.current;
        if (!engine) return "";
        const trackId = state.pianoRollTrackId || state.selectedTrackId;
        if (!trackId) return "";
        return engine.playSynthNote(trackId, pitch, velocity, state.synthConfig);
    }, [state.pianoRollTrackId, state.selectedTrackId, state.synthConfig]);

    const stopSynthNote = useCallback((noteId: string) => {
        engineRef.current?.stopSynthNote(noteId, state.synthConfig);
    }, [state.synthConfig]);

    const setSynthConfig = useCallback((config: Partial<SynthConfig>) => {
        setState(prev => ({ ...prev, synthConfig: { ...prev.synthConfig, ...config } }));
    }, []);

    // ─── Step Sequencer ──────────────────────────────────────────────────

    const toggleStep = useCallback((trackIdx: number, stepIdx: number) => {
        setState(prev => {
            const pattern = { ...prev.stepPattern };
            const tracks = [...pattern.tracks];
            tracks[trackIdx] = { ...tracks[trackIdx], steps: [...tracks[trackIdx].steps] };
            tracks[trackIdx].steps[stepIdx] = {
                ...tracks[trackIdx].steps[stepIdx],
                active: !tracks[trackIdx].steps[stepIdx].active,
            };
            return { ...prev, stepPattern: { ...pattern, tracks } };
        });
    }, []);

    const setStepVelocity = useCallback((trackIdx: number, stepIdx: number, velocity: number) => {
        setState(prev => {
            const pattern = { ...prev.stepPattern };
            const tracks = [...pattern.tracks];
            tracks[trackIdx] = { ...tracks[trackIdx], steps: [...tracks[trackIdx].steps] };
            tracks[trackIdx].steps[stepIdx] = { ...tracks[trackIdx].steps[stepIdx], velocity };
            return { ...prev, stepPattern: { ...pattern, tracks } };
        });
    }, []);

    const setPatternSteps = useCallback((steps: number) => {
        setState(prev => {
            const pattern = { ...prev.stepPattern, steps };
            pattern.tracks = pattern.tracks.map(t => ({
                ...t,
                steps: Array.from({ length: steps }, (_, i) =>
                    i < t.steps.length ? t.steps[i] : { active: false, velocity: 100, accent: false }
                ),
            }));
            return { ...prev, stepPattern: pattern };
        });
    }, []);

    const setPatternSwing = useCallback((swing: number) => {
        setState(prev => ({ ...prev, stepPattern: { ...prev.stepPattern, swing } }));
    }, []);

    const clearPattern = useCallback(() => {
        setState(prev => ({
            ...prev,
            stepPattern: {
                ...prev.stepPattern,
                tracks: prev.stepPattern.tracks.map(t => ({
                    ...t,
                    steps: t.steps.map(() => ({ active: false, velocity: 100, accent: false })),
                })),
            },
        }));
    }, []);

    // ─── Effects ─────────────────────────────────────────────────────────

    const addInsert = useCallback((trackId: string, type: EffectType) => {
        pushUndoNamed(`Add Effect: ${type}`, "Plug");
        const insert: InsertEffect = {
            id: createId(),
            type,
            enabled: true,
            params: { ...DEFAULT_EFFECT_PARAMS[type] },
        };
        updateTrack(trackId, t => ({ ...t, inserts: [...t.inserts, insert] }));
    }, [pushUndoNamed, updateTrack]);

    const removeInsert = useCallback((trackId: string, insertId: string) => {
        pushUndoNamed("Remove Effect", "Trash2");
        updateTrack(trackId, t => ({ ...t, inserts: t.inserts.filter(i => i.id !== insertId) }));
    }, [pushUndoNamed, updateTrack]);

    const toggleInsert = useCallback((trackId: string, insertId: string) => {
        updateTrack(trackId, t => ({
            ...t,
            inserts: t.inserts.map(i => i.id === insertId ? { ...i, enabled: !i.enabled } : i),
        }));
    }, [updateTrack]);

    const setInsertParam = useCallback((trackId: string, insertId: string, param: string, value: number) => {
        updateTrack(trackId, t => ({
            ...t,
            inserts: t.inserts.map(i => i.id === insertId ? { ...i, params: { ...i.params, [param]: value } } : i),
        }));
    }, [updateTrack]);

    const setSidechainSource = useCallback((trackId: string, insertId: string, sourceTrackId: string | undefined) => {
        updateTrack(trackId, t => ({
            ...t,
            inserts: t.inserts.map(i => i.id === insertId ? { ...i, sidechainSourceTrackId: sourceTrackId } : i),
        }));
    }, [updateTrack]);

    const reorderInserts = useCallback((trackId: string, fromIndex: number, toIndex: number) => {
        pushUndoNamed("Reorder Effects", "ArrowUpDown");
        updateTrack(trackId, t => {
            const inserts = [...t.inserts];
            const [moved] = inserts.splice(fromIndex, 1);
            inserts.splice(toIndex, 0, moved);
            return { ...t, inserts };
        });
    }, [pushUndoNamed, updateTrack]);

    // ─── Sends ───────────────────────────────────────────────────────────

    const addSend = useCallback((trackId: string, returnTrackId: string) => {
        pushUndoNamed("Add Send", "ArrowRight");
        const send: SendConfig = { returnTrackId, amount: 0.5, preFader: false };
        updateTrack(trackId, t => ({ ...t, sends: [...t.sends, send] }));
    }, [pushUndoNamed, updateTrack]);

    const removeSend = useCallback((trackId: string, returnTrackId: string) => {
        pushUndoNamed("Remove Send", "Trash2");
        updateTrack(trackId, t => ({ ...t, sends: t.sends.filter(s => s.returnTrackId !== returnTrackId) }));
    }, [pushUndoNamed, updateTrack]);

    const setSendAmount = useCallback((trackId: string, returnTrackId: string, amount: number) => {
        updateTrack(trackId, t => ({
            ...t,
            sends: t.sends.map(s => s.returnTrackId === returnTrackId ? { ...s, amount } : s),
        }));
        recordParamLanes(trackId, `send:${returnTrackId}`, amount);
    }, [updateTrack, recordParamLanes]);

    // ─── Automation ──────────────────────────────────────────────────────

    const addAutomationLane = useCallback((trackId: string, parameter: string) => {
        const lane: AutomationLane = {
            id: createId(),
            trackId,
            parameter,
            points: [],
            visible: true,
            color: "#8b5cf6",
            mode: "read",
        };
        updateTrack(trackId, t => ({ ...t, automationLanes: [...t.automationLanes, lane] }));
    }, [updateTrack]);

    const removeAutomationLane = useCallback((laneId: string) => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.filter(l => l.id !== laneId),
            })),
        }));
    }, [updateProject]);

    const addAutomationPoint = useCallback((laneId: string, time: number, value: number) => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.map(l =>
                    l.id === laneId ? {
                        ...l,
                        points: [...l.points, { time, value, curve: "linear" as const }].sort((a, b) => a.time - b.time),
                    } : l
                ),
            })),
        }));
    }, [updateProject]);

    const removeAutomationPoint = useCallback((laneId: string, pointIndex: number) => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.map(l =>
                    l.id === laneId ? { ...l, points: l.points.filter((_, i) => i !== pointIndex) } : l
                ),
            })),
        }));
    }, [updateProject]);

    const moveAutomationPoint = useCallback((laneId: string, pointIndex: number, time: number, value: number) => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.map(l =>
                    l.id === laneId ? {
                        ...l,
                        points: l.points.map((pt, i) => i === pointIndex ? { ...pt, time, value } : pt).sort((a, b) => a.time - b.time),
                    } : l
                ),
            })),
        }));
    }, [updateProject]);

    const toggleAutomationVisibility = useCallback(() => {
        setState(prev => ({ ...prev, showAutomation: !prev.showAutomation }));
    }, []);

    // ─── Automation modes: write / touch / latch ────────────────────────
    //
    // The engine writes envelope points captured from live user gestures
    // (knobs / faders) into the active lane while the transport is
    // playing. Modes follow standard DAW semantics:
    //   - read  : envelopes drive parameters, no recording (default).
    //   - write : recording erases any existing points in the touch
    //             window and writes the new value, every render block.
    //   - touch : recording while the gesture is held; releases revert
    //             to existing envelope on lift.
    //   - latch : recording starts on first touch, keeps writing the
    //             last-held value until transport stops.
    //
    // The actual point write lives in `recordAutomationTouch` below; the
    // UI is expected to call it from input handlers (knob onPointerMove)
    // and `releaseAutomationTouch` from onPointerUp.
    const touchedLanesRef = useRef<Map<string, number>>(new Map());
    const setAutomationLaneMode = useCallback((laneId: string, mode: "read" | "write" | "touch" | "latch") => {
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.map(l => l.id === laneId ? { ...l, mode } : l),
            })),
        }));
    }, [updateProject]);

    const recordAutomationTouch = useCallback((laneId: string, value: number) => {
        if (!engineRef.current?.getIsPlaying()) return;
        const beat = engineRef.current.getCurrentBeat();
        touchedLanesRef.current.set(laneId, value);
        updateProject(p => ({
            ...p,
            tracks: p.tracks.map(t => ({
                ...t,
                automationLanes: t.automationLanes.map(l => {
                    if (l.id !== laneId) return l;
                    if (l.mode === "read") return l;
                    // Window around the current beat — erase old points so
                    // we don't pile up duplicates while a knob is held.
                    const W = 0.05;
                    const kept = l.points.filter((pt) => Math.abs(pt.time - beat) > W);
                    return {
                        ...l,
                        points: [...kept, { time: beat, value, curve: "linear" as const }].sort((a, b) => a.time - b.time),
                    };
                }),
            })),
        }));
    }, [updateProject]);

    const releaseAutomationTouch = useCallback((laneId: string) => {
        const last = touchedLanesRef.current.get(laneId);
        touchedLanesRef.current.delete(laneId);
        if (last == null) return;
        // For latch we'd keep writing until transport stop. The engine
        // doesn't yet run a write loop, so latch behaves like touch today;
        // the held value persists in the lane until the user changes it.
    }, []);

    // Bridge the forward-declared ref to the real implementation. Any
    // mixer/knob setter (volume/pan/send) that fires while the transport
    // is playing now writes a point into every enabled lane it matches.
    useEffect(() => {
        recordParamLanesRef.current = (trackId, parameter, value) => {
            const tracks = state.project.tracks;
            const track = tracks.find(t => t.id === trackId);
            if (!track) return;
            for (const lane of track.automationLanes ?? []) {
                if (lane.parameter !== parameter) continue;
                if (lane.mode === "read") continue;
                recordAutomationTouch(lane.id, value);
            }
        };
    }, [state.project.tracks, recordAutomationTouch]);

    // ─── Panels ──────────────────────────────────────────────────────────

    const togglePanel = useCallback((panel: "pianoRoll" | "mixer" | "stepSequencer" | "browser" | "effectsRack" | "synth" | "automation" | "history" | "clipboard" | "voiceProcessor") => {
        const key = `show${panel.charAt(0).toUpperCase() + panel.slice(1)}` as keyof DAWState;
        setState(prev => ({ ...prev, [key]: !prev[key] }));
    }, []);

    // ─── Project Management ──────────────────────────────────────────────

    const newProject = useCallback((name?: string) => {
        const project = createDefaultProject(name);
        // Create channels for new project
        const engine = engineRef.current;
        if (engine) {
            state.project.tracks.forEach(t => engine.removeChannel(t.id));
            project.tracks.forEach(t => engine.createChannel(t.id, t.type));
            engine.createChannel(project.masterTrack.id, "master");
        }
        setState(prev => ({
            ...prev,
            project,
            isPlaying: false,
            isRecording: false,
            currentBeat: 0,
            selectedTrackId: null,
            selectedClipId: null,
            history: createHistory(project, "New Project"),
            isDirty: false,
        }));
        saveProject(project);
        updateProjectUrl(project.id);
    }, [state.project.tracks]);

    const openProject = useCallback((id: string) => {
        const project = loadProject(id);
        if (!project) return;
        const engine = engineRef.current;
        if (engine) {
            state.project.tracks.forEach(t => engine.removeChannel(t.id));
            project.tracks.forEach(t => engine.createChannel(t.id, t.type));
            engine.createChannel(project.masterTrack.id, "master");

            // Reload audio buffers for clips that have sourceUrl
            for (const track of project.tracks) {
                for (const clip of track.clips) {
                    if (clip.type === "audio" && clip.audio?.sourceUrl && !clip.audio.buffer) {
                        const { sourceUrl, name } = clip.audio;
                        const trackId = track.id;
                        const clipId = clip.id;
                        engine.loadAudioBuffer(sourceUrl).then(buffer => {
                            const peaks = engine.computeWaveformPeaks(buffer);
                            setState(prev => ({
                                ...prev,
                                project: {
                                    ...prev.project,
                                    tracks: prev.project.tracks.map(t => t.id !== trackId ? t : {
                                        ...t,
                                        clips: t.clips.map(c => c.id !== clipId ? c : {
                                            ...c,
                                            audio: { ...c.audio!, buffer, waveformPeaks: peaks, duration: buffer.duration, name: name || c.name },
                                            length: engine.secondsToBeats(buffer.duration, project.tempo),
                                        }),
                                    }),
                                },
                            }));
                        }).catch(() => { /* clip stays empty */ });
                    }
                }
            }
        }
        updateProjectUrl(id);
        setState(prev => ({
            ...prev,
            project,
            isPlaying: false,
            isRecording: false,
            currentBeat: 0,
            selectedTrackId: null,
            selectedClipId: null,
            history: createHistory(project, `Opened "${project.name}"`),
            isDirty: false,
            showProjectModal: false,
        }));
    }, [state.project.tracks]);

    const saveCurrentProject = useCallback(() => {
        saveProject(state.project);
        updateProjectUrl(state.project.id);
        setState(prev => ({ ...prev, isDirty: false }));
    }, [state.project]);

    const renameProject = useCallback((name: string) => {
        updateProject(p => ({ ...p, name }));
    }, [updateProject]);

    const setProjectModal = useCallback((open: boolean) => {
        setState(prev => ({ ...prev, showProjectModal: open }));
    }, []);

    const setSettingsModal = useCallback((open: boolean) => {
        setState(prev => ({ ...prev, showSettingsModal: open }));
    }, []);

    const setExportModal = useCallback((open: boolean) => {
        setState(prev => ({ ...prev, showExportModal: open }));
    }, []);

    const toggleFocusMode = useCallback(() => {
        setState(prev => ({ ...prev, focusMode: !prev.focusMode }));
    }, []);

    const setBrowserTab = useCallback((tab: "files" | "samples" | "presets" | "plugins") => {
        setState(prev => ({ ...prev, browserTab: tab }));
    }, []);

    // ─── Undo / Redo ─────────────────────────────────────────────────────

    const undo = useCallback(() => {
        setState(prev => {
            if (!histCanUndo(prev.history)) return prev;
            const newHistory = undoHistory(prev.history);
            return {
                ...prev,
                project: getCurrentSnapshot(newHistory),
                history: newHistory,
            };
        });
    }, []);

    const redo = useCallback(() => {
        setState(prev => {
            if (!histCanRedo(prev.history)) return prev;
            const newHistory = redoHistory(prev.history);
            return {
                ...prev,
                project: getCurrentSnapshot(newHistory),
                history: newHistory,
            };
        });
    }, []);

    const jumpToHistoryEntry = useCallback((index: number) => {
        setState(prev => {
            const newHistory = jumpToHistory(prev.history, index);
            return {
                ...prev,
                project: getCurrentSnapshot(newHistory),
                history: newHistory,
            };
        });
    }, []);

    // ─── Clipboard Actions ───────────────────────────────────────────────

    const copyClips = useCallback((clipIds: string[]) => {
        const clips = clipIds.map(id => findClip(id)?.clip).filter(Boolean) as Clip[];
        if (clips.length === 0) return;
        setState(prev => ({
            ...prev,
            clipboard: addToClipboard(
                prev.clipboard,
                "daw-clips",
                clips.length === 1 ? `Clip "${clips[0].name}"` : `${clips.length} Clips`,
                `${clips.length} clip(s) from timeline`,
                clips.map(c => ({ ...c })),
                { clipCount: clips.length },
            ),
        }));
    }, [findClip]);

    const cutClips = useCallback((clipIds: string[]) => {
        copyClips(clipIds);
        for (const id of clipIds) {
            const found = findClip(id);
            if (found) {
                pushUndoNamed(`Cut Clip "${found.clip.name}"`, "Scissors");
                updateProject(p => ({
                    ...p,
                    tracks: p.tracks.map(t => ({
                        ...t,
                        clips: t.clips.filter(c => c.id !== id),
                    })),
                }));
            }
        }
    }, [copyClips, findClip, pushUndoNamed, updateProject]);

    const copyNotes = useCallback((clipId: string, noteIds: string[]) => {
        const found = findClip(clipId);
        if (!found || !found.clip.midi) return;
        const notes = found.clip.midi.notes.filter(n => noteIds.includes(n.id));
        if (notes.length === 0) return;
        setState(prev => ({
            ...prev,
            clipboard: addToClipboard(
                prev.clipboard,
                "daw-notes",
                `${notes.length} Note(s)`,
                `MIDI notes from "${found.clip.name}"`,
                notes.map(n => ({ ...n })),
                { noteCount: notes.length },
            ),
        }));
    }, [findClip]);

    const cutNotes = useCallback((clipId: string, noteIds: string[]) => {
        copyNotes(clipId, noteIds);
        pushUndoNamed("Cut Notes", "Scissors");
        const found = findClip(clipId);
        if (!found) return;
        updateTrack(found.track.id, t => ({
            ...t,
            clips: t.clips.map(c =>
                c.id === clipId && c.midi
                    ? { ...c, midi: { ...c.midi, notes: c.midi.notes.filter(n => !noteIds.includes(n.id)) } }
                    : c
            ),
        }));
    }, [copyNotes, pushUndoNamed, findClip, updateTrack]);

    const copyTrack = useCallback((trackId: string) => {
        const track = state.project.tracks.find(t => t.id === trackId);
        if (!track) return;
        setState(prev => ({
            ...prev,
            clipboard: addToClipboard(
                prev.clipboard,
                "daw-track",
                `Track "${track.name}"`,
                `${track.type} track with ${track.clips.length} clips`,
                { ...track, clips: track.clips.map(c => ({ ...c })) },
                { clipCount: track.clips.length },
            ),
        }));
    }, [state.project.tracks]);

    const pasteClips = useCallback((trackId: string, position: number) => {
        setState(prev => {
            const entry = getActiveEntry(prev.clipboard);
            if (!entry || entry.type !== "daw-clips") return prev;
            const clips = entry.data as Clip[];
            if (clips.length === 0) return prev;

            const minPos = Math.min(...clips.map(c => c.position));
            const newClips = clips.map(c => ({
                ...c,
                id: createId(),
                trackId,
                position: c.position - minPos + position,
            }));

            const newHistory = pushHistory(prev.history, prev.project, `Paste ${clips.length} Clip(s)`, "Clipboard");
            const project = {
                ...prev.project,
                tracks: prev.project.tracks.map(t =>
                    t.id === trackId ? { ...t, clips: [...t.clips, ...newClips] } : t
                ),
                modifiedAt: Date.now(),
            };

            return { ...prev, project, history: newHistory, isDirty: true };
        });
    }, []);

    const pasteNotes = useCallback((clipId: string, startBeat: number) => {
        setState(prev => {
            const entry = getActiveEntry(prev.clipboard);
            if (!entry || entry.type !== "daw-notes") return prev;
            const notes = entry.data as import("@/lib/daw-engine").MidiNote[];
            if (notes.length === 0) return prev;

            const minStart = Math.min(...notes.map(n => n.start));
            const newNotes = notes.map(n => ({
                ...n,
                id: createId(),
                start: n.start - minStart + startBeat,
            }));

            const newHistory = pushHistory(prev.history, prev.project, `Paste ${notes.length} Notes`, "Clipboard");
            const project = {
                ...prev.project,
                tracks: prev.project.tracks.map(t => ({
                    ...t,
                    clips: t.clips.map(c =>
                        c.id === clipId && c.midi
                            ? { ...c, midi: { ...c.midi, notes: [...c.midi.notes, ...newNotes] } }
                            : c
                    ),
                })),
                modifiedAt: Date.now(),
            };

            return { ...prev, project, history: newHistory, isDirty: true };
        });
    }, []);

    const pasteTrack = useCallback(() => {
        setState(prev => {
            const entry = getActiveEntry(prev.clipboard);
            if (!entry || entry.type !== "daw-track") return prev;
            const srcTrack = entry.data as DAWTrack;

            const newTrack: DAWTrack = {
                ...srcTrack,
                id: createId(),
                name: `${srcTrack.name} (pasted)`,
                clips: srcTrack.clips.map(c => ({ ...c, id: createId(), trackId: "" })),
            };
            newTrack.clips.forEach(c => { c.trackId = newTrack.id; });
            engineRef.current?.createChannel(newTrack.id, newTrack.type);

            const newHistory = pushHistory(prev.history, prev.project, `Paste Track "${srcTrack.name}"`, "Clipboard");
            const project = {
                ...prev.project,
                tracks: [...prev.project.tracks, newTrack],
                modifiedAt: Date.now(),
            };

            return { ...prev, project, history: newHistory, isDirty: true };
        });
    }, []);

    const removeClipboardEntry = useCallback((id: string) => {
        setState(prev => {
            const newCb = removeFromClipboard(prev.clipboard, id);
            saveClipboard(newCb);
            return { ...prev, clipboard: newCb };
        });
    }, []);

    const togglePinClipboardEntry = useCallback((id: string) => {
        setState(prev => {
            const newCb = togglePinClipboard(prev.clipboard, id);
            saveClipboard(newCb);
            return { ...prev, clipboard: newCb };
        });
    }, []);

    const setActiveClipboardEntry = useCallback((index: number) => {
        setState(prev => ({
            ...prev,
            clipboard: setActiveClipboard(prev.clipboard, index),
        }));
    }, []);

    const clearAllClipboard = useCallback(() => {
        setState(prev => {
            const newCb = clearClipboard(prev.clipboard);
            saveClipboard(newCb);
            return { ...prev, clipboard: newCb };
        });
    }, []);

    // ─── Import from Library ─────────────────────────────────────────────

    const importTrackFromLibrary = useCallback(async (trackFilepath: string, trackTitle: string, isNewProject?: boolean) => {
        if (isNewProject) {
            newProject(trackTitle);
        }
        const engine = engineRef.current;
        if (!engine) return;

        // Add a new audio track
        pushUndoNamed(`Import "${trackTitle}"`, "FileAudio");
        const track = createDefaultTrack("audio", trackTitle);
        engine.createChannel(track.id, "audio");

        // Create a clip and load the audio
        const clip = createClip("audio", track.id, 0, 16, trackTitle);
        track.clips = [clip];

        updateProject(p => ({ ...p, tracks: [...p.tracks, track] }));

        // Load audio into the clip
        try {
            // If the path is a direct URL (e.g. /samples/...), use it directly
            // Otherwise, route through the API for DB track IDs
            const audioUrl = trackFilepath.startsWith("/")
                ? trackFilepath
                : `/api/audio/${encodeURIComponent(trackFilepath)}`;
            const buffer = await engine.loadAudioBuffer(audioUrl);
            const peaks = engine.computeWaveformPeaks(buffer);
            updateTrack(track.id, t => ({
                ...t,
                clips: t.clips.map(c => c.id === clip.id ? {
                    ...c,
                    audio: {
                        ...c.audio!,
                        buffer,
                        sourceUrl: audioUrl,
                        name: trackTitle,
                        duration: buffer.duration,
                        waveformPeaks: peaks,
                    },
                    length: engine.secondsToBeats(buffer.duration, state.project.tempo),
                } : c),
            }));
        } catch {
            // Audio load failed, clip remains empty
        }
    }, [newProject, pushUndoNamed, updateProject, updateTrack, state.project.tempo]);

    // ─── Master ──────────────────────────────────────────────────────────

    const setMasterVolume = useCallback((vol: number) => {
        updateProject(p => ({ ...p, masterTrack: { ...p.masterTrack, volume: vol } }));
        // Sync engine master gain
        engineRef.current?.setMasterGainValue(vol);
    }, [updateProject]);

    const exportProject = useCallback(async (
        format: "wav" | "mp3" | "flac" | "ogg",
        options: {
            bitRate?: number;
            bitDepth?: 16 | 24 | 32;
            sampleRate?: number;
            channels?: 1 | 2;
            normalize?: boolean;
            limitPeak?: boolean;
            tailSec?: number;
            onProgress?: (pct: number) => void;
        },
    ) => {
        const engine = engineRef.current;
        if (!engine) return null;
        return engine.exportProject(state.project, format, options);
    }, [state.project]);

    const getEngine = useCallback((): DAWEngine | null => {
        return engineRef.current;
    }, []);

    // ─── Voice Processor Bridge ──────────────────────────────────────────

    const vpBridgeRef = useRef<VPBridge | null>(null);

    const registerVPBridge = useCallback((bridge: VPBridge) => {
        vpBridgeRef.current = bridge;
    }, []);

    const unregisterVPBridge = useCallback(() => {
        vpBridgeRef.current = null;
    }, []);

    const getVPBridge = useCallback((): VPBridge | null => {
        return vpBridgeRef.current;
    }, []);

    // ─── Stems Separation ────────────────────────────────────────────────

    const separateClipToStems = useCallback(async (clipId: string) => {
        const found = findClip(clipId);
        if (!found || !found.clip.audio?.buffer) return;

        const { clip } = found;
        const buffer = clip.audio!.buffer!;
        const { separateStems, STEM_COLORS: stemColors } = await import("@/lib/stems-engine");

        pushUndoNamed(`Separate "${clip.name}" to Stems`, "Layers");

        const result = await separateStems(buffer);
        const stemEntries = [
            { type: "vocals" as const, buffer: result.vocals, color: stemColors.vocals },
            { type: "drums" as const, buffer: result.drums, color: stemColors.drums },
            { type: "bass" as const, buffer: result.bass, color: stemColors.bass },
            { type: "melody" as const, buffer: result.melody, color: stemColors.melody },
        ];

        const newTracks: typeof state.project.tracks = [];

        for (const stem of stemEntries) {
            if (!stem.buffer) continue;
            const track = createDefaultTrack("audio", `${clip.name} — ${stem.type.charAt(0).toUpperCase() + stem.type.slice(1)}`);
            track.color = stem.color;
            engineRef.current?.createChannel(track.id, "audio");

            const stemClip = createClip("audio", track.id, clip.position, clip.length, `${stem.type}`);
            stemClip.color = stem.color;
            stemClip.audio = {
                ...stemClip.audio!,
                buffer: stem.buffer,
                name: `${clip.name} (${stem.type})`,
                duration: stem.buffer.duration,
                sampleRate: stem.buffer.sampleRate,
                channels: stem.buffer.numberOfChannels,
            };

            track.clips = [stemClip];
            newTracks.push(track);
        }

        updateProject(p => ({
            ...p,
            tracks: [...p.tracks, ...newTracks],
        }));
    }, [findClip, pushUndoNamed, updateProject]);

    // ─── Live send routing ───────────────────────────────────────────────
    //
    // applySends is idempotent and very cheap. Recomputing whenever the
    // tracks array (or any track's sends) changes keeps live playback in
    // sync with the UI without waiting for the next play() call.
    const sendsSignature = useMemo(() => state.project.tracks
        .map((t) => `${t.id}:${(t.sends ?? []).map((s) => `${s.returnTrackId}/${s.amount}/${s.preFader ? 1 : 0}`).join(",")}`)
        .join("|"),
        [state.project.tracks]);
    useEffect(() => {
        engineRef.current?.applySends(state.project);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sendsSignature]);

    // ─── Live insert (FX) routing ────────────────────────────────────────
    const insertsSignature = useMemo(() => state.project.tracks
        .map((t) => `${t.id}:${(t.inserts ?? []).map((i) => `${i.type}/${i.enabled ? 1 : 0}/${JSON.stringify(i.params ?? {})}`).join(",")}`)
        .join("|"),
        [state.project.tracks]);
    useEffect(() => {
        engineRef.current?.applyInserts(state.project);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [insertsSignature]);

    // ─── Auto-save ───────────────────────────────────────────────────────

    useEffect(() => {
        if (!state.isDirty) return;
        const timer = setTimeout(() => {
            saveProject(state.project);
            setState(prev => ({ ...prev, isDirty: false }));
        }, 2000);
        return () => clearTimeout(timer);
    }, [state.isDirty, state.project]);

    // ─── Focus mode: hide app shell ──────────────────────────────────────

    useEffect(() => {
        document.body.classList.toggle("daw-focus-mode", state.focusMode);
        return () => { document.body.classList.remove("daw-focus-mode"); };
    }, [state.focusMode]);

    // ─── Memoized actions ────────────────────────────────────────────────

    const actions = useMemo<DAWActions>(() => ({
        play, stop, pause, togglePlay, record, seek, setTempo, setTimeSignature,
        toggleMetronome, setMetronomeVolume, toggleLoop, setLoopRegion,
        setPlaybackMode, togglePlaybackMode,
        setTool, setSnap, setZoom, setScroll,
        addTrack, removeTrack, renameTrack, setTrackVolume, setTrackPan,
        toggleTrackMute, toggleTrackSolo, toggleTrackArm, setTrackColor,
        setTrackHeight, reorderTrack, selectTrack, duplicateTrack, freezeTrack,
        addClip, removeClip, moveClip, resizeClip, splitClip, duplicateClip,
        muteClip, setClipColor, selectClip, loadAudioIntoClip, loadFileIntoClip,
        setClipGain, setClipFade, reverseClip, setClipPitch, setClipTimeStretch, normalizeClip,
        addNote, removeNote, moveNote, resizeNote, setNoteVelocity,
        selectNotes, clearSelection, openPianoRoll, closePianoRoll,
        playSynthNote, stopSynthNote, setSynthConfig,
        toggleStep, setStepVelocity, setPatternSteps, setPatternSwing, clearPattern,
        addInsert, removeInsert, toggleInsert, setInsertParam, setSidechainSource, reorderInserts,
        addSend, removeSend, setSendAmount,
        addAutomationLane, removeAutomationLane, addAutomationPoint,
        removeAutomationPoint, moveAutomationPoint,
        setAutomationLaneMode, recordAutomationTouch, releaseAutomationTouch,
        toggleAutomationVisibility,
        togglePanel,
        newProject, openProject, saveCurrentProject, renameProject,
        setProjectModal, setSettingsModal, setExportModal, toggleFocusMode, setBrowserTab,
        undo, redo, jumpToHistoryEntry,
        copyClips, cutClips, copyNotes, cutNotes, copyTrack,
        pasteClips, pasteNotes, pasteTrack,
        removeClipboardEntry, togglePinClipboardEntry, setActiveClipboardEntry, clearAllClipboard,
        importTrackFromLibrary,
        setMasterVolume, exportProject, getEngine, separateClipToStems,
        registerVPBridge, unregisterVPBridge, getVPBridge,
    }), [
        play, stop, pause, togglePlay, record, seek, setTempo, setTimeSignature,
        toggleMetronome, setMetronomeVolume, toggleLoop, setLoopRegion,
        setPlaybackMode, togglePlaybackMode,
        setTool, setSnap, setZoom, setScroll,
        addTrack, removeTrack, renameTrack, setTrackVolume, setTrackPan,
        toggleTrackMute, toggleTrackSolo, toggleTrackArm, setTrackColor,
        setTrackHeight, reorderTrack, selectTrack, duplicateTrack, freezeTrack,
        addClip, removeClip, moveClip, resizeClip, splitClip, duplicateClip,
        muteClip, setClipColor, selectClip, loadAudioIntoClip, loadFileIntoClip,
        setClipGain, setClipFade, reverseClip, setClipPitch, setClipTimeStretch, normalizeClip,
        addNote, removeNote, moveNote, resizeNote, setNoteVelocity,
        selectNotes, clearSelection, openPianoRoll, closePianoRoll,
        playSynthNote, stopSynthNote, setSynthConfig,
        toggleStep, setStepVelocity, setPatternSteps, setPatternSwing, clearPattern,
        addInsert, removeInsert, toggleInsert, setInsertParam, setSidechainSource, reorderInserts,
        addSend, removeSend, setSendAmount,
        addAutomationLane, removeAutomationLane, addAutomationPoint,
        removeAutomationPoint, moveAutomationPoint,
        setAutomationLaneMode, recordAutomationTouch, releaseAutomationTouch,
        toggleAutomationVisibility,
        togglePanel,
        newProject, openProject, saveCurrentProject, renameProject,
        setProjectModal, setSettingsModal, setExportModal, toggleFocusMode, setBrowserTab,
        undo, redo, jumpToHistoryEntry,
        copyClips, cutClips, copyNotes, cutNotes, copyTrack,
        pasteClips, pasteNotes, pasteTrack,
        removeClipboardEntry, togglePinClipboardEntry, setActiveClipboardEntry, clearAllClipboard,
        importTrackFromLibrary,
        setMasterVolume, exportProject, getEngine, separateClipToStems,
        registerVPBridge, unregisterVPBridge, getVPBridge,
    ]);

    return (
        <DAWActionsContext.Provider value={actions}>
            <DAWStateContext.Provider value={state}>
                {children}
            </DAWStateContext.Provider>
        </DAWActionsContext.Provider>
    );
}
