"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";

// ─── Types ───────────────────────────────────────────────────────────────

export type MixerBackground = "blur" | "solid" | "gradient" | "transparent";
export type AccentColor = "purple" | "blue" | "green" | "red" | "orange" | "pink" | "cyan";
export type UIDensity = "compact" | "normal" | "spacious";
export type KnobStyle = "arc" | "dot" | "line";
export type PerfStatsPosition = "off" | "on";

export interface PerfPanelConfig {
    // System stats
    showCpu: boolean;
    showCpuTemp: boolean;
    showRam: boolean;
    showGpu: boolean;
    showGpuTemp: boolean;
    showVram: boolean;
    gpuIndex: number; // which GPU to monitor (0-based)
    // Browser stats
    showFps: boolean;
    showTabMemory: boolean;
    showJsHeap: boolean;
    showDomNodes: boolean;
    showAudioLatency: boolean;
    // Layout
    showModelInfo: boolean;
    pollInterval: number; // seconds (1-10)
}

export const DEFAULT_PERF_CONFIG: PerfPanelConfig = {
    showCpu: true,
    showCpuTemp: true,
    showRam: true,
    showGpu: true,
    showGpuTemp: true,
    showVram: true,
    gpuIndex: 0,
    showFps: true,
    showTabMemory: true,
    showJsHeap: true,
    showDomNodes: true,
    showAudioLatency: true,
    showModelInfo: true,
    pollInterval: 2,
};

export type JogwheelStyle =
    | "classic" | "vinyl" | "cdj" | "minimal" | "neon"
    | "radar" | "techno" | "retro" | "holo" | "spectrum"
    | "carbon" | "laser" | "pulse" | "eclipse" | "circuit"
    | "waveform" | "crystal" | "vortex" | "dotgrid" | "plasma";

export interface PersonalizationSettings {
    // Background
    mixerBackground: MixerBackground;
    solidBgColor: string; // hex
    gradientFrom: string; // hex
    gradientTo: string; // hex
    backgroundOpacity: number; // 0.0–1.0
    blurIntensity: number; // 0–30

    // Typography
    textScale: number; // 0.75–1.25

    // Theme
    accentColor: AccentColor;

    // Layout
    uiDensity: UIDensity;

    // Knobs
    knobStyle: KnobStyle;

    // Jogwheel
    jogwheelStyle: JogwheelStyle;
    endWarningSeconds: number; // 0–60, 0 = disabled

    // Performance
    reducedAnimations: boolean;
    performanceStatsPosition: PerfStatsPosition;
    perfConfig: PerfPanelConfig;

    // Visibility
    showBeatGrid: boolean;
    showVuMeters: boolean;
    showKeyDisplay: boolean;

    // Safety
    confirmLoadOnPlayingDeck: boolean;

    // External Devices
    showExternalDevices: boolean;
    externalDeviceAutoConnect: boolean;
    externalDevicePosition: { x: number; y: number };
    externalDeviceMinimized: boolean;
    externalDeviceCompact: boolean;
}

// ─── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
    mixerBackground: "blur",
    solidBgColor: "#0a0a0a",
    gradientFrom: "#1a0a2e",
    gradientTo: "#0a0a0a",
    backgroundOpacity: 0.85,
    blurIntensity: 16,
    textScale: 1.0,
    accentColor: "purple",
    uiDensity: "normal",
    knobStyle: "arc",
    jogwheelStyle: "classic",
    endWarningSeconds: 30,
    reducedAnimations: false,
    performanceStatsPosition: "off" as PerfStatsPosition,
    perfConfig: { ...DEFAULT_PERF_CONFIG },
    // Migration: convert legacy "header"/"mixer"/"both" → "on"
    showBeatGrid: true,
    showVuMeters: true,
    showKeyDisplay: true,
    confirmLoadOnPlayingDeck: true,
    showExternalDevices: true,
    externalDeviceAutoConnect: true,
    externalDevicePosition: { x: 20, y: 100 },
    externalDeviceMinimized: false,
    externalDeviceCompact: false,
};

// ─── Accent Color Map ────────────────────────────────────────────────────

export const ACCENT_COLORS: Record<AccentColor, { primary: string; primaryRgb: string; label: string; swatch: string }> = {
    purple: { primary: "rgb(168,85,247)", primaryRgb: "168,85,247", label: "Purple", swatch: "#a855f7" },
    blue: { primary: "rgb(59,130,246)", primaryRgb: "59,130,246", label: "Blue", swatch: "#3b82f6" },
    green: { primary: "rgb(34,197,94)", primaryRgb: "34,197,94", label: "Green", swatch: "#22c55e" },
    red: { primary: "rgb(239,68,68)", primaryRgb: "239,68,68", label: "Red", swatch: "#ef4444" },
    orange: { primary: "rgb(249,115,22)", primaryRgb: "249,115,22", label: "Orange", swatch: "#f97316" },
    pink: { primary: "rgb(236,72,153)", primaryRgb: "236,72,153", label: "Pink", swatch: "#ec4899" },
    cyan: { primary: "rgb(6,182,212)", primaryRgb: "6,182,212", label: "Cyan", swatch: "#06b6d4" },
};

export const DENSITY_VALUES: Record<UIDensity, { gap: number; padding: number; label: string }> = {
    compact: { gap: 0.75, padding: 0.75, label: "Compact" },
    normal: { gap: 1, padding: 1, label: "Normal" },
    spacious: { gap: 1.25, padding: 1.25, label: "Spacious" },
};

// ─── Storage ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "mmo-personalization";

function load(): PersonalizationSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = { ...DEFAULT_PERSONALIZATION, ...JSON.parse(raw) };
            // Migrate legacy 4-option perf stats position → on/off
            if (parsed.performanceStatsPosition === "header" || parsed.performanceStatsPosition === "mixer" || parsed.performanceStatsPosition === "both") {
                parsed.performanceStatsPosition = "on";
            }
            return parsed;
        }
    } catch { /* ignore */ }
    return { ...DEFAULT_PERSONALIZATION };
}

function save(settings: PersonalizationSettings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* ignore */ }
}

// ─── External Store (shared across components) ───────────────────────────

let currentSettings = load();
const listeners = new Set<() => void>();

function getSnapshot(): PersonalizationSettings {
    return currentSettings;
}

/** Read a personalization setting outside of React (e.g., in callbacks). */
export function getPersonalization(): PersonalizationSettings {
    return currentSettings;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function updateSettings(patch: Partial<PersonalizationSettings>) {
    currentSettings = { ...currentSettings, ...patch };
    save(currentSettings);
    listeners.forEach(fn => fn());
}

function resetSettings() {
    currentSettings = { ...DEFAULT_PERSONALIZATION };
    save(currentSettings);
    listeners.forEach(fn => fn());
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function usePersonalization() {
    const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    return {
        ...settings,
        update: updateSettings,
        reset: resetSettings,
        accent: ACCENT_COLORS[settings.accentColor],
        density: DENSITY_VALUES[settings.uiDensity],
    };
}

// ─── CSS Variable Helpers ────────────────────────────────────────────────

export function getMixerBackgroundStyle(settings: PersonalizationSettings): React.CSSProperties {
    switch (settings.mixerBackground) {
        case "solid":
            return {
                backgroundColor: settings.solidBgColor,
                opacity: settings.backgroundOpacity,
            };
        case "gradient":
            return {
                background: `linear-gradient(to bottom, ${settings.gradientFrom}, ${settings.gradientTo})`,
                opacity: settings.backgroundOpacity,
            };
        case "transparent":
            return {
                backgroundColor: "transparent",
            };
        case "blur":
        default:
            return {
                backgroundColor: `rgba(0,0,0,${settings.backgroundOpacity})`,
                backdropFilter: `blur(${settings.blurIntensity}px)`,
                WebkitBackdropFilter: `blur(${settings.blurIntensity}px)`,
            };
    }
}

export function getTextScaleStyle(settings: PersonalizationSettings): React.CSSProperties {
    return {
        fontSize: `${settings.textScale * 100}%`,
    };
}
