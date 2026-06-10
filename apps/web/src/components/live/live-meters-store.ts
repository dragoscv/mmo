"use client";

/**
 * LiveMetersStore — external store for high-frequency meter/tuner data.
 *
 * Why: the LiveEngine tickMeters() loop runs at ~30-60Hz to update peak meters,
 * tuner, recording duration and backing position. Funnelling those updates
 * through React context would re-render every `useLive()` consumer (15+ on the
 * /live page) every frame and pin the page at ~60fps even when idle.
 *
 * Solution: keep the realtime fields in a tiny mutable singleton-per-provider
 * store and let only the components that *display* meters subscribe via
 * `useSyncExternalStore`. The main `useLive()` context value can then stay
 * referentially stable across meter ticks.
 */

import { useSyncExternalStore } from "react";

export interface LiveMetersSnapshot {
    masterPeakL: number;
    masterPeakR: number;
    isLimiting: boolean;
    voicePeakL: number;
    voicePeakR: number;
    voiceRms: number;
    tunerNote: string;
    tunerNoteIndex: number;
    tunerCents: number;
    tunerFrequency: number;
    tunerConfidence: number;
    /** When auto-correct is active, the MIDI note the corrector is steering
     *  the input towards. -1 when auto-correct is off or no target. */
    autoCorrectTargetMidi: number;
    /** When auto-correct is active, the actively detected source MIDI note
     *  in continuous fractional MIDI. NaN when no detection. */
    autoCorrectSourceMidi: number;
    /** True while the engine's internal auto-correct loop is running. */
    autoCorrectActive: boolean;
    recordingDuration: number;
    backingPosition: number;
    /** ── Native (companion) engine mirror ─────────────────────────────
     *  Populated when the user has switched the Voice Processor to a
     *  companion-side input device. Allows VoicePanel to render meters /
     *  perf without owning the WebSocket subscription itself. */
    nativeRunning: boolean;
    /** True when a companion process was discovered on this host. Mirrors
     *  KeyScalePanel's local `nativeAvailable` so the VoicePanel toggle
     *  can disable itself when no companion is reachable. */
    nativeAvailable: boolean;
    /** Last error from a native start attempt, or null when none. */
    nativeError: string | null;
    /** Stream latency reported by the engine (ms). 0 when not running. */
    nativeMetricsLatencyMs: number;
    /** DSP block average reported by the engine (ms). 0 when not running. */
    nativeMetricsDspAvgMs: number;
    nativeInPeak: number;
    nativeOutPeak: number;
    nativeInRms: number;
    nativeOutRms: number;
    nativeStreamLatencyMs: number;
    nativeDspAvgMs: number;
    nativeDspMaxMs: number;
    nativeUnderruns: number;
    /** Sample rate the native engine actually negotiated with the audio
     *  device. May differ from the requested value when the driver
     *  doesn't support it. 0 when not running. */
    nativeSampleRate: number;
    /** Frame size the native engine actually negotiated. Drives the
     *  block latency calc (frameSize / sampleRate * 1000). 0 when not
     *  running. */
    nativeFrameSize: number;
    /** RtAudio backend in use (e.g. "WASAPI", "ASIO", "CoreAudio",
     *  "ALSA"). Empty string when not running. */
    nativeBackend: string;
    /** How long the native stream has been running, in seconds. Derived
     *  from callback count * frame size / sample rate so it tracks the
     *  actual audio thread, not wall-clock. 0 when not running. */
    nativeUptimeSec: number;
    /** True while the browser tab serving this page is hidden / minimised.
     *  When true, browser-side audio (backing, loopers, pads, instrument)
     *  may glitch on lower-end CPUs even with the keep-alive source. The
     *  Performance widget surfaces this so the user knows it's not the
     *  native engine misbehaving. */
    documentHidden: boolean;
    /** Whether the native engine was started in exclusive mode. WASAPI
     *  shared mode (the default) routes through the Windows audio engine
     *  and is sensitive to focus changes; exclusive mode bypasses the
     *  mixer and is focus-independent. The Performance card surfaces a
     *  hint when this is OFF and the backend is WASAPI. */
    nativeExclusiveMode: boolean;
}

const EMPTY: LiveMetersSnapshot = {
    masterPeakL: 0,
    masterPeakR: 0,
    isLimiting: false,
    voicePeakL: 0,
    voicePeakR: 0,
    voiceRms: 0,
    tunerNote: "—",
    tunerNoteIndex: -1,
    tunerCents: 0,
    tunerFrequency: 0,
    tunerConfidence: 0,
    autoCorrectTargetMidi: -1,
    autoCorrectSourceMidi: NaN,
    autoCorrectActive: false,
    recordingDuration: 0,
    backingPosition: 0,
    nativeRunning: false,
    nativeAvailable: false,
    nativeError: null,
    nativeMetricsLatencyMs: 0,
    nativeMetricsDspAvgMs: 0,
    nativeInPeak: 0,
    nativeOutPeak: 0,
    nativeInRms: 0,
    nativeOutRms: 0,
    nativeStreamLatencyMs: 0,
    nativeDspAvgMs: 0,
    nativeDspMaxMs: 0,
    nativeUnderruns: 0,
    nativeSampleRate: 0,
    nativeFrameSize: 0,
    nativeBackend: "",
    nativeUptimeSec: 0,
    documentHidden: false,
    nativeExclusiveMode: false,
};

class MetersStore {
    private snapshot: LiveMetersSnapshot = EMPTY;
    private listeners = new Set<() => void>();

    subscribe = (cb: () => void) => {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    };

    getSnapshot = () => this.snapshot;

    /** Replace snapshot atomically and notify subscribers. Merges with the
     *  existing snapshot so side-channel fields (e.g. native engine mirror
     *  written by patch()) are preserved when the main meter loop ticks. */
    publish(next: Partial<LiveMetersSnapshot>) {
        this.snapshot = { ...this.snapshot, ...next };
        for (const cb of this.listeners) cb();
    }

    /** Merge a partial snapshot atomically. Used by side-channel updaters
     *  (companion levels) that only own a subset of the fields and must
     *  not stomp on the values published by the main meter loop. */
    patch(part: Partial<LiveMetersSnapshot>) {
        this.snapshot = { ...this.snapshot, ...part };
        for (const cb of this.listeners) cb();
    }

    reset() {
        this.snapshot = EMPTY;
        for (const cb of this.listeners) cb();
    }
}

// Module-level singleton — there is at most one LiveProvider per page.
export const liveMetersStore = new MetersStore();

/** Subscribe to the full meters snapshot. */
export function useLiveMeters(): LiveMetersSnapshot {
    return useSyncExternalStore(liveMetersStore.subscribe, liveMetersStore.getSnapshot, liveMetersStore.getSnapshot);
}

/**
 * Subscribe to a single primitive field of the meters snapshot. The selector
 * MUST return a primitive (number/string/boolean) for `useSyncExternalStore`
 * referential equality to work — wrapping object selectors will cause infinite
 * re-renders.
 */
export function useLiveMetersField<T extends number | string | boolean | null>(
    selector: (s: LiveMetersSnapshot) => T,
): T {
    return useSyncExternalStore(
        liveMetersStore.subscribe,
        () => selector(liveMetersStore.getSnapshot()),
        () => selector(liveMetersStore.getSnapshot()),
    );
}
