/**
 * Client-side play recorder (WP11-02). Debounces `recordTrackPlay` calls
 * from the player so a rapid skip burst produces one insert per track and
 * a natural end / ≥90 % listen is flagged `completed`. Fire-and-forget:
 * failures are swallowed (localStorage history is the fallback).
 */
import { recordTrackPlay } from "@/actions/track-plays";

export const COMPLETED_RATIO = 0.9;
const DEBOUNCE_MS = 1500;
/** Ignore accidental taps — nothing under this is a "play". */
const MIN_LISTEN_SEC = 5;

export interface PlayEvent {
    trackId: number;
    /** Seconds listened. */
    listenedSec: number;
    /** Total duration when known. */
    durationSec?: number | null;
    /** Natural end of the media element. */
    ended?: boolean;
}

export function isCompleted(e: PlayEvent): boolean {
    if (e.ended) return true;
    if (!e.durationSec || e.durationSec <= 0) return false;
    return e.listenedSec / e.durationSec >= COMPLETED_RATIO;
}

type Recorder = (input: { trackId: number; durationSec?: number; completed: boolean; source: "web" }) => Promise<unknown>;

export function createPlayRecorder(record: Recorder = recordTrackPlay, debounceMs = DEBOUNCE_MS) {
    const pending = new Map<number, ReturnType<typeof setTimeout>>();
    const flush = (e: PlayEvent) => {
        pending.delete(e.trackId);
        if (e.listenedSec < MIN_LISTEN_SEC && !e.ended) return;
        void record({
            trackId: e.trackId,
            durationSec: Math.round(e.listenedSec),
            completed: isCompleted(e),
            source: "web",
        }).catch(() => { /* offline / signed-out — localStorage history still has it */ });
    };
    return {
        /** Called on track end (immediate) or on switch (debounced per track). */
        push(e: PlayEvent) {
            const prev = pending.get(e.trackId);
            if (prev) clearTimeout(prev);
            if (e.ended) { flush(e); return; }
            pending.set(e.trackId, setTimeout(() => flush(e), debounceMs));
        },
        /** Cancel everything (unmount). */
        dispose() {
            for (const t of pending.values()) clearTimeout(t);
            pending.clear();
        },
    };
}
