"use client";

import { createContext, useContext, useCallback, useRef, useState, useEffect, type ReactNode } from "react";
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
} from "@/lib/history-engine";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type EditorView = "waveform" | "spectrogram" | "split";
export type EditorTool = "select" | "zoom" | "pencil" | "razor" | "hand";

export interface Marker {
    id: string;
    position: number; // seconds
    label: string;
    color: string;
}

export interface Region {
    id: string;
    start: number; // seconds
    end: number;
    label: string;
    color: string;
}

export interface Selection {
    start: number; // seconds
    end: number;
    // For spectral: frequency range
    freqLow?: number;
    freqHigh?: number;
}

export interface EditOperation {
    type: string;
    params: Record<string, unknown>;
    timestamp: number;
}

export interface EditorProject {
    id: string;
    name: string;
    sourceUrl: string;
    sourceTrackId?: string;
    clipId?: string;
    sampleRate: number;
    channels: number;
    duration: number;
    markers: Marker[];
    regions: Region[];
    editHistory: EditOperation[];
}

export interface EditorSnapshot {
    buffer: AudioBuffer;
    markers: Marker[];
    regions: Region[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Context shape
// ═══════════════════════════════════════════════════════════════════════════

interface EditorContextValue {
    // Project
    project: EditorProject;
    isLoading: boolean;
    error: string | null;

    // Audio buffer
    buffer: AudioBuffer | null;
    peaks: Float32Array | null;

    // View
    view: EditorView;
    setView: (v: EditorView) => void;
    zoom: number; // pixels per second
    setZoom: (z: number) => void;
    scrollX: number; // seconds
    setScrollX: (x: number) => void;

    // Tool
    tool: EditorTool;
    setTool: (t: EditorTool) => void;

    // Selection
    selection: Selection | null;
    setSelection: (s: Selection | null) => void;

    // Playback
    isPlaying: boolean;
    playPosition: number; // seconds
    play: () => void;
    pause: () => void;
    stop: () => void;
    seek: (pos: number) => void;

    // Markers & Regions
    addMarker: (position: number, label?: string) => void;
    removeMarker: (id: string) => void;
    addRegion: (start: number, end: number, label?: string) => void;
    removeRegion: (id: string) => void;

    // Editing
    cut: () => void;
    copy: () => void;
    paste: () => void;
    deleteSelection: () => void;
    normalize: () => void;
    fadeIn: (duration?: number) => void;
    fadeOut: (duration?: number) => void;
    reverse: () => void;
    silence: () => void;

    // Undo/Redo
    undo: () => void;
    redo: () => void;
    canUndo: boolean;
    canRedo: boolean;
    history: HistoryState<EditorSnapshot>;
    jumpToHistoryEntry: (index: number) => void;

    // Load
    loadFromUrl: (url: string, name?: string) => Promise<void>;
    loadFromFile: (file: File) => Promise<void>;

    // Levels
    peakL: number;
    peakR: number;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
    const ctx = useContext(EditorContext);
    if (!ctx) throw new Error("useEditor must be used within EditorProvider");
    return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════

let _idCounter = 0;
function createId() { return `ed_${Date.now()}_${++_idCounter}`; }

function computePeaks(buffer: AudioBuffer, numPeaks: number): Float32Array {
    const channel = buffer.getChannelData(0);
    const blockSize = Math.floor(channel.length / numPeaks);
    const peaks = new Float32Array(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
        let max = 0;
        const start = i * blockSize;
        const end = Math.min(start + blockSize, channel.length);
        for (let j = start; j < end; j++) {
            const abs = Math.abs(channel[j]);
            if (abs > max) max = abs;
        }
        peaks[i] = max;
    }
    return peaks;
}

function sliceBuffer(ctx: OfflineAudioContext | AudioContext, buffer: AudioBuffer, start: number, end: number): AudioBuffer {
    const startSample = Math.floor(start * buffer.sampleRate);
    const endSample = Math.floor(end * buffer.sampleRate);
    const length = Math.max(1, endSample - startSample);
    const newBuf = new AudioBuffer({
        numberOfChannels: buffer.numberOfChannels,
        length,
        sampleRate: buffer.sampleRate,
    });
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const source = buffer.getChannelData(ch);
        const dest = newBuf.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            dest[i] = source[startSample + i] ?? 0;
        }
    }
    return newBuf;
}

function concatBuffers(a: AudioBuffer, b: AudioBuffer): AudioBuffer {
    const length = a.length + b.length;
    const newBuf = new AudioBuffer({
        numberOfChannels: Math.max(a.numberOfChannels, b.numberOfChannels),
        length,
        sampleRate: a.sampleRate,
    });
    for (let ch = 0; ch < newBuf.numberOfChannels; ch++) {
        const dest = newBuf.getChannelData(ch);
        const srcA = ch < a.numberOfChannels ? a.getChannelData(ch) : new Float32Array(a.length);
        const srcB = ch < b.numberOfChannels ? b.getChannelData(ch) : new Float32Array(b.length);
        dest.set(srcA, 0);
        dest.set(srcB, a.length);
    }
    return newBuf;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_PROJECT: EditorProject = {
    id: "",
    name: "Untitled",
    sourceUrl: "",
    sampleRate: 44100,
    channels: 2,
    duration: 0,
    markers: [],
    regions: [],
    editHistory: [],
};

export function EditorProvider({ children }: { children: ReactNode }) {
    const [project, setProject] = useState<EditorProject>(DEFAULT_PROJECT);
    const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
    const [peaks, setPeaks] = useState<Float32Array | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // View
    const [view, setView] = useState<EditorView>("waveform");
    const [zoom, setZoom] = useState(100); // px per second
    const [scrollX, setScrollX] = useState(0);

    // Tool
    const [tool, setTool] = useState<EditorTool>("select");

    // Selection
    const [selection, setSelection] = useState<Selection | null>(null);

    // Playback
    const [isPlaying, setIsPlaying] = useState(false);
    const [playPosition, setPlayPosition] = useState(0);
    const [peakL, setPeakL] = useState(0);
    const [peakR, setPeakR] = useState(0);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const startTimeRef = useRef(0);
    const offsetRef = useRef(0);
    const rafRef = useRef(0);

    // History (undo/redo)
    const [history, setHistory] = useState<HistoryState<EditorSnapshot>>(() =>
        createHistory<EditorSnapshot>({ buffer: null as unknown as AudioBuffer, markers: [], regions: [] }, "Initial", 50)
    );

    // Clipboard
    const clipboardRef = useRef<AudioBuffer | null>(null);

    // ─── Audio context ──────────────────────────────────────────────
    const getAudioCtx = useCallback(() => {
        if (!audioCtxRef.current) {
            audioCtxRef.current = new AudioContext();
        }
        return audioCtxRef.current;
    }, []);

    // ─── Playback animation loop ────────────────────────────────────
    const updatePlayPosition = useCallback(() => {
        const ctx = audioCtxRef.current;
        if (!ctx || !isPlaying) return;
        const pos = ctx.currentTime - startTimeRef.current + offsetRef.current;
        setPlayPosition(pos);

        // Level metering
        if (analyserRef.current) {
            const data = new Float32Array(analyserRef.current.fftSize);
            analyserRef.current.getFloatTimeDomainData(data);
            let max = 0;
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > max) max = abs;
            }
            setPeakL(max);
            setPeakR(max);
        }

        rafRef.current = requestAnimationFrame(updatePlayPosition);
    }, [isPlaying]);

    useEffect(() => {
        if (isPlaying) {
            rafRef.current = requestAnimationFrame(updatePlayPosition);
        }
        return () => cancelAnimationFrame(rafRef.current);
    }, [isPlaying, updatePlayPosition]);

    // ─── Push named undo ───────────────────────────────────────────
    const pushUndoNamed = useCallback((label: string, icon?: string) => {
        if (!buffer) return;
        setHistory(prev => pushHistory(prev, { buffer, markers: project.markers, regions: project.regions }, label, icon));
    }, [buffer, project.markers, project.regions]);

    // ─── Load audio ─────────────────────────────────────────────────
    const loadBuffer = useCallback((buf: AudioBuffer, name: string, url: string = "") => {
        setBuffer(buf);
        setPeaks(computePeaks(buf, Math.min(4000, buf.length)));
        setProject(p => ({
            ...p,
            id: createId(),
            name,
            sourceUrl: url,
            sampleRate: buf.sampleRate,
            channels: buf.numberOfChannels,
            duration: buf.duration,
        }));
        setScrollX(0);
        setPlayPosition(0);
        setHistory(createHistory<EditorSnapshot>({ buffer: buf, markers: [], regions: [] }, `Loaded "${name}"`, 50));
        setError(null);
    }, []);

    const loadFromUrl = useCallback(async (url: string, name?: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const ctx = getAudioCtx();
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
            const arrayBuf = await res.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(arrayBuf);
            loadBuffer(audioBuf, name || url.split("/").pop() || "Audio", url);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load audio");
        } finally {
            setIsLoading(false);
        }
    }, [getAudioCtx, loadBuffer]);

    const loadFromFile = useCallback(async (file: File) => {
        setIsLoading(true);
        setError(null);
        try {
            const ctx = getAudioCtx();
            const arrayBuf = await file.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(arrayBuf);
            loadBuffer(audioBuf, file.name);
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to decode audio file");
        } finally {
            setIsLoading(false);
        }
    }, [getAudioCtx, loadBuffer]);

    // ─── Playback controls ──────────────────────────────────────────
    const play = useCallback(() => {
        if (!buffer) return;
        const ctx = getAudioCtx();
        if (ctx.state === "suspended") ctx.resume();

        // Stop existing
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            sourceRef.current.stop();
        }

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;

        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(analyser);
        analyser.connect(ctx.destination);

        const offset = playPosition >= buffer.duration ? 0 : playPosition;
        offsetRef.current = offset;
        startTimeRef.current = ctx.currentTime;
        src.start(0, offset);
        sourceRef.current = src;
        setIsPlaying(true);

        src.onended = () => {
            setIsPlaying(false);
            setPlayPosition(0);
        };
    }, [buffer, getAudioCtx, playPosition]);

    const pause = useCallback(() => {
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            sourceRef.current.stop();
        }
        const ctx = audioCtxRef.current;
        if (ctx) {
            setPlayPosition(ctx.currentTime - startTimeRef.current + offsetRef.current);
        }
        setIsPlaying(false);
    }, []);

    const stop = useCallback(() => {
        if (sourceRef.current) {
            sourceRef.current.onended = null;
            sourceRef.current.stop();
        }
        setIsPlaying(false);
        setPlayPosition(0);
    }, []);

    const seek = useCallback((pos: number) => {
        setPlayPosition(Math.max(0, pos));
        if (isPlaying) {
            // Restart from new position
            pause();
            setTimeout(() => {
                offsetRef.current = pos;
                play();
            }, 10);
        }
    }, [isPlaying, pause, play]);

    // ─── Markers & Regions ──────────────────────────────────────────
    const addMarker = useCallback((position: number, label?: string) => {
        setProject(p => ({
            ...p,
            markers: [...p.markers, { id: createId(), position, label: label || `M${p.markers.length + 1}`, color: "#f59e0b" }],
        }));
    }, []);

    const removeMarker = useCallback((id: string) => {
        setProject(p => ({ ...p, markers: p.markers.filter(m => m.id !== id) }));
    }, []);

    const addRegion = useCallback((start: number, end: number, label?: string) => {
        setProject(p => ({
            ...p,
            regions: [...p.regions, { id: createId(), start, end, label: label || `R${p.regions.length + 1}`, color: "#3b82f6" }],
        }));
    }, []);

    const removeRegion = useCallback((id: string) => {
        setProject(p => ({ ...p, regions: p.regions.filter(r => r.id !== id) }));
    }, []);

    // ─── Buffer editing helpers ─────────────────────────────────────
    const applyBufferEdit = useCallback((newBuf: AudioBuffer) => {
        setBuffer(newBuf);
        setPeaks(computePeaks(newBuf, Math.min(4000, newBuf.length)));
        setProject(p => ({ ...p, duration: newBuf.duration }));
    }, []);

    // ─── Cut / Copy / Paste / Delete ────────────────────────────────
    const cut = useCallback(() => {
        if (!buffer || !selection) return;
        pushUndoNamed("Cut Selection", "Scissors");
        const ctx = getAudioCtx();
        clipboardRef.current = sliceBuffer(ctx, buffer, selection.start, selection.end);
        const before = sliceBuffer(ctx, buffer, 0, selection.start);
        const after = sliceBuffer(ctx, buffer, selection.end, buffer.duration);
        applyBufferEdit(concatBuffers(before, after));
        setSelection(null);
    }, [buffer, selection, pushUndoNamed, getAudioCtx, applyBufferEdit]);

    const copy = useCallback(() => {
        if (!buffer || !selection) return;
        const ctx = getAudioCtx();
        clipboardRef.current = sliceBuffer(ctx, buffer, selection.start, selection.end);
    }, [buffer, selection, getAudioCtx]);

    const paste = useCallback(() => {
        if (!buffer || !clipboardRef.current) return;
        pushUndoNamed("Paste Audio", "Clipboard");
        const ctx = getAudioCtx();
        const insertAt = selection?.start ?? playPosition;
        const before = sliceBuffer(ctx, buffer, 0, insertAt);
        const after = sliceBuffer(ctx, buffer, insertAt, buffer.duration);
        const combined = concatBuffers(concatBuffers(before, clipboardRef.current), after);
        applyBufferEdit(combined);
    }, [buffer, selection, playPosition, pushUndoNamed, getAudioCtx, applyBufferEdit]);

    const deleteSelection = useCallback(() => {
        if (!buffer || !selection) return;
        pushUndoNamed("Delete Selection", "Trash2");
        const ctx = getAudioCtx();
        const before = sliceBuffer(ctx, buffer, 0, selection.start);
        const after = sliceBuffer(ctx, buffer, selection.end, buffer.duration);
        applyBufferEdit(concatBuffers(before, after));
        setSelection(null);
    }, [buffer, selection, pushUndoNamed, getAudioCtx, applyBufferEdit]);

    // ─── Normalize ──────────────────────────────────────────────────
    const normalize = useCallback(() => {
        if (!buffer) return;
        pushUndoNamed("Normalize", "Volume2");
        const newBuf = new AudioBuffer({
            numberOfChannels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
        });
        let globalMax = 0;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) {
                const abs = Math.abs(data[i]);
                if (abs > globalMax) globalMax = abs;
            }
        }
        const gain = globalMax > 0 ? 1 / globalMax : 1;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dest = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                dest[i] = src[i] * gain;
            }
        }
        applyBufferEdit(newBuf);
    }, [buffer, pushUndoNamed, applyBufferEdit]);

    // ─── Fade In / Out ──────────────────────────────────────────────
    const fadeInFn = useCallback((duration = 0.5) => {
        if (!buffer) return;
        pushUndoNamed(`Fade In (${duration}s)`, "ArrowUpFromLine");
        const newBuf = new AudioBuffer({
            numberOfChannels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
        });
        const fadeSamples = Math.floor(duration * buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dest = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                const g = i < fadeSamples ? i / fadeSamples : 1;
                dest[i] = src[i] * g;
            }
        }
        applyBufferEdit(newBuf);
    }, [buffer, pushUndoNamed, applyBufferEdit]);

    const fadeOutFn = useCallback((duration = 0.5) => {
        if (!buffer) return;
        pushUndoNamed(`Fade Out (${duration}s)`, "ArrowDownToLine");
        const newBuf = new AudioBuffer({
            numberOfChannels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
        });
        const fadeSamples = Math.floor(duration * buffer.sampleRate);
        const fadeStart = buffer.length - fadeSamples;
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dest = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                const g = i > fadeStart ? (buffer.length - i) / fadeSamples : 1;
                dest[i] = src[i] * g;
            }
        }
        applyBufferEdit(newBuf);
    }, [buffer, pushUndoNamed, applyBufferEdit]);

    // ─── Reverse ────────────────────────────────────────────────────
    const reverseFn = useCallback(() => {
        if (!buffer) return;
        pushUndoNamed("Reverse", "RotateCcw");
        const newBuf = new AudioBuffer({
            numberOfChannels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
        });
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dest = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                dest[i] = src[src.length - 1 - i];
            }
        }
        applyBufferEdit(newBuf);
    }, [buffer, pushUndoNamed, applyBufferEdit]);

    // ─── Silence ────────────────────────────────────────────────────
    const silenceFn = useCallback(() => {
        if (!buffer || !selection) return;
        pushUndoNamed("Silence Selection", "VolumeX");
        const newBuf = new AudioBuffer({
            numberOfChannels: buffer.numberOfChannels,
            length: buffer.length,
            sampleRate: buffer.sampleRate,
        });
        const startSample = Math.floor(selection.start * buffer.sampleRate);
        const endSample = Math.floor(selection.end * buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch);
            const dest = newBuf.getChannelData(ch);
            for (let i = 0; i < src.length; i++) {
                dest[i] = (i >= startSample && i < endSample) ? 0 : src[i];
            }
        }
        applyBufferEdit(newBuf);
    }, [buffer, selection, pushUndoNamed, applyBufferEdit]);

    // ─── Undo / Redo ────────────────────────────────────────────────
    const undo = useCallback(() => {
        if (!histCanUndo(history) || !buffer) return;
        // Save current state as future before jumping back
        const newHistory = undoHistory(history);
        const snapshot = getCurrentSnapshot(newHistory);
        setHistory(newHistory);
        setBuffer(snapshot.buffer);
        setPeaks(computePeaks(snapshot.buffer, Math.min(4000, snapshot.buffer.length)));
        setProject(p => ({ ...p, duration: snapshot.buffer.duration, markers: snapshot.markers, regions: snapshot.regions }));
    }, [history, buffer]);

    const redo = useCallback(() => {
        if (!histCanRedo(history) || !buffer) return;
        const newHistory = redoHistory(history);
        const snapshot = getCurrentSnapshot(newHistory);
        setHistory(newHistory);
        setBuffer(snapshot.buffer);
        setPeaks(computePeaks(snapshot.buffer, Math.min(4000, snapshot.buffer.length)));
        setProject(p => ({ ...p, duration: snapshot.buffer.duration, markers: snapshot.markers, regions: snapshot.regions }));
    }, [history, buffer]);

    const jumpToHistoryEntry = useCallback((index: number) => {
        const newHistory = jumpToHistory(history, index);
        const snapshot = getCurrentSnapshot(newHistory);
        setHistory(newHistory);
        setBuffer(snapshot.buffer);
        setPeaks(computePeaks(snapshot.buffer, Math.min(4000, snapshot.buffer.length)));
        setProject(p => ({ ...p, duration: snapshot.buffer.duration, markers: snapshot.markers, regions: snapshot.regions }));
    }, [history]);

    // ─── Cleanup ────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            cancelAnimationFrame(rafRef.current);
            if (sourceRef.current) {
                sourceRef.current.onended = null;
                try { sourceRef.current.stop(); } catch { /* already stopped */ }
            }
            if (audioCtxRef.current?.state !== "closed") {
                audioCtxRef.current?.close();
            }
        };
    }, []);

    const value: EditorContextValue = {
        project, isLoading, error,
        buffer, peaks,
        view, setView, zoom, setZoom, scrollX, setScrollX,
        tool, setTool,
        selection, setSelection,
        isPlaying, playPosition, play, pause, stop, seek,
        addMarker, removeMarker, addRegion, removeRegion,
        cut, copy, paste, deleteSelection, normalize,
        fadeIn: fadeInFn, fadeOut: fadeOutFn,
        reverse: reverseFn, silence: silenceFn,
        undo, redo,
        canUndo: histCanUndo(history),
        canRedo: histCanRedo(history),
        history, jumpToHistoryEntry,
        loadFromUrl, loadFromFile,
        peakL, peakR,
    };

    return (
        <EditorContext value={value}>
            {children}
        </EditorContext>
    );
}
