/**
 * Transient sampler-pad metadata. The actual audio buffers live in the native
 * audio engine (mixai-core); this store only mirrors the UI-visible pad state
 * (label, loaded flag, looping, gain). Persisted pad assignments are a future
 * (account-sync) follow-up.
 */

import { create } from "zustand";

export const NUM_PADS = 8;

export interface SamplerPad {
    /** Display label (filename stem), or null when empty. */
    label: string | null;
    loaded: boolean;
    looping: boolean;
    /** Gain 0..1.5. */
    gain: number;
    /** Local source path (for re-trigger / inspection). */
    path: string | null;
}

function emptyPad(): SamplerPad {
    return { label: null, loaded: false, looping: false, gain: 0.85, path: null };
}

interface SamplerStore {
    pads: SamplerPad[];
    setPad: (idx: number, patch: Partial<SamplerPad>) => void;
}

export const useSamplerStore = create<SamplerStore>((set) => ({
    pads: Array.from({ length: NUM_PADS }, emptyPad),
    setPad: (idx, patch) =>
        set((s) => {
            const pads = s.pads.slice();
            const cur = pads[idx] ?? emptyPad();
            pads[idx] = { ...cur, ...patch };
            return { pads };
        }),
}));
