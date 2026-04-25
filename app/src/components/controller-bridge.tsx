"use client";

/**
 * ControllerBridge
 *
 * Mounts a single instance of the appropriate `ControllerDriver` for each
 * connected MIDI device and pumps mixer state into it. Sits inside the
 * Mixer page where both `useMidi()` and `useMixer()` are available.
 *
 * Responsibilities:
 * - Detect / select a driver per device (auto from name regex, or
 *   user-pinned via `MidiSettings.controllerDriverId`)
 * - Apply the active color preset (with optional user overrides)
 * - Push state diffs every animation frame (driver itself diffs internally
 *   so this is cheap)
 * - Cleanly tear down LEDs on unmount / disconnect / driver swap
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useMidi } from "@/hooks/use-midi";
import { useMixer } from "@/components/mixer-context";
import type { ControllerDriver, DriverDeckState, DriverMixerState } from "@/lib/controllers/controller-driver";
import { GenericMidiDriver } from "@/lib/controllers/controller-driver";
import { createDriverById, detectDriverForDevice } from "@/lib/controllers/drivers/registry";
import { BUILTIN_COLOR_PRESETS, getPresetById, type ColorPreset } from "@/lib/controllers/color-presets";
import type { DeckState } from "@/lib/mixer-engine";
import type { MidiDevice } from "@/lib/midi-engine";

function deckSlice(d: DeckState, vuLevel: number): DriverDeckState {
    return {
        isPlaying: !!d.isPlaying,
        // Engine doesn't yet track momentary cue-button-held state.
        // Sync state is reflected via the temporary syncEnabled flag we
        // toggle in the mixer context's syncBpm action.
        isCueing: false,
        syncEnabled: false,
        loopEnabled: !!d.loopEnabled,
        headphoneCue: !!d.headphoneCue,
        padMode: d.padMode,
        hotCues: d.hotCues.slice(0, 8),
        bpm: d.bpm,
        // No raw "pitch" field on DeckState — derive from tempo offset.
        pitch: d.originalBpm > 0 ? (d.bpm - d.originalBpm) / d.originalBpm : 0,
        keyLock: !!d.keyLock,
        isLoaded: !!d.isLoaded,
        currentTime: d.currentTime,
        duration: d.duration,
        slipMode: !!d.slipMode,
        quantize: !!d.quantize,
        vuLevel,
        beatFxOn: !!d.beatFxOn,
    };
}

/**
 * Read the current RMS level (0..1) from an analyser node. Cheap enough to
 * call every frame: AnalyserNode keeps a ring buffer internally, we just
 * pull a small time-domain snapshot and average the squared samples.
 */
function sampleAnalyserVu(node: AnalyserNode | null, scratch: Uint8Array): number {
    if (!node) return 0;
    try {
        // AnalyserNode types want a Uint8Array<ArrayBuffer>; our scratch
        // is allocated locally so the cast is sound.
        node.getByteTimeDomainData(scratch as Uint8Array<ArrayBuffer>);
    } catch {
        return 0;
    }
    let sumSq = 0;
    for (let i = 0; i < scratch.length; i++) {
        const v = (scratch[i] - 128) / 128; // -1..+1
        sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / scratch.length);
    // RMS of a full-scale sine ≈ 0.707, so a 1.4× multiplier puts a hot
    // signal near full meter without saturating on quiet content. The
    // previous sqrt curve pushed nearly every sample to 1.0.
    return Math.max(0, Math.min(1, rms * 1.4));
}

function applyOverrides(preset: ColorPreset, overrides?: Partial<Record<string, string>>): ColorPreset {
    if (!overrides) return preset;
    const merged: ColorPreset = {
        ...preset,
        colors: { ...preset.colors, ...(overrides as ColorPreset["colors"]) },
    };
    return merged;
}

// ── Module-scoped active-driver registry ────────────────────────────────
// Lets the settings UI (which lives in a different component subtree, often
// rendered through a portal) ask "which drivers are *actually* bound right
// now?" rather than guessing from device names.

type ActiveControllerEntry = { deviceId: string; deviceName: string; driver: ControllerDriver };
const activeControllers = new Map<string, ActiveControllerEntry>();

// Snapshot version + cached array. We bump `snapshotVersion` whenever the
// registry changes and rebuild `snapshotCache` lazily. `useSyncExternalStore`
// requires getSnapshot() to return referentially stable data between changes
// (otherwise it loops). The version counter also lets us debug stale subs.
let snapshotVersion = 0;
let snapshotCache: ActiveControllerEntry[] = [];
const subscribers = new Set<() => void>();

function rebuildSnapshot() {
    snapshotVersion++;
    snapshotCache = Array.from(activeControllers.values());
    if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.info(`[ControllerBridge] registry → v${snapshotVersion}, ${snapshotCache.length} active`,
            snapshotCache.map(e => `${e.driver.info.name}@${e.deviceId}`));
    }
    for (const sub of subscribers) {
        try { sub(); } catch { /* ignore */ }
    }
}

function subscribeRegistry(cb: () => void): () => void {
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
}

function getRegistrySnapshot(): ActiveControllerEntry[] {
    return snapshotCache;
}

/** Snapshot of currently bound (driver, device) pairs. */
export function getActiveControllers(): ActiveControllerEntry[] {
    return snapshotCache;
}

/**
 * React hook: re-renders whenever the active-driver list changes.
 * Uses `useSyncExternalStore` for tear-free subscription semantics — the
 * previous event-bus implementation could miss publishes that happened
 * between `useState` initialisation and `useEffect` subscription.
 */
export function useActiveControllers(): ActiveControllerEntry[] {
    return useSyncExternalStore(subscribeRegistry, getRegistrySnapshot, getRegistrySnapshot);
}

// Expose a debug surface for support / dev console diagnosis.
if (typeof window !== "undefined") {
    (window as unknown as { __mmoBridge?: unknown }).__mmoBridge = {
        getActive: () => getActiveControllers(),
        version: () => snapshotVersion,
        forceRebind: () => window.dispatchEvent(new Event("mmo-controller-rebind")),
        identify: () => window.dispatchEvent(new Event("mmo-controller-identify")),
        diagnose: () => runBindDiagnostic(),
    };
}

// ── Live engine reference (kept in sync by ControllerBridge) ────────────
// Module-scoped so `runBindDiagnostic` can poke the engine directly without
// going through React. Survives StrictMode double-mount via assignment.
import type { MidiEngine } from "@/lib/midi-engine";
let liveEngine: MidiEngine | null = null;
let liveDevices: MidiDevice[] = [];
// Mirror of driversRef.current keys so the diagnostic (which lives at module
// scope, outside React) can report which device IDs the bridge has bound.
const liveDriverIds = new Set<string>();
// Telemetry for "is the bridge actually rendering?" diagnostics.
let bridgeRenderCount = 0;
let bridgeLastRenderAt = 0;
let bridgeLastEngineSeen: "null" | "set" = "null";
let bridgeMounted = false;

export interface BindDiagnosticResult {
    timestamp: number;
    engineReady: boolean;
    midiDeviceCount: number;
    driversRefSize: number;
    registrySize: number;
    snapshotVersion: number;
    bridgeMounted: boolean;
    bridgeRenderCount: number;
    bridgeLastRenderAgoMs: number;
    bridgeLastEngineSeen: "null" | "set";
    devices: Array<{
        id: string;
        name: string;
        manufacturer: string;
        hasOutput: boolean;
        outputOnly: boolean;
        inDriversRef: boolean;
        inRegistry: boolean;
        detectedDriver: string;
        rawSendOk: boolean | null; // null = not attempted
        rawSendError: string | null;
    }>;
    notes: string[];
}

/**
 * Runs an end-to-end check on the binding pipeline:
 *  1. Reports whether the engine is initialised
 *  2. Lists every device the engine knows about (bypasses React state)
 *  3. For each device with an output, fires a low-level `output.send()` of
 *     a Note Off (note 0x0B / vel 0 — universally safe) so we can prove
 *     whether the OS actually accepts MIDI writes to it.
 */
export function runBindDiagnostic(driversRefSize: number = 0): BindDiagnosticResult {
    const notes: string[] = [];
    const result: BindDiagnosticResult = {
        timestamp: Date.now(),
        engineReady: !!liveEngine,
        midiDeviceCount: 0,
        driversRefSize: driversRefSize || liveDriverIds.size,
        registrySize: activeControllers.size,
        snapshotVersion,
        bridgeMounted,
        bridgeRenderCount,
        bridgeLastRenderAgoMs: bridgeLastRenderAt ? Date.now() - bridgeLastRenderAt : -1,
        bridgeLastEngineSeen,
        devices: [],
        notes,
    };

    if (!bridgeMounted) {
        notes.push("⚠️  ControllerBridge component is NOT mounted. Either you're not on the mixer page, or React has not yet rendered the bridge. Check that <ControllerBridge /> is present in your tree and inside the same MidiProvider as ConsoleTab.");
    } else if (bridgeRenderCount === 0) {
        notes.push("⚠️  ControllerBridge mount flag is set but renderCount=0 — impossible state, likely module hot-reload duplicated the bridge module. Try a hard reload (Ctrl+Shift+R).");
    } else if (bridgeLastEngineSeen === "null") {
        notes.push("⚠️  ControllerBridge has rendered " + bridgeRenderCount + " time(s) but every render saw midi.engine=null. This means ControllerBridge resolves to a DIFFERENT MidiProvider than ConsoleTab — almost always caused by a duplicate copy of use-midi.tsx in the bundle (Next.js dynamic import boundary).");
    }

    if (!liveEngine) {
        notes.push("liveEngine is null — ControllerBridge has not yet captured the engine reference. Reload the page or wait a tick.");
        // eslint-disable-next-line no-console
        console.warn("[ControllerBridge] diagnose: engine ref not set yet");
        return result;
    }

    // Read directly from the engine — bypasses any React staleness.
    const engineDevices = liveEngine.getDevices();
    result.midiDeviceCount = engineDevices.length;
    notes.push(`Engine reports ${engineDevices.length} device(s); React state has ${liveDevices.length}.`);
    if (engineDevices.length !== liveDevices.length) {
        notes.push("⚠️  Mismatch between engine and React state — bind effect may have stale device list. Try clicking Re-bind.");
    }

    for (const device of engineDevices) {
        const detected = detectDriverForDevice(device.name) ?? new GenericMidiDriver();
        const entry: BindDiagnosticResult["devices"][number] = {
            id: device.id,
            name: device.name,
            manufacturer: device.manufacturer,
            hasOutput: !!device.output,
            outputOnly: !!device.outputOnly,
            inDriversRef: liveDriverIds.has(device.id),
            inRegistry: activeControllers.has(device.id),
            detectedDriver: detected.info.name,
            rawSendOk: null,
            rawSendError: null,
        };

        // Try a raw send to prove OS-level write capability. Note Off ch1
        // note 0x0B vel 0 is benign on every controller (matches what the
        // real driver sends to blank the play LED).
        if (device.output) {
            try {
                device.output.send(new Uint8Array([0x80, 0x0B, 0x00]));
                entry.rawSendOk = true;
            } catch (err) {
                entry.rawSendOk = false;
                entry.rawSendError = err instanceof Error ? err.message : String(err);
            }
        }

        result.devices.push(entry);
    }

    // eslint-disable-next-line no-console
    console.info("[ControllerBridge] BIND DIAGNOSTIC", result);
    return result;
}

export function ControllerBridge() {
    const midi = useMidi();
    const mixer = useMixer();

    // Map of device.id → live driver instance.
    const driversRef = useRef<Map<string, ControllerDriver>>(new Map());
    // Live mixer ref so the RAF loop reads the latest snapshot without
    // re-subscribing on every state change.
    const mixerRef = useRef(mixer);
    mixerRef.current = mixer;

    // Mirror engine + devices into module scope so `runBindDiagnostic` can
    // poke the engine without going through React. Updated every render.
    liveEngine = midi.engine;
    liveDevices = midi.devices;
    bridgeRenderCount++;
    bridgeLastRenderAt = Date.now();
    bridgeLastEngineSeen = midi.engine ? "set" : "null";
    if (process.env.NODE_ENV !== "production" && bridgeRenderCount <= 5) {
        // eslint-disable-next-line no-console
        console.info(`[ControllerBridge] render #${bridgeRenderCount}: ` +
            `engine=${midi.engine ? "OK" : "null"}, devices=${midi.devices.length}`);
    }

    // Re-export the diagnostic with the live driversRef size baked in.
    if (typeof window !== "undefined") {
        const dbg = (window as unknown as { __mmoBridge?: Record<string, unknown> }).__mmoBridge;
        if (dbg) dbg.diagnose = () => runBindDiagnostic(driversRef.current.size);
    }

    // Build the active preset (with optional overrides) once per render.
    const presetId = midi.settings.colorPresetId ?? "rekordbox-classic";
    const basePreset = getPresetById(presetId) ?? BUILTIN_COLOR_PRESETS[0];

    // ── (Re)allocate drivers when the device list changes ───────────────
    useEffect(() => {
        const engine = midi.engine;
        if (!engine) {
            // eslint-disable-next-line no-console
            console.info(`[ControllerBridge] bind effect skipped — engine not ready (devices=${midi.devices.length})`);
            return;
        }
        // eslint-disable-next-line no-console
        console.info(`[ControllerBridge] bind effect running — ${midi.devices.length} device(s), ` +
            `engine=ok, alreadyBound=${driversRef.current.size}`);
        const wantedIds = new Set<string>();
        for (const device of midi.devices) {
            if (!device.output) {
                // eslint-disable-next-line no-console
                console.info(`[ControllerBridge] skip "${device.name}" — no output port (input-only)`);
                continue;
            }
            wantedIds.add(device.id);
            if (driversRef.current.has(device.id)) {
                // Driver already exists for this device — make sure the
                // public registry mirrors driversRef in case a prior
                // unmount-cleanup wiped it without us noticing.
                if (!activeControllers.has(device.id)) {
                    const drv = driversRef.current.get(device.id)!;
                    activeControllers.set(device.id, { deviceId: device.id, deviceName: device.name, driver: drv });
                    rebuildSnapshot();
                    // eslint-disable-next-line no-console
                    console.info(`[ControllerBridge] re-registered existing driver for "${device.name}"`);
                }
                continue;
            }
            // Pick driver: explicit user choice (only meaningful when there's
            // exactly one connected device) or auto-detect from device name.
            const explicit = midi.settings.controllerDriverId
                ? createDriverById(midi.settings.controllerDriverId)
                : null;
            const driver = explicit
                ?? detectDriverForDevice(device.name)
                ?? new GenericMidiDriver();
            const overrides = midi.settings.customColors?.[driver.info.id];
            const preset = applyOverrides(basePreset, overrides);
            try {
                driver.init({ engine, deviceId: device.id, preset });
                driversRef.current.set(device.id, driver);
                liveDriverIds.add(device.id);
                activeControllers.set(device.id, { deviceId: device.id, deviceName: device.name, driver });
                rebuildSnapshot();
                // eslint-disable-next-line no-console
                console.info(`[ControllerBridge] BOUND ${driver.info.name} → "${device.name}" (id=${device.id})`);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[ControllerBridge] init failed for ${device.name}`, err);
            }
        }
        // Tear down drivers for devices that disappeared.
        for (const [id, driver] of driversRef.current.entries()) {
            if (!wantedIds.has(id)) {
                try { driver.destroy(); } catch { /* ignore */ }
                driversRef.current.delete(id);
                liveDriverIds.delete(id);
                activeControllers.delete(id);
                rebuildSnapshot();
                // eslint-disable-next-line no-console
                console.info(`[ControllerBridge] unbound (device gone) id=${id}`);
            }
        }
    }, [midi.engine, midi.devices, midi.settings.controllerDriverId, midi.settings.colorPresetId, midi.settings.customColors, basePreset]);

    // ── Push preset changes into existing drivers (no rebind needed) ────
    useEffect(() => {
        for (const [deviceId, driver] of driversRef.current.entries()) {
            const overrides = midi.settings.customColors?.[driver.info.id];
            const preset = applyOverrides(basePreset, overrides);
            try { driver.setPreset(preset); } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[ControllerBridge] setPreset failed for ${deviceId}`, err);
            }
        }
    }, [basePreset, midi.settings.customColors]);

    // ── 30 Hz pump (driver dedupes internally so this is essentially free) ──
    // The snapshot is built fresh on every tick rather than via useEffect
    // because VU levels and playback time change continuously and we want
    // them on the controller without waiting for React to re-render.
    useEffect(() => {
        let alive = true;
        let lastTick = 0;
        const TICK_MS = 1000 / 30;
        const scratch = new Uint8Array(512);

        function tick(ts: number) {
            if (!alive) return;
            if (ts - lastTick >= TICK_MS) {
                lastTick = ts;
                const m = mixerRef.current;
                if (m && driversRef.current.size > 0) {
                    const vuA = sampleAnalyserVu(m.getDeckAnalyser("A"), scratch);
                    const vuB = sampleAnalyserVu(m.getDeckAnalyser("B"), scratch);
                    const vuC = sampleAnalyserVu(m.getDeckAnalyser("C"), scratch);
                    const vuD = sampleAnalyserVu(m.getDeckAnalyser("D"), scratch);
                    const vuMaster = sampleAnalyserVu(m.getMasterAnalyser(), scratch);
                    // Live currentTime — DeckState.currentTime is React-throttled.
                    const tA = m.getDeckCurrentTime?.("A") ?? m.deckA.currentTime;
                    const tB = m.getDeckCurrentTime?.("B") ?? m.deckB.currentTime;
                    const tC = m.getDeckCurrentTime?.("C") ?? m.deckC.currentTime;
                    const tD = m.getDeckCurrentTime?.("D") ?? m.deckD.currentTime;
                    const snap: DriverMixerState = {
                        decks: {
                            A: { ...deckSlice(m.deckA, vuA), currentTime: tA },
                            B: { ...deckSlice(m.deckB, vuB), currentTime: tB },
                            C: { ...deckSlice(m.deckC, vuC), currentTime: tC },
                            D: { ...deckSlice(m.deckD, vuD), currentTime: tD },
                        },
                        crossfader: m.crossfader,
                        masterVolume: m.masterVolume,
                        headphoneMix: m.headphoneMix,
                        isRecording: m.isRecording,
                        beatFxOn: !!(m.deckA.beatFxOn || m.deckB.beatFxOn),
                        masterVuLevel: vuMaster,
                    };
                    for (const driver of driversRef.current.values()) {
                        try { driver.applyState(snap); } catch (err) {
                            // eslint-disable-next-line no-console
                            console.warn("[ControllerBridge] applyState failed", err);
                        }
                    }
                }
            }
            requestAnimationFrame(tick);
        }
        const id = requestAnimationFrame(tick);
        return () => {
            alive = false;
            cancelAnimationFrame(id);
        };
    }, []);

    // ── On unmount, blank every controller ──────────────────────────────
    useEffect(() => {
        bridgeMounted = true;
        // eslint-disable-next-line no-console
        console.info(`[ControllerBridge] mounted (renderCount=${bridgeRenderCount})`);
        const drivers = driversRef.current;
        return () => {
            bridgeMounted = false;
            // eslint-disable-next-line no-console
            console.info("[ControllerBridge] unmounted");
            for (const [id, driver] of drivers.entries()) {
                try { driver.destroy(); } catch { /* ignore */ }
                activeControllers.delete(id);
                liveDriverIds.delete(id);
            }
            drivers.clear();
            rebuildSnapshot();
        };
    }, []);

    // ── Identify-all listener (LED test from settings UI) ───────────────
    useEffect(() => {
        function onIdentify() {
            const drivers = Array.from(driversRef.current.values());
            // eslint-disable-next-line no-console
            console.info(`[ControllerBridge] identify event → ${drivers.length} driver(s)`,
                drivers.map(d => d.info.name));
            if (drivers.length === 0) {
                // eslint-disable-next-line no-console
                console.warn("[ControllerBridge] no drivers bound. " +
                    "Check that your controller is connected and shows in the Console tab list.");
            }
            for (const driver of drivers) {
                if (!driver.runIdentifyAnimation) {
                    // eslint-disable-next-line no-console
                    console.warn(`[ControllerBridge] ${driver.info.name} has no identify animation`);
                    continue;
                }
                try { driver.runIdentifyAnimation(); } catch (err) {
                    // eslint-disable-next-line no-console
                    console.error(`[ControllerBridge] identify failed for ${driver.info.name}`, err);
                }
            }
        }
        window.addEventListener("mmo-controller-identify", onIdentify);
        return () => window.removeEventListener("mmo-controller-identify", onIdentify);
    }, []);

    // ── Force-rebind listener (Console tab "Re-bind" button) ────────────
    // Tears down every active driver and re-runs the bind effect by
    // bumping a local refresh counter via the midi engine refresh.
    useEffect(() => {
        function onRebind() {
            // eslint-disable-next-line no-console
            console.info(`[ControllerBridge] force re-bind requested — destroying ${driversRef.current.size} driver(s)`);
            for (const [id, driver] of driversRef.current.entries()) {
                try { driver.destroy(); } catch { /* ignore */ }
                activeControllers.delete(id);
            }
            driversRef.current.clear();
            liveDriverIds.clear();
            rebuildSnapshot();
            // Trigger a MIDI refresh — this re-emits onDeviceChange which
            // updates `midi.devices` and re-runs the bind effect.
            void midi.refreshDevices();
        }
        window.addEventListener("mmo-controller-rebind", onRebind);
        return () => window.removeEventListener("mmo-controller-rebind", onRebind);
    }, [midi]);

    return null;
}

/** Force every driver to tear down and rebind from the current device list. */
export function rebindAllControllers(): void {
    window.dispatchEvent(new Event("mmo-controller-rebind"));
}

/** Run an "identify" animation on every active driver. */
export function identifyAllControllers(): void {
    window.dispatchEvent(new Event("mmo-controller-identify"));
}

/** Read-only helper for the UI: which device-id mapped to which driver. */
export function listConnectedControllers(devices: MidiDevice[]) {
    return devices
        .filter(d => d.output)
        .map(d => {
            const driver = detectDriverForDevice(d.name) ?? new GenericMidiDriver();
            return { device: d, info: driver.info };
        });
}
