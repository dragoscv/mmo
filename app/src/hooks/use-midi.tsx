"use client";

import { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from "react";
import {
    MidiEngine,
    type MidiDevice,
    type MidiMessage,
    type MidiPreset,
    type MidiActionHandler,
    type ExternalDeviceProfile,
    type ExternalDeviceTrack,
    EXTERNAL_DEVICE_PROFILES,
    BUILTIN_PRESETS,
} from "@/lib/midi-engine";

// ─── Types ───────────────────────────────────────────────────────────────

export type MidiStatus = "idle" | "connecting" | "connected" | "error";

export interface MidiSettings {
    enabled: boolean;
    activePreset: string | null;
    customPresets: MidiPreset[];
    jogSensitivity: number;
    tempoRange: number;
    crossfaderCurve: "linear" | "smooth" | "sharp";
}

export interface ExternalDeviceState {
    profile: ExternalDeviceProfile;
    device: MidiDevice;
}

type MidiMessageListener = (msg: MidiMessage) => void;

interface MidiContextValue {
    // Engine
    engine: MidiEngine | null;
    status: MidiStatus;
    devices: MidiDevice[];

    // Message subscription (multi-listener)
    addMessageListener: (listener: MidiMessageListener) => () => void;

    // External devices (grooveboxes, synths)
    externalDevices: ExternalDeviceState[];

    // Settings & presets
    settings: MidiSettings;
    updateSettings: (patch: Partial<MidiSettings>) => void;

    // MIDI Learn
    startLearn: (callback: (msg: MidiMessage) => void) => void;
    stopLearn: () => void;
    isLearning: boolean;

    // Action handler (app-specific: mixer transport, DAW transport, etc.)
    setActionHandler: (handler: MidiActionHandler | null) => void;

    // Preset management
    activatePreset: (preset: MidiPreset | null) => void;
    getAllPresets: () => MidiPreset[];

    // Engine operations
    refreshDevices: () => Promise<void>;
    getDiagnostics: () => string[];
    addLearnedMapping: (mapping: import("@/lib/midi-engine").MidiMapping) => void;
}

// ─── Default Settings ────────────────────────────────────────────────────

const DEFAULT_SETTINGS: MidiSettings = {
    enabled: true,
    activePreset: null,
    customPresets: [],
    jogSensitivity: 1.0,
    tempoRange: 8,
    crossfaderCurve: "smooth",
};

const SETTINGS_KEY = "mmo-midi-settings";

function loadSettings(): MidiSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_SETTINGS;
}

function saveSettings(s: MidiSettings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    } catch { /* ignore */ }
}

// ─── Context ─────────────────────────────────────────────────────────────

const MidiContext = createContext<MidiContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────────────────

export function MidiProvider({ children }: { children: ReactNode }) {
    const engineRef = useRef<MidiEngine | null>(null);
    const listenersRef = useRef<Set<MidiMessageListener>>(new Set());

    const [status, setStatus] = useState<MidiStatus>("idle");
    const [devices, setDevices] = useState<MidiDevice[]>([]);
    const [externalDevices, setExternalDevices] = useState<ExternalDeviceState[]>([]);
    const [settings, setSettings] = useState<MidiSettings>(loadSettings);
    const [isLearning, setIsLearning] = useState(false);

    // Initialize engine once
    useEffect(() => {
        const engine = new MidiEngine();
        engineRef.current = engine;

        engine.onDeviceChange = (devs) => {
            setDevices(devs);
            // Auto-detect external devices
            const found = engine.autoDetectExternalDevices(EXTERNAL_DEVICE_PROFILES);
            setExternalDevices(found);
        };

        // Fan-out messages to all subscribers
        engine.onMessage = (msg) => {
            for (const listener of listenersRef.current) {
                try {
                    listener(msg);
                } catch (err) {
                    console.warn("[MIDI] Listener error:", err);
                }
            }
        };

        setStatus("connecting");
        engine.init().then((success) => {
            if (success) {
                setStatus("connected");
                setDevices(engine.getDevices());

                // Auto-detect external devices on init
                const found = engine.autoDetectExternalDevices(EXTERNAL_DEVICE_PROFILES);
                setExternalDevices(found);

                // Auto-detect and load preset
                const saved = loadSettings();
                if (saved.activePreset) {
                    const allPresets = [...BUILTIN_PRESETS, ...saved.customPresets];
                    const preset = allPresets.find(p => p.name === saved.activePreset);
                    if (preset) engine.setMapping(preset);
                } else {
                    const detected = engine.autoDetectPreset(BUILTIN_PRESETS);
                    if (detected) {
                        engine.setMapping(detected);
                        const updated = { ...saved, activePreset: detected.name, enabled: true };
                        setSettings(updated);
                        saveSettings(updated);
                    }
                }
            } else {
                setStatus("error");
            }
        });

        return () => {
            engine.destroy();
            engineRef.current = null;
        };
    }, []);

    // Subscribe to MIDI messages
    const addMessageListener = useCallback((listener: MidiMessageListener) => {
        listenersRef.current.add(listener);
        return () => {
            listenersRef.current.delete(listener);
        };
    }, []);

    // Settings management
    const updateSettings = useCallback((patch: Partial<MidiSettings>) => {
        setSettings(prev => {
            const next = { ...prev, ...patch };
            saveSettings(next);
            return next;
        });
    }, []);

    // MIDI Learn
    const startLearn = useCallback((callback: (msg: MidiMessage) => void) => {
        engineRef.current?.startLearn(callback);
        setIsLearning(true);
    }, []);

    const stopLearn = useCallback(() => {
        engineRef.current?.stopLearn();
        setIsLearning(false);
    }, []);

    // Action handler
    const setActionHandler = useCallback((handler: MidiActionHandler | null) => {
        if (handler) {
            engineRef.current?.setHandler(handler);
        }
    }, []);

    // Preset activation
    const activatePreset = useCallback((preset: MidiPreset | null) => {
        if (preset) {
            engineRef.current?.setMapping(preset);
            updateSettings({ activePreset: preset.name, enabled: true });
        } else {
            engineRef.current?.setMapping({ name: "None", deviceNameMatch: "", author: "", description: "", mappings: [] });
            updateSettings({ activePreset: null });
        }
    }, [updateSettings]);

    // Get all presets (built-in + custom)
    const getAllPresets = useCallback(() => {
        return [...BUILTIN_PRESETS, ...settings.customPresets];
    }, [settings.customPresets]);

    // Refresh devices (destroy + re-init engine)
    const refreshDevices = useCallback(async () => {
        const oldEngine = engineRef.current;
        if (oldEngine) {
            oldEngine.destroy();
        }

        const engine = new MidiEngine();
        engineRef.current = engine;

        engine.onDeviceChange = (devs) => {
            setDevices(devs);
            const found = engine.autoDetectExternalDevices(EXTERNAL_DEVICE_PROFILES);
            setExternalDevices(found);
        };

        engine.onMessage = (msg) => {
            for (const listener of listenersRef.current) {
                try { listener(msg); } catch (err) { console.warn("[MIDI] Listener error:", err); }
            }
        };

        setStatus("connecting");
        const ok = await engine.init();
        if (ok) {
            setStatus("connected");
            setDevices(engine.getDevices());
            const found = engine.autoDetectExternalDevices(EXTERNAL_DEVICE_PROFILES);
            setExternalDevices(found);

            // Restore active preset
            const saved = loadSettings();
            if (saved.activePreset) {
                const allPresets = [...BUILTIN_PRESETS, ...saved.customPresets];
                const preset = allPresets.find(p => p.name === saved.activePreset);
                if (preset) engine.setMapping(preset);
            }
        } else {
            setStatus("error");
        }
    }, []);

    // Diagnostics
    const getDiagnostics = useCallback((): string[] => {
        return engineRef.current?.getDiagnostics() || ["Engine not initialized"];
    }, []);

    // Add learned mapping to the engine
    const addLearnedMapping = useCallback((mapping: import("@/lib/midi-engine").MidiMapping) => {
        engineRef.current?.addLearnedMapping(mapping);
    }, []);

    const value = useMemo<MidiContextValue>(() => ({
        engine: engineRef.current,
        status,
        devices,
        addMessageListener,
        externalDevices,
        settings,
        updateSettings,
        startLearn,
        stopLearn,
        isLearning,
        setActionHandler,
        activatePreset,
        getAllPresets,
        refreshDevices,
        getDiagnostics,
        addLearnedMapping,
    }), [status, devices, externalDevices, settings, isLearning, addMessageListener, updateSettings, startLearn, stopLearn, setActionHandler, activatePreset, getAllPresets, refreshDevices, getDiagnostics, addLearnedMapping]);

    return <MidiContext.Provider value={value}>{children}</MidiContext.Provider>;
}

// ─── Hooks ───────────────────────────────────────────────────────────────

/** Access the shared MIDI engine, devices, and status */
export function useMidi() {
    const ctx = useContext(MidiContext);
    if (!ctx) throw new Error("useMidi must be used within <MidiProvider>");
    return ctx;
}

/** Subscribe to MIDI messages. The callback is stable across re-renders. */
export function useMidiMessages(callback: MidiMessageListener) {
    const { addMessageListener } = useMidi();
    const callbackRef = useRef(callback);
    callbackRef.current = callback;

    useEffect(() => {
        const listener: MidiMessageListener = (msg) => callbackRef.current(msg);
        return addMessageListener(listener);
    }, [addMessageListener]);
}

/** Access external device state (Circuit Tracks, etc.) */
export function useExternalDevices() {
    const { externalDevices, engine } = useMidi();
    return { externalDevices, engine };
}
