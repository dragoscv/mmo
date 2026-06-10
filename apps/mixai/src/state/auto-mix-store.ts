/**
 * Auto-mix orchestration — a frontend-only "AI DJ" that beat-matches and
 * crossfades between the two main decks without manual intervention.
 *
 * The Rust core owns audio truth; this store only *drives* it through the same
 * public engine commands a human would use (play / sync / setCrossfader). It
 * watches deck transport via the regular `mixer://state` snapshot (reflected in
 * the mixer store) and, when the playing deck nears its end, syncs the other
 * deck, starts it, and ramps the crossfader across over a configurable time.
 *
 * Nothing here touches the audio thread directly, so auto-mix is safe, fully
 * cancellable, and degrades gracefully if a deck isn't loaded.
 */

import { create } from "zustand";
import { engine } from "@/bridge/engine";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { useMixerStore } from "./mixer-store";
import { loadLibraryTrack } from "@/lib/load-track";
import { parseCamelot, transitionScore } from "@/lib/harmonic";

/** Which two decks auto-mix alternates between (the classic A/B battle). */
const A: DeckId = "a";
const B: DeckId = "b";

export interface AutoMixState {
    /** Master on/off. */
    enabled: boolean;
    /** Crossfade duration in seconds. */
    crossfadeSec: number;
    /** Trigger the transition this many seconds before the track ends. */
    leadSec: number;
    /** Beat-sync the incoming deck before starting it. */
    autoSync: boolean;
    /** Auto-load the best harmonic match from the library onto the idle deck. */
    autoQueue: boolean;
    /** Live status line for the UI. */
    status: string;
    /** The deck currently considered "on air" (its fade-out triggers a mix). */
    onAir: DeckId;
    /** True while a crossfade ramp is in flight (guards re-entry). */
    mixing: boolean;
}

interface AutoMixStore extends AutoMixState {
    setEnabled: (v: boolean) => void;
    setCrossfadeSec: (v: number) => void;
    setLeadSec: (v: number) => void;
    setAutoSync: (v: boolean) => void;
    setAutoQueue: (v: boolean) => void;
    /** Candidate pool for auto-queue (kept in sync by the library browser). */
    setPool: (tracks: LibraryTrack[]) => void;
    /** Called on every mixer snapshot tick to advance the state machine. */
    tick: () => void;
    /** Force the next transition immediately (the "skip / mix now" button). */
    mixNow: () => void;
}

/** Crossfader target for a given on-air deck: A = -1, B = +1. */
function faderFor(deck: DeckId): number {
    return deck === A ? -1 : 1;
}

export const useAutoMixStore = create<AutoMixStore>((set, get) => {
    let rampTimer: ReturnType<typeof setInterval> | null = null;
    // Candidate pool + the ids we've already auto-loaded this session, so the
    // set keeps moving forward instead of looping the same two tracks.
    let pool: LibraryTrack[] = [];
    const played = new Set<string>();

    function stopRamp() {
        if (rampTimer) {
            clearInterval(rampTimer);
            rampTimer = null;
        }
    }

    /**
     * Pick the best harmonic match from the pool for the given reference deck,
     * excluding tracks already loaded/played. Returns null when nothing fits.
     */
    function pickNext(refKey: string | null, refBpm: number): LibraryTrack | null {
        if (pool.length === 0) return null;
        const from = { key: parseCamelot(refKey), bpm: refBpm };
        const mixer = useMixerStore.getState();
        const loadedIds = new Set(
            mixer.decks.map((d) => d.trackId).filter((id): id is string => id != null),
        );
        let best: LibraryTrack | null = null;
        let bestScore = -1;
        for (const t of pool) {
            const id = String(t.id);
            if (loadedIds.has(id) || played.has(id)) continue;
            const score = transitionScore(from, {
                key: parseCamelot(t.keyCamelot),
                bpm: t.bpm ?? 0,
            }).score;
            if (score > bestScore) {
                bestScore = score;
                best = t;
            }
        }
        return best;
    }

    /** Smoothly drive the crossfader from its current value to `to` over `sec`. */
    function rampCrossfader(to: number, sec: number, onDone: () => void) {
        stopRamp();
        const mixer = useMixerStore.getState();
        const from = mixer.crossfader;
        const steps = Math.max(1, Math.round(sec * 30)); // ~30 Hz
        let i = 0;
        rampTimer = setInterval(() => {
            i += 1;
            const t = Math.min(1, i / steps);
            // easeInOutSine for a musical, non-linear blend.
            const eased = 0.5 - Math.cos(Math.PI * t) / 2;
            const v = from + (to - from) * eased;
            useMixerStore.getState().patchMixer({ crossfader: v });
            void engine.setCrossfader(v);
            if (t >= 1) {
                stopRamp();
                onDone();
            }
        }, 1000 / 30);
    }

    /** Kick off a transition from the on-air deck to the other deck. */
    async function startTransition() {
        const { onAir, crossfadeSec, autoSync, autoQueue } = get();
        const other: DeckId = onAir === A ? B : A;
        const mixer = useMixerStore.getState();
        let incoming = mixer.deck(other);

        // Autonomous set building: if the idle deck is empty (or auto-queue is
        // on and it's a leftover), load the best harmonic match before mixing.
        if (!incoming.loaded && autoQueue) {
            const onAirDeck = mixer.deck(onAir);
            const next = pickNext(useMixerStore.getState().deckKeys[onAir], onAirDeck.bpm);
            if (next) {
                set({ status: `Queuing ${next.title ?? next.filename}…` });
                played.add(String(next.id));
                await loadLibraryTrack(other, next);
                incoming = useMixerStore.getState().deck(other);
            }
        }

        if (!incoming.loaded) {
            set({
                status: autoQueue
                    ? "Auto-queue: no matching track in the library"
                    : `Load a track on deck ${other.toUpperCase()} to continue`,
                mixing: false,
            });
            return;
        }

        set({ mixing: true, status: `Mixing → deck ${other.toUpperCase()}…` });

        // Beat-match the incoming deck to the on-air deck, then start it.
        if (autoSync) {
            try {
                await engine.sync(other);
            } catch {
                /* sync is best-effort */
            }
        }
        try {
            await engine.play(other);
        } catch {
            /* ignore */
        }

        rampCrossfader(faderFor(other), crossfadeSec, () => {
            // Transition complete: pause the now-silent outgoing deck and flip on-air.
            void engine.pause(onAir);
            set({ onAir: other, mixing: false, status: `On air: deck ${other.toUpperCase()}` });
            // Pre-load the *next* match onto the freed deck so it's ready early.
            if (get().autoQueue) {
                const m = useMixerStore.getState();
                const next = pickNext(m.deckKeys[other], m.deck(other).bpm);
                if (next) {
                    played.add(String(next.id));
                    void loadLibraryTrack(onAir, next);
                }
            }
        });
    }

    return {
        enabled: false,
        crossfadeSec: 8,
        leadSec: 12,
        autoSync: true,
        autoQueue: false,
        status: "Auto-mix idle",
        onAir: A,
        mixing: false,

        setEnabled: (enabled) => {
            if (enabled) {
                // Adopt whichever main deck is currently playing as "on air".
                const mixer = useMixerStore.getState();
                const aPlaying = mixer.deck(A).playing;
                const bPlaying = mixer.deck(B).playing;
                const onAir: DeckId = bPlaying && !aPlaying ? B : A;
                set({ enabled, onAir, status: `Auto-mix armed · on air: deck ${onAir.toUpperCase()}` });
            } else {
                stopRamp();
                set({ enabled, mixing: false, status: "Auto-mix idle" });
            }
        },
        setCrossfadeSec: (crossfadeSec) => set({ crossfadeSec }),
        setLeadSec: (leadSec) => set({ leadSec }),
        setAutoSync: (autoSync) => set({ autoSync }),
        setAutoQueue: (autoQueue) => set({ autoQueue }),
        setPool: (tracks) => {
            pool = tracks;
        },

        tick: () => {
            const { enabled, mixing, onAir, leadSec } = get();
            if (!enabled || mixing) return;
            const deck = useMixerStore.getState().deck(onAir);
            if (!deck.loaded || !deck.playing || deck.duration <= 0) return;
            const remaining = deck.duration - deck.position;
            if (remaining <= leadSec) {
                void startTransition();
            }
        },

        mixNow: () => {
            const { enabled, mixing } = get();
            if (!enabled || mixing) return;
            void startTransition();
        },
    };
});
