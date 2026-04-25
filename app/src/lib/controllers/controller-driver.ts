"use client";

/**
 * Abstract DJ Controller Driver
 *
 * A driver translates the high-level mixer state (deck play, hot cues,
 * loop, pad mode, …) into device-specific MIDI / SysEx output so that the
 * physical controller's LEDs, screens and motorised parts reflect the
 * software state in real time.
 *
 * One driver instance = one physical device. Drivers receive both the
 * MidiEngine handle (to send messages) and the MIDI device id to address.
 *
 * Drivers are intentionally state-diffing: they remember the last frame
 * they pushed and only emit MIDI for changed values, so we can call
 * `applyState()` 60+ times per second cheaply.
 */

import type { MidiEngine } from "@/lib/midi-engine";
import type { ColorPreset, ColorRole } from "./color-presets";
import type { DeckSide, PadMode } from "@/lib/mixer-engine";

// ─── Public types ────────────────────────────────────────────────────────

/** Per-deck state slice the driver actually needs (subset of DeckState). */
export interface DriverDeckState {
    isPlaying: boolean;
    isCueing: boolean;
    syncEnabled: boolean;
    loopEnabled: boolean;
    headphoneCue: boolean;
    padMode: PadMode;
    hotCues: (number | null)[];     // 8 entries; null = empty
    bpm: number;
    pitch: number;
    keyLock: boolean;
    /** True when a track is loaded — drives the "cue is set" LED. */
    isLoaded: boolean;
    /** Playback position in seconds (used for end-of-track flashing). */
    currentTime: number;
    /** Track length in seconds. */
    duration: number;
    /** Slip-mode toggle. */
    slipMode: boolean;
    /** Beat-grid quantize toggle. */
    quantize: boolean;
    /** Per-deck VU level in 0..1, sampled from the deck analyser. */
    vuLevel: number;
    /** Beat-FX (master FX bus) routed to this deck. */
    beatFxOn: boolean;
}

/** Mixer-wide state the driver may use for VU LEDs, FX LEDs, etc. */
export interface DriverMixerState {
    decks: { A: DriverDeckState; B: DriverDeckState; C?: DriverDeckState; D?: DriverDeckState };
    crossfader: number;             // 0..1
    masterVolume: number;            // 0..1
    headphoneMix: number;            // 0..1
    isRecording: boolean;
    beatFxOn: boolean;
    /** Master output VU in 0..1, sampled from the master analyser. */
    masterVuLevel: number;
}

export interface ControllerDriverContext {
    /** MidiEngine to send messages through. */
    engine: MidiEngine;
    /** MIDI output device id (engine's `MidiDevice.id`). */
    deviceId: string;
    /** Active color preset. */
    preset: ColorPreset;
}

export interface ControllerDriverInfo {
    /** Stable id (slug). */
    id: string;
    /** Vendor + model display name. */
    name: string;
    /** Vendor brand. */
    vendor: string;
    /** Regex matched against MidiDevice.name to auto-detect this driver. */
    deviceNameMatch: RegExp;
    /** Capabilities flags shown in the UI. */
    capabilities: {
        rgbHotCues: boolean;
        rgbPadModes: boolean;
        screen: boolean;
        jogDisplay: boolean;
        motorisedJog: boolean;
        vuMeters: boolean;
    };
    /** Human-readable description. */
    description: string;
}

/** Concrete driver implementation. */
export interface ControllerDriver {
    readonly info: ControllerDriverInfo;
    /** Bind the driver to a device + send the initial LED snapshot. */
    init(ctx: ControllerDriverContext): void;
    /** Tear down: turn LEDs off, release any timers. */
    destroy(): void;
    /** Push the latest mixer state — driver emits diffs only. */
    applyState(state: DriverMixerState): void;
    /** Switch color preset live. */
    setPreset(preset: ColorPreset): void;
    /** Briefly flash all LEDs (used as "test" button in the UI). */
    runIdentifyAnimation?(): void;
}

// ─── Base class with common helpers ──────────────────────────────────────

export abstract class BaseControllerDriver implements ControllerDriver {
    abstract readonly info: ControllerDriverInfo;

    protected ctx: ControllerDriverContext | null = null;
    protected lastState: DriverMixerState | null = null;
    /** Per-LED last-sent value cache: key = "ch:note", value = velocity. */
    protected ledCache = new Map<string, number>();

    init(ctx: ControllerDriverContext): void {
        this.ctx = ctx;
        this.ledCache.clear();
        this.lastState = null;
        this.onInit();
    }

    destroy(): void {
        try {
            this.onDestroy();
        } finally {
            this.ctx = null;
            this.ledCache.clear();
            this.lastState = null;
        }
    }

    applyState(state: DriverMixerState): void {
        if (!this.ctx) return;
        this.onApplyState(state, this.lastState);
        this.lastState = state;
    }

    setPreset(preset: ColorPreset): void {
        if (!this.ctx) return;
        this.ctx = { ...this.ctx, preset };
        // Force full re-push on next apply
        this.ledCache.clear();
        if (this.lastState) {
            const snapshot = this.lastState;
            this.lastState = null;
            this.applyState(snapshot);
        }
    }

    /** Override for one-time setup (e.g. SysEx handshake, set deck colours). */
    protected onInit(): void { /* no-op */ }
    /** Override to turn off LEDs / release SysEx. */
    protected onDestroy(): void {
        if (!this.ctx) return;
        // Default: blank every LED we touched.
        for (const key of this.ledCache.keys()) {
            const [chStr, noteStr] = key.split(":");
            const ch = Number(chStr);
            const note = Number(noteStr);
            if (Number.isFinite(ch) && Number.isFinite(note)) {
                this.sendNote(ch, note, 0);
            }
        }
    }
    /** Override to push state diffs (compare `state` to `prev`). */
    protected abstract onApplyState(state: DriverMixerState, prev: DriverMixerState | null): void;

    // ── Wire helpers ────────────────────────────────────────────────────

    /** Send Note On with caching — duplicate values are dropped. */
    protected sendNote(channel: number, note: number, velocity: number): void {
        if (!this.ctx) return;
        const key = `${channel}:${note}`;
        const v = Math.max(0, Math.min(127, velocity | 0));
        if (this.ledCache.get(key) === v) return;
        this.ledCache.set(key, v);
        this.ctx.engine.sendNoteOn(this.ctx.deviceId, channel, note, v);
    }

    protected sendCC(channel: number, cc: number, value: number): void {
        if (!this.ctx) return;
        const v = Math.max(0, Math.min(127, value | 0));
        const key = `cc:${channel}:${cc}`;
        if (this.ledCache.get(key) === v) return;
        this.ledCache.set(key, v);
        this.ctx.engine.sendCC(this.ctx.deviceId, channel, cc, v);
    }

    /**
     * Send a raw MIDI message (no caching). Use for SysEx wake-up /
     * keep-alive / handshake messages that controllers like Pioneer DDJ
     * require before they accept LED commands.
     */
    protected sendRaw(data: number[]): void {
        if (!this.ctx) return;
        this.ctx.engine.sendToDevice(this.ctx.deviceId, data);
    }

    /** Force-refresh: drop cache so the next apply re-sends every LED. */
    protected invalidateCache(): void {
        this.ledCache.clear();
    }

    protected colorOf(role: ColorRole): string {
        if (!this.ctx) return "#000000";
        return this.ctx.preset.colors[role] ?? "#000000";
    }

    protected brightness(): number {
        return this.ctx?.preset.brightness ?? 1;
    }
}

// ─── Identity / "off" driver ─────────────────────────────────────────────

/** Fallback driver used when no matching device-specific driver is found. */
export class GenericMidiDriver extends BaseControllerDriver {
    readonly info: ControllerDriverInfo = {
        id: "generic-midi",
        name: "Generic MIDI",
        vendor: "Generic",
        deviceNameMatch: /.*/,
        capabilities: {
            rgbHotCues: false,
            rgbPadModes: false,
            screen: false,
            jogDisplay: false,
            motorisedJog: false,
            vuMeters: false,
        },
        description: "Default driver for unrecognised controllers — accepts MIDI in but does not push LED feedback.",
    };

    protected onApplyState(): void {
        // No-op: we don't know how to talk to this device.
    }
}
