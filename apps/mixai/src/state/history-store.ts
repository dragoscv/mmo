/**
 * Play history: which tracks were actually played, and when. Feeds the library ("played"
 * rows are dimmed, smart crate "not played tonight") and nothing else.
 *
 * A track counts as played once a deck has played it for `PLAYED_AFTER_SEC` seconds in total
 * (loading or cueing a track is not playing it). Persisted to localStorage `mixai-history`
 * (track id -> last played, epoch ms; newest `MAX_ENTRIES` kept).
 */
import { create } from "zustand";
import type { DeckId } from "../bridge/types.ts";
import { useMixerStore } from "./mixer-store.ts";

export const PLAYED_AFTER_SEC = 30;
/** "Tonight" = the last 12 hours (a set that crosses midnight is still one night). */
export const TONIGHT_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;
const KEY = "mixai-history";

export type PlayedMap = Record<string, number>;

/** Parse persisted history; anything malformed is dropped entry by entry. */
export function parseHistory(raw: unknown): PlayedMap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PlayedMap = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (k && typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
}

/** Add `trackId` at `at`, keeping only the newest `max` entries. */
export function withPlayed(map: PlayedMap, trackId: string, at: number, max = MAX_ENTRIES): PlayedMap {
    const next: PlayedMap = { ...map, [trackId]: at };
    const ids = Object.keys(next);
    if (ids.length <= max) return next;
    ids.sort((a, b) => next[b]! - next[a]!);
    const kept: PlayedMap = {};
    for (const id of ids.slice(0, max)) kept[id] = next[id]!;
    return kept;
}

/** True when `playedAt` (epoch ms, or undefined = never) falls within "tonight" as of `now`. */
export function playedTonight(playedAt: number | undefined, now: number): boolean {
    return playedAt !== undefined && now - playedAt >= 0 && now - playedAt <= TONIGHT_MS;
}

/**
 * Per-deck accumulator: feed it every snapshot; it returns the track id the moment that track
 * has accumulated `PLAYED_AFTER_SEC` of playback on that deck (once per load), else null.
 * Time is wall-clock between snapshots, capped at 1 s so a stalled UI never counts as playback.
 */
export function makePlayTracker(threshold = PLAYED_AFTER_SEC) {
    const acc = new Map<DeckId, { trackId: string; sec: number; last: number; done: boolean }>();
    return (deck: DeckId, trackId: string | null, playing: boolean, now: number): string | null => {
        if (!trackId) {
            acc.delete(deck);
            return null;
        }
        let a = acc.get(deck);
        if (!a || a.trackId !== trackId) {
            a = { trackId, sec: 0, last: now, done: false };
            acc.set(deck, a);
        }
        const dt = Math.min(1, Math.max(0, (now - a.last) / 1000));
        a.last = now;
        if (!playing || a.done) return null;
        a.sec += dt;
        if (a.sec < threshold) return null;
        a.done = true;
        return trackId;
    };
}

function load(): PlayedMap {
    try {
        return parseHistory(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    } catch {
        return {};
    }
}

interface HistoryStore {
    /** Track id (`DeckState.trackId`) -> last played, epoch ms. */
    played: PlayedMap;
    mark: (trackId: string, at?: number) => void;
    clear: () => void;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
    played: typeof localStorage === "undefined" ? {} : load(),
    mark: (trackId, at = Date.now()) => {
        const played = withPlayed(get().played, trackId, at);
        set({ played });
        try {
            localStorage.setItem(KEY, JSON.stringify(played));
        } catch {
            // storage unavailable
        }
    },
    clear: () => {
        set({ played: {} });
        try {
            localStorage.removeItem(KEY);
        } catch {
            // storage unavailable
        }
    },
}));

/** Record played tracks from the engine snapshots. Returns the unsubscribe function. */
export function startPlayHistory(): () => void {
    const track = makePlayTracker();
    return useMixerStore.subscribe((s, prev) => {
        if (s.decks === prev.decks) return;
        const now = Date.now();
        for (const d of s.decks) {
            const hit = track(d.id, d.loaded ? d.trackId : null, d.playing, now);
            if (hit) useHistoryStore.getState().mark(hit, now);
        }
    });
}
