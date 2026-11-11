/**
 * Hook-free helper to load a companion (mixai.ro) library track onto a deck.
 *
 * Shared by the Library browser (user clicks A/B) and the auto-mix auto-queue
 * (loads the next harmonic match onto the idle deck). Reads/writes the mixer
 * store via `getState()` so it can run outside React.
 */

import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { parseBandWave, useWaveStore } from "@/state/wave-store";

/**
 * After a load the engine rejected: the deck still holds its previous track, but the loader
 * emptied the peaks first, which makes the wave sync drop the deck's band wave and wait for peaks
 * that never come. A caller that saved the peaks puts them back (the sync then fetches the wave
 * itself); when there were none to save (the track was loaded before a UI reload, or by another
 * window) this takes a fresh engine snapshot (the optimistic metadata of the failed load goes
 * away with it) and fetches the wave of the track the engine holds. `current()` = false when a
 * newer load owns the deck. Never rejects.
 */
export async function restoreDeckWave(deck: DeckId, current: () => boolean = () => true): Promise<void> {
    try {
        const snap = await engine.getState();
        if (!snap || !current()) return;
        useMixerStore.getState().hydrate(snap);
        const held = snap.decks.find((d) => d.id === deck);
        if (!held?.loaded) return;
        const buf = await engine.waveformBands(deck);
        const store = useMixerStore.getState();
        // A newer load, another track, or peaks that came back (the sync fetches then): not ours.
        if (!current() || store.deck(deck).trackId !== held.trackId || store.waveforms[deck].length > 0) return;
        useWaveStore.getState().setBands(deck, parseBandWave(buf, held.trackId));
    } catch {
        // The wave stays empty until the next load; the failed load itself is reported by the caller.
    }
}

/**
 * Load `t` onto `deck`: optimistic metadata, decode (local first, stream
 * fallback), waveform peaks, Camelot key, and auto-attached stems when ready.
 */
export async function loadLibraryTrack(deck: DeckId, t: LibraryTrack): Promise<void> {
    const store = useMixerStore.getState();
    const title = t.title ?? t.filename;
    const artist = t.artist ?? "Unknown";

    store.patchDeck(deck, {
        trackId: String(t.id),
        title,
        artist,
        bpm: t.bpm ?? 0,
        loaded: true,
        position: 0,
    });
    store.setWaveform(deck, []);
    store.setDeckKey(deck, t.keyCamelot ?? null);

    let peaks: number[] | null = null;
    try {
        peaks = await engine.loadTrack({
            deck,
            source: t.filepath,
            trackId: String(t.id),
            title,
            artist,
            bpm: t.bpm ?? 0,
        });
    } catch {
        peaks = await engine.loadTrackStream({
            deck,
            trackId: t.id,
            title,
            artist,
            bpm: t.bpm ?? 0,
        });
    }
    if (peaks) store.setWaveform(deck, peaks);

    if (t.stemsStatus === "ready") {
        try {
            const s = await engine.companionTrackStems(t.id);
            if (s && (s.vocals || s.drums || s.bass || s.melody)) {
                await engine.loadStems(deck, {
                    vocals: s.vocals,
                    drums: s.drums,
                    bass: s.bass,
                    melody: s.melody,
                });
            }
        } catch {
            /* stems are best-effort */
        }
    }
}
