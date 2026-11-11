/**
 * Three-band waveform per deck (low < 250 Hz, mid, high > 4 kHz), 150 points per second,
 * peak amplitude 0..255 per point. Computed in Rust at load time (`compute_band_peaks`) and
 * fetched once per loaded track as raw bytes:
 *
 *   [u32 LE pointsPerSecond][u32 LE len][low: len bytes][mid: len bytes][high: len bytes]
 *
 * Point `i` covers source time [i / pps, (i + 1) / pps), so `index = floor(sec * pps)`.
 * Used by the scrolling waveforms (waves panel), the overview strips and the library preview.
 */
import { create } from "zustand";
import { engine } from "../bridge/engine.ts";
import type { DeckId } from "../bridge/types.ts";
import { useMixerStore } from "./mixer-store.ts";

export interface BandWave {
    /** Points per second. */
    pps: number;
    /** Points in every lane. */
    len: number;
    low: Uint8Array;
    mid: Uint8Array;
    high: Uint8Array;
    /** `DeckState.trackId` the wave was fetched for. */
    trackId: string | null;
}

/** Parse the wire form; null when the buffer is empty, truncated or inconsistent. */
export function parseBandWave(buf: ArrayBuffer | null | undefined, trackId: string | null): BandWave | null {
    if (!buf || buf.byteLength < 8) return null;
    const view = new DataView(buf);
    const pps = view.getUint32(0, true);
    const len = view.getUint32(4, true);
    if (pps === 0 || len === 0 || buf.byteLength !== 8 + 3 * len) return null;
    const bytes = new Uint8Array(buf, 8);
    return {
        pps,
        len,
        low: bytes.subarray(0, len),
        mid: bytes.subarray(len, 2 * len),
        high: bytes.subarray(2 * len, 3 * len),
        trackId,
    };
}

/** Max of lane values in [from, to) (point indices, clamped); 0 for an empty range. */
export function lanePeak(lane: Uint8Array, from: number, to: number): number {
    const a = Math.max(0, Math.floor(from));
    const b = Math.min(lane.length, Math.max(a + 1, Math.ceil(to)));
    let m = 0;
    for (let i = a; i < b; i++) if (lane[i]! > m) m = lane[i]!;
    return m;
}

/** Peak lanes of the separated stems on a deck; same point grid as the deck's `BandWave`. */
export interface StemLanes {
    pps: number;
    len: number;
    /** [vocals, drums, bass, melody]; null = that stem is not loaded. */
    lanes: [Uint8Array | null, Uint8Array | null, Uint8Array | null, Uint8Array | null];
    trackId: string | null;
}

/**
 * Parse `deck_stem_lanes`: `[u32 LE pps][u32 LE len][u32 LE mask]` then four lanes of `len`
 * bytes (bit `i` of `mask` = stem `i` loaded). Null when empty, truncated or without stems.
 */
export function parseStemLanes(buf: ArrayBuffer | null | undefined, trackId: string | null): StemLanes | null {
    if (!buf || buf.byteLength < 12) return null;
    const view = new DataView(buf);
    const pps = view.getUint32(0, true);
    const len = view.getUint32(4, true);
    const mask = view.getUint32(8, true);
    if (pps === 0 || len === 0 || (mask & 0b1111) === 0 || buf.byteLength !== 12 + 4 * len) return null;
    const bytes = new Uint8Array(buf, 12);
    const lane = (i: number) => ((mask >> i) & 1 ? bytes.subarray(i * len, (i + 1) * len) : null);
    return { pps, len, lanes: [lane(0), lane(1), lane(2), lane(3)], trackId };
}

/**
 * Decode a library track's overview peaks (analyzer sidecar: Int16 LE, interleaved
 * `[min, max]` pairs) into `bins` amplitudes 0..255 (max of |min|, |max| per bin).
 * Null when the buffer is empty or malformed.
 */
export function parseOverviewPeaks(buf: ArrayBuffer | null | undefined, bins: number): Uint8Array | null {
    if (!buf || buf.byteLength < 4 || buf.byteLength % 4 !== 0 || bins <= 0) return null;
    const view = new DataView(buf);
    const pairs = buf.byteLength / 4;
    const n = Math.min(Math.floor(bins), pairs);
    const out = new Uint8Array(n);
    for (let b = 0; b < n; b++) {
        const from = Math.floor((b * pairs) / n);
        const to = Math.max(from + 1, Math.floor(((b + 1) * pairs) / n));
        let peak = 0;
        for (let p = from; p < to && p < pairs; p++) {
            const lo = Math.abs(view.getInt16(p * 4, true));
            const hi = Math.abs(view.getInt16(p * 4 + 2, true));
            if (lo > peak) peak = lo;
            if (hi > peak) peak = hi;
        }
        out[b] = Math.min(255, Math.round((peak / 32768) * 255));
    }
    return out;
}

/** Bins kept per library preview (one per 1–2 px of the preview column). */
export const PREVIEW_BINS = 240;
const PREVIEW_CACHE_MAX = 600;
const previewCache = new Map<number, Promise<Uint8Array | null>>();

/**
 * Overview peaks of a library track for the preview column (`PREVIEW_BINS` values 0..255),
 * fetched once and cached (LRU, 600 tracks). Resolves null when the track is not analysed.
 * A failed fetch is not cached, so the row retries the next time it is shown.
 */
export function loadTrackPreview(trackId: number): Promise<Uint8Array | null> {
    const hit = previewCache.get(trackId);
    if (hit) {
        // Refresh recency.
        previewCache.delete(trackId);
        previewCache.set(trackId, hit);
        return hit;
    }
    const p = engine
        .companionTrackPeaks(trackId)
        .then((buf) => parseOverviewPeaks(buf, PREVIEW_BINS))
        .catch(() => {
            previewCache.delete(trackId);
            return null;
        });
    previewCache.set(trackId, p);
    if (previewCache.size > PREVIEW_CACHE_MAX) {
        const oldest = previewCache.keys().next().value;
        if (oldest !== undefined) previewCache.delete(oldest);
    }
    return p;
}

interface WaveStore {
    bands: Record<DeckId, BandWave | null>;
    setBands: (deck: DeckId, wave: BandWave | null) => void;
    stems: Record<DeckId, StemLanes | null>;
    setStems: (deck: DeckId, lanes: StemLanes | null) => void;
}

export const useWaveStore = create<WaveStore>((set) => ({
    bands: { a: null, b: null, c: null, d: null },
    setBands: (deck, wave) => set((s) => ({ bands: { ...s.bands, [deck]: wave } })),
    stems: { a: null, b: null, c: null, d: null },
    setStems: (deck, lanes) => set((s) => ({ stems: { ...s.stems, [deck]: lanes } })),
}));

const DECKS: readonly DeckId[] = ["a", "b", "c", "d"];

/**
 * Keep the band waves in step with the decks. Returns the unsubscribe function.
 *
 * - First time a deck is seen loaded (app start, UI reload, pop-out window while the engine
 *   already holds a track): fetch.
 * - A load finished (the loader stored the mono peaks): fetch. Not earlier: between the
 *   optimistic metadata patch and the end of the decode the engine still holds the previous
 *   track's wave.
 * - A load started (peaks cleared) or the deck was emptied: clear.
 * - The track on a loaded deck changed without a load in this window (a pop-out window has its
 *   own store and never sees the loader's peaks; so does any load path that skips
 *   `setWaveform`): fetch for the new track.
 *
 * `fetchWave` is the engine call; tests pass a fake.
 */
export function startWaveSync(fetchWave: (deck: DeckId) => Promise<ArrayBuffer | null> = (deck) => engine.waveformBands(deck)): () => void {
    const inFlight = new Set<DeckId>();
    const seenLoaded = new Set<DeckId>();
    /** `trackId` the last fetch was started for. */
    const fetchedFor = new Map<DeckId, string | null>();
    /** A fetch was asked for while one was in flight: run it again when that one ends. */
    const again = new Set<DeckId>();
    /** Decks with a load in progress in THIS window (peaks cleared), and the track being loaded. */
    const loading = new Map<DeckId, string | null>();
    let stopped = false;
    const deckNow = (deck: DeckId) => useMixerStore.getState().deck(deck);
    /** The deck holds another track than the one we fetched for, and no load here explains it. */
    const stale = (deck: DeckId) => {
        const d = deckNow(deck);
        return d.loaded && !loading.has(deck) && fetchedFor.has(deck) && d.trackId !== fetchedFor.get(deck);
    };
    const fetchBands = (deck: DeckId) => {
        if (inFlight.has(deck)) {
            again.add(deck);
            return;
        }
        inFlight.add(deck);
        const trackId = deckNow(deck).trackId;
        fetchedFor.set(deck, trackId);
        fetchWave(deck)
            .then((buf) => {
                // The track changed while we were fetching: drop the wave (refetched below).
                if (stopped || deckNow(deck).trackId !== trackId) return;
                useWaveStore.getState().setBands(deck, parseBandWave(buf, trackId));
            })
            .catch(() => undefined)
            .finally(() => {
                inFlight.delete(deck);
                if (stopped) return;
                const asked = again.delete(deck);
                if ((asked && deckNow(deck).loaded) || stale(deck)) fetchBands(deck);
            });
    };
    // Stem lanes follow `hasStems` (set by the engine once `load_stems` finished).
    const stemsFor = new Map<DeckId, string | null>();
    const syncStems = (s: ReturnType<typeof useMixerStore.getState>) => {
        for (const id of DECKS) {
            const d = s.decks.find((x) => x.id === id);
            const want = d?.loaded && d.hasStems ? d.trackId : undefined;
            if (want === undefined) {
                stemsFor.delete(id);
                if (useWaveStore.getState().stems[id]) useWaveStore.getState().setStems(id, null);
                continue;
            }
            if (stemsFor.has(id) && stemsFor.get(id) === want) continue;
            stemsFor.set(id, want);
            engine
                .stemLanes(id)
                .then((buf) => {
                    const now = useMixerStore.getState().deck(id);
                    if (!now.hasStems || now.trackId !== want) return;
                    useWaveStore.getState().setStems(id, parseStemLanes(buf, want));
                })
                .catch(() => stemsFor.delete(id));
        }
    };
    type Mixer = ReturnType<typeof useMixerStore.getState>;
    const sync = (s: Mixer, prev: Mixer | null) => {
        for (const id of DECKS) {
            const loaded = s.decks.find((d) => d.id === id)?.loaded === true;
            if (!loaded) {
                seenLoaded.delete(id);
                loading.delete(id);
                if (useWaveStore.getState().bands[id]) useWaveStore.getState().setBands(id, null);
                continue;
            }
            if (prev && s.waveforms[id] !== prev.waveforms[id]) {
                seenLoaded.add(id);
                if (s.waveforms[id].length > 0) {
                    loading.delete(id);
                    fetchBands(id);
                } else {
                    loading.set(id, s.decks.find((d) => d.id === id)?.trackId ?? null);
                    if (useWaveStore.getState().bands[id]) useWaveStore.getState().setBands(id, null);
                }
                continue;
            }
            if (!seenLoaded.has(id)) {
                seenLoaded.add(id);
                // A load in progress (peaks just cleared by the loader) fetches when it ends.
                if (!prev || s.waveforms[id] === prev.waveforms[id]) fetchBands(id);
                continue;
            }
            const trackId = s.decks.find((d) => d.id === id)?.trackId ?? null;
            if (!prev || trackId === prev.decks.find((d) => d.id === id)?.trackId) continue;
            // A track that is neither the one we hold nor the one being loaded here came from
            // somewhere else (another window): the load here, if any, is over.
            if (loading.has(id) && trackId !== loading.get(id) && trackId !== fetchedFor.get(id)) loading.delete(id);
            // Decide after the current task: the loader patches the metadata and clears the peaks
            // in two steps, and only the second one says "a load is in progress here".
            queueMicrotask(() => {
                if (!stopped && stale(id)) fetchBands(id);
            });
        }
    };
    sync(useMixerStore.getState(), null);
    syncStems(useMixerStore.getState());
    const off = useMixerStore.subscribe((s, prev) => {
        // The 30 Hz snapshot replaces `decks`; only react to what matters here.
        if (s.decks === prev.decks && s.waveforms === prev.waveforms) return;
        sync(s, prev);
        syncStems(s);
    });
    return () => {
        stopped = true;
        off();
    };
}
