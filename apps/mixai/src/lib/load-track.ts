/**
 * Hook-free helper to load a companion (muzicai.ro) library track onto a deck.
 *
 * Shared by the Library browser (user clicks A/B) and the auto-mix auto-queue
 * (loads the next harmonic match onto the idle deck). Reads/writes the mixer
 * store via `getState()` so it can run outside React.
 */

import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";

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
