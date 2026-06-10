"use client";

import { useSyncExternalStore } from "react";
import type { NoteNotation } from "@/lib/note-notation";

// ─── Types ───────────────────────────────────────────────────────────────

export type ClipDisplayMode = "waveform" | "notes" | "both" | "none";
export type WaveformStyle = "classic" | "bars" | "lines" | "filled";
export type WaveformColorMode = "clip" | "mono" | "gradient";
export type TrackHeight = "compact" | "normal" | "large";
export type GridStyle = "lines" | "dots" | "none";
export type PlayheadColor = "green" | "red" | "white" | "cyan" | "orange";
export type SpectrogramColorMap = "magma" | "viridis" | "inferno" | "plasma" | "grayscale";
export type EditorWaveformColor = "blue" | "purple" | "green" | "cyan" | "orange" | "white";

export interface StatusBarStatsConfig {
    showFps: boolean;
    showHeapMemory: boolean;
    showJsHeapTotal: boolean;
    showDomNodes: boolean;
    showAudioLatency: boolean;
    showCpuCores: boolean;
    showDeviceMemory: boolean;
}

export const DEFAULT_STATUS_BAR_STATS: StatusBarStatsConfig = {
    showFps: true,
    showHeapMemory: true,
    showJsHeapTotal: false,
    showDomNodes: false,
    showAudioLatency: true,
    showCpuCores: false,
    showDeviceMemory: false,
};

export const DEFAULT_EDITOR_STATUS_BAR_STATS: StatusBarStatsConfig = {
    showFps: true,
    showHeapMemory: true,
    showJsHeapTotal: false,
    showDomNodes: false,
    showAudioLatency: false,
    showCpuCores: false,
    showDeviceMemory: false,
};

export interface DAWDisplaySettings {
    // Audio devices
    audioOutputDeviceId: string;
    audioInputDeviceId: string;
    inputMonitorEnabled: boolean;

    // Clip display
    clipDisplayMode: ClipDisplayMode;
    waveformStyle: WaveformStyle;
    waveformColorMode: WaveformColorMode;
    showClipNames: boolean;
    showClipInfoBadges: boolean;
    clipOpacity: number; // 0.3 – 1.0

    // Timeline
    trackHeight: TrackHeight;
    gridStyle: GridStyle;
    gridOpacity: number; // 0.0 – 1.0
    showAutomation: boolean;
    snapToGrid: boolean;
    activeClipHighlight: boolean;
    playheadColor: PlayheadColor;

    // Sound Editor
    editorWaveformColor: EditorWaveformColor;
    editorShowRms: boolean;
    editorShowGridLines: boolean;
    editorShowMinimap: boolean;
    spectrogramColorMap: SpectrogramColorMap;
    spectrogramFftSize: number; // 512, 1024, 2048, 4096

    // Note Notation
    noteNotation1: NoteNotation; // Primary notation format
    noteNotation2: NoteNotation | "none"; // Secondary notation format (or none)

    // Appearance
    showMixerPeakHold: boolean;
    peakHoldDuration: number; // ms
    meterType: "peak" | "rms" | "peak+rms";
    uiRefreshRate: number; // 30, 60

    // Status bar performance stats
    dawStatusBarStats: StatusBarStatsConfig;
    editorStatusBarStats: StatusBarStatsConfig;
}

// ─── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_DAW_SETTINGS: DAWDisplaySettings = {
    audioOutputDeviceId: "default",
    audioInputDeviceId: "default",
    inputMonitorEnabled: false,
    clipDisplayMode: "both",
    waveformStyle: "classic",
    waveformColorMode: "clip",
    showClipNames: true,
    showClipInfoBadges: true,
    clipOpacity: 1.0,
    trackHeight: "normal",
    gridStyle: "lines",
    gridOpacity: 0.5,
    showAutomation: true,
    snapToGrid: true,
    activeClipHighlight: true,
    playheadColor: "green",
    editorWaveformColor: "blue",
    editorShowRms: true,
    editorShowGridLines: true,
    editorShowMinimap: true,
    spectrogramColorMap: "magma",
    spectrogramFftSize: 2048,
    noteNotation1: "anglo" as NoteNotation,
    noteNotation2: "solfege" as NoteNotation | "none",
    showMixerPeakHold: true,
    peakHoldDuration: 2000,
    meterType: "peak",
    uiRefreshRate: 60,
    dawStatusBarStats: { ...DEFAULT_STATUS_BAR_STATS },
    editorStatusBarStats: { ...DEFAULT_EDITOR_STATUS_BAR_STATS },
};

export const TRACK_HEIGHT_VALUES: Record<TrackHeight, number> = {
    compact: 48,
    normal: 60,
    large: 80,
};

export const PLAYHEAD_COLORS: Record<PlayheadColor, string> = {
    green: "#22c55e",
    red: "#ef4444",
    white: "#ffffff",
    cyan: "#06b6d4",
    orange: "#f97316",
};

export const EDITOR_WAVEFORM_COLORS: Record<EditorWaveformColor, string> = {
    blue: "oklch(0.62 0.19 250)",
    purple: "oklch(0.62 0.19 290)",
    green: "oklch(0.62 0.19 145)",
    cyan: "oklch(0.62 0.19 200)",
    orange: "oklch(0.62 0.19 50)",
    white: "oklch(0.85 0 0)",
};

// ─── Storage ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "mmo-daw-display-settings";

function load(): DAWDisplaySettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULT_DAW_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULT_DAW_SETTINGS };
}

function save(settings: DAWDisplaySettings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch { /* ignore */ }
}

// ─── External Store ──────────────────────────────────────────────────────

let currentSettings = load();
const listeners = new Set<() => void>();

function getSnapshot(): DAWDisplaySettings {
    return currentSettings;
}

export function getDAWSettings(): DAWDisplaySettings {
    return currentSettings;
}

/** Get active notation formats without hook (for use outside React) */
export function getActiveNotations(): NoteNotation[] {
    const s = currentSettings;
    return s.noteNotation2 === "none" ? [s.noteNotation1] : [s.noteNotation1, s.noteNotation2];
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function updateSettings(patch: Partial<DAWDisplaySettings>) {
    currentSettings = { ...currentSettings, ...patch };
    save(currentSettings);
    listeners.forEach(fn => fn());
}

function resetSettings() {
    currentSettings = { ...DEFAULT_DAW_SETTINGS };
    save(currentSettings);
    listeners.forEach(fn => fn());
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function useDAWSettings() {
    const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const noteNotations: NoteNotation[] = settings.noteNotation2 === "none"
        ? [settings.noteNotation1]
        : [settings.noteNotation1, settings.noteNotation2];

    return {
        ...settings,
        update: updateSettings,
        reset: resetSettings,
        trackHeightPx: TRACK_HEIGHT_VALUES[settings.trackHeight],
        playheadHex: PLAYHEAD_COLORS[settings.playheadColor],
        editorWaveformHex: EDITOR_WAVEFORM_COLORS[settings.editorWaveformColor],
        /** Active notation formats as an array (1 or 2 entries) */
        noteNotations,
    };
}

// ─── Audio Output Utilities ──────────────────────────────────────────────

export async function enumerateAudioOutputs(): Promise<MediaDeviceInfo[]> {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === "audiooutput");
    } catch {
        return [];
    }
}

export async function enumerateAudioInputs(): Promise<MediaDeviceInfo[]> {
    try {
        // Request permission to get labels
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter(d => d.kind === "audioinput");
    } catch {
        return [];
    }
}

export async function requestAudioPermission(): Promise<"granted" | "denied"> {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        return "granted";
    } catch {
        return "denied";
    }
}

/** Apply setSinkId to an AudioContext (Chrome 110+) */
export async function setAudioContextSinkId(ctx: AudioContext, deviceId: string): Promise<boolean> {
    try {
        if ("setSinkId" in ctx) {
            await (ctx as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
            return true;
        }
    } catch { /* not supported */ }
    return false;
}
