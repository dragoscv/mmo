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
};

class MetersStore {
    private snapshot: LiveMetersSnapshot = EMPTY;
    private listeners = new Set<() => void>();

    subscribe = (cb: () => void) => {
        this.listeners.add(cb);
        return () => { this.listeners.delete(cb); };
    };

    getSnapshot = () => this.snapshot;

    /** Replace snapshot atomically and notify subscribers. */
    publish(next: LiveMetersSnapshot) {
        this.snapshot = next;
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
export function useLiveMetersField<T extends number | string | boolean>(
    selector: (s: LiveMetersSnapshot) => T,
): T {
    return useSyncExternalStore(
        liveMetersStore.subscribe,
        () => selector(liveMetersStore.getSnapshot()),
        () => selector(liveMetersStore.getSnapshot()),
    );
}
