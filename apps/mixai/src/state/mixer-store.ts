/**
 * Zustand store mirroring the canonical mixer state from the Rust core.
 *
 * The Rust audio thread owns the truth. The UI:
 *   1. reads an initial snapshot via `engine.getState()`,
 *   2. subscribes to throttled `mixer://state` events for meters/transport,
 *   3. issues commands optimistically, then reconciles on the next event.
 */

import { create } from "zustand";
import type { DeckId, DeckState, MixerState } from "../bridge/types.ts";

function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
        return true;
    }
    return false;
}

function sameDeck(a: DeckState, b: DeckState): boolean {
    const ka = Object.keys(a) as (keyof DeckState)[];
    if (ka.length !== Object.keys(b).length) return false;
    for (const k of ka) if (!sameValue(a[k], b[k])) return false;
    return true;
}

/**
 * Structural sharing for the engine snapshot (~30 per second): a deck whose values did not
 * change keeps its previous object, and when no deck changed the previous array is kept. So a
 * component that selects one deck re-renders only when THAT deck changed, and an idle app
 * renders nothing (measured 2026-11-10: an idle window used a whole CPU core re-rendering
 * every panel 30 times a second).
 */
export function shareDecks(prev: readonly DeckState[], next: readonly DeckState[]): DeckState[] {
    let changed = prev.length !== next.length;
    const out = next.map((d, i) => {
        const p = prev[i];
        if (p && p.id === d.id && sameDeck(p, d)) return p;
        changed = true;
        return d;
    });
    return changed ? out : (prev as DeckState[]);
}

/** The fields of `next` that differ from `prev` (decks shared structurally); null = nothing changed. */
export function snapshotPatch(prev: MixerState, next: MixerState): Partial<MixerState> | null {
    const patch: Record<string, unknown> = {};
    let any = false;
    for (const k of Object.keys(next) as (keyof MixerState)[]) {
        const v = k === "decks" ? shareDecks(prev.decks, next.decks) : next[k];
        if (sameValue(prev[k], v)) continue;
        patch[k] = v;
        any = true;
    }
    return any ? (patch as Partial<MixerState>) : null;
}

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

/** One empty deck per id: `deck()` must return the same object while a deck is missing. */
const EMPTY_DECKS: Record<DeckId, DeckState> = { a: emptyDeck("a"), b: emptyDeck("b"), c: emptyDeck("c"), d: emptyDeck("d") };

const initialState: MixerState = {
    crossfader: 0,
    crossfaderCurve: "smooth",
    masterVolume: 0.85,
    cueVolume: 0.7,
    masterVu: 0,
    decks: [emptyDeck("a"), emptyDeck("b"), emptyDeck("c"), emptyDeck("d")],
    sampleRate: 48000,
    latencyMs: 0,
    dspLoad: 0,
    overruns: 0,
};

interface MixerStore extends MixerState {
    native: boolean;
    setNative: (v: boolean) => void;
    /** True once the first engine snapshot (or the "no engine" verdict) arrived. */
    hydrated: boolean;
    setHydrated: () => void;
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
    hydrated: false,
    setHydrated: () => set({ hydrated: true }),
    hydrate: (s) => {
        const patch = snapshotPatch(get(), s);
        if (patch) set(get().hydrated ? patch : { ...patch, hydrated: true });
        else if (!get().hydrated) set({ hydrated: true });
    },
    patchDeck: (id, patch) =>
        set((state) => ({
            decks: state.decks.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        })),
    patchMixer: (patch) => set(patch),
    deck: (id) => get().decks.find((d) => d.id === id) ?? EMPTY_DECKS[id],
    waveforms: { a: [], b: [], c: [], d: [] },
    setWaveform: (id, peaks) =>
        set((state) => ({ waveforms: { ...state.waveforms, [id]: peaks } })),
    deckKeys: { a: null, b: null, c: null, d: null },
    setDeckKey: (id, key) =>
        set((state) => ({ deckKeys: { ...state.deckKeys, [id]: key } })),
}));
