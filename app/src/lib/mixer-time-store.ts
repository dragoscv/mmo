/**
 * Per-deck "live time" pub-sub store — kept completely outside React state.
 *
 * Why this exists
 * ───────────────
 * The mixer engine emits a `currentTime` update ~4×/s per deck during
 * playback. If that value flows through `useState`/`useReducer` it forces
 * `MixerProvider` to re-render, which re-renders `MixerView` and every
 * non-memoised child (or any child whose `mixer` context object changed).
 *
 * The debug telemetry showed 400+ renders over 6 minutes on idle playback —
 * exactly tracking the time-update rate. The fix is to stop treating
 * `currentTime` as React state and expose it via `useSyncExternalStore`
 * so only the tiny leaf components that render a clock (DeckInfo time
 * label, JogWheel progress ring) re-render when it ticks.
 *
 * Everyone else either reads the live time inside their own rAF loop via
 * `getDeckTime(side)` / `engine.getCurrentTime()`, or doesn't need it.
 */

import { useSyncExternalStore } from "react";
import type { DeckSide } from "./mixer-engine";

type Listener = () => void;

// Per-deck scalar time (in seconds). Plain object, mutable.
const times: Record<DeckSide, number> = { A: 0, B: 0, C: 0, D: 0 };

// Per-deck listener sets — keeping them segregated means setting deck A's
// time does NOT wake subscribers attached to deck B/C/D.
const listeners: Record<DeckSide, Set<Listener>> = {
    A: new Set(), B: new Set(), C: new Set(), D: new Set(),
};

/** Write a new time for the deck and wake only that deck's subscribers. */
export function setDeckTime(deck: DeckSide, time: number) {
    // Skip redundant writes — the engine's throttled emitter can re-emit
    // the same value across seek/pause transitions.
    if (times[deck] === time) return;
    times[deck] = time;
    const set = listeners[deck];
    for (const l of set) {
        try { l(); } catch { /* never let a bad subscriber kill the loop */ }
    }
}

/** Read the latest time without subscribing — safe to call in event handlers. */
export function getDeckTime(deck: DeckSide): number {
    return times[deck];
}

/** Force-set all deck times to 0 (used on mixer destroy). */
export function resetAllDeckTimes() {
    (Object.keys(times) as DeckSide[]).forEach((d) => setDeckTime(d, 0));
}

function subscribeFactory(deck: DeckSide) {
    return (cb: Listener) => {
        listeners[deck].add(cb);
        return () => { listeners[deck].delete(cb); };
    };
}

// Pre-built stable subscribe functions — `useSyncExternalStore` relies on
// referential stability of the subscribe callback, so we must NOT recreate
// it per render.
const subs: Record<DeckSide, (cb: Listener) => () => void> = {
    A: subscribeFactory("A"),
    B: subscribeFactory("B"),
    C: subscribeFactory("C"),
    D: subscribeFactory("D"),
};

const snapshots: Record<DeckSide, () => number> = {
    A: () => times.A,
    B: () => times.B,
    C: () => times.C,
    D: () => times.D,
};

/**
 * React hook — subscribes the calling component to time updates for the
 * given deck only. Uses `useSyncExternalStore` so it is concurrent-safe
 * and tear-free under React 18/19.
 */
export function useDeckCurrentTime(deck: DeckSide): number {
    return useSyncExternalStore(subs[deck], snapshots[deck], snapshots[deck]);
}
