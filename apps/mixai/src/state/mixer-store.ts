/**
 * Zustand store mirroring the canonical mixer state from the Rust core.
 *
 * The Rust audio thread owns the truth. The UI:
 *   1. reads an initial snapshot via `engine.getState()`,
 *   2. subscribes to throttled `mixer://state` events for meters/transport,
 *   3. issues commands optimistically, then reconciles on the next event.
 */

import { create } from "zustand";
import type { DeckId, DeckState, MixerState } from "@/bridge/types";

function emptyDeck(id: DeckId): DeckState {
    return {
        id,
        trackId: null,
        title: null,
        artist: null,
        loaded: false,
        playing: false,
        position: 0,
        duration: 0,
        bpm: 0,
        tempo: 1,
        keyLock: true,
        volume: 0.85,
        eqLow: 0,
        eqMid: 0,
        eqHigh: 0,
        filter: 0,
        crossfaderAssign: id === "a" || id === "c" ? "a" : "b",
        cue: false,
        vu: 0,
        hotCues: [null, null, null, null, null, null, null, null],
        loopActive: false,
        loopStart: 0,
        loopEnd: 0,
        firstBeat: 0,
        hasStems: false,
        stemsActive: false,
        stemGains: [1, 1, 1, 1],
        fxKind: 0,
        fxWet: 0,
        fxBeats: 0.5,
    };
}

const initialState: MixerState = {
    crossfader: 0,
    crossfaderCurve: "smooth",
    masterVolume: 0.85,
    cueVolume: 0.7,
    masterVu: 0,
    decks: [emptyDeck("a"), emptyDeck("b"), emptyDeck("c"), emptyDeck("d")],
    sampleRate: 48000,
    latencyMs: 0,
};

interface MixerStore extends MixerState {
    native: boolean;
    setNative: (v: boolean) => void;
    /** Replace the whole snapshot (from a core event or getState). */
    hydrate: (s: MixerState) => void;
    /** Patch a single deck locally (optimistic UI). */
    patchDeck: (id: DeckId, patch: Partial<DeckState>) => void;
    /** Patch the mixer bus locally (optimistic UI). */
    patchMixer: (patch: Partial<MixerState>) => void;
    deck: (id: DeckId) => DeckState;
    /** Per-deck downsampled waveform peaks (0..1), set on track load. */
    waveforms: Record<DeckId, number[]>;
    setWaveform: (id: DeckId, peaks: number[]) => void;
    /** Per-deck Camelot key (transient; not in the Rust snapshot). */
    deckKeys: Record<DeckId, string | null>;
    setDeckKey: (id: DeckId, key: string | null) => void;
}

export const useMixerStore = create<MixerStore>((set, get) => ({
    ...initialState,
    native: false,
    setNative: (v) => set({ native: v }),
    hydrate: (s) => set({ ...s }),
    patchDeck: (id, patch) =>
        set((state) => ({
            decks: state.decks.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        })),
    patchMixer: (patch) => set(patch),
    deck: (id) => get().decks.find((d) => d.id === id) ?? emptyDeck(id),
    waveforms: { a: [], b: [], c: [], d: [] },
    setWaveform: (id, peaks) =>
        set((state) => ({ waveforms: { ...state.waveforms, [id]: peaks } })),
    deckKeys: { a: null, b: null, c: null, d: null },
    setDeckKey: (id, key) =>
        set((state) => ({ deckKeys: { ...state.deckKeys, [id]: key } })),
}));
