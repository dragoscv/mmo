/**
 * Store access for the deck panel. The engine snapshot replaces a playing deck's object ~30 times
 * a second (position, vu), so a component must never select the whole deck: it selects exactly
 * the values it shows and re-renders only when one of THOSE changes.
 */
import { useRef } from "react";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { sameDeckExcept } from "./format";

/**
 * One value picked (or derived) from one deck. Return a primitive (compared with `Object.is`):
 * a rounded number or a formatted string changes far less often than the field it comes from.
 */
export function useDeckValue<T>(deckId: DeckId, pick: (deck: DeckState) => T): T {
    return useMixerStore((s) => pick(s.deck(deckId)));
}

/** The deck as it is right now, for event handlers (no subscription). */
export function deckNow(deckId: DeckId): DeckState {
    return useMixerStore.getState().deck(deckId);
}

/**
 * The deck object, kept IDENTICAL while only the `ignore`d fields change. For children that take
 * a `deck` prop but do not show those fields (the tab bodies and `position` / `vu`): they stop
 * re-rendering at snapshot rate. The ignored fields of the returned object may be stale.
 */
export function useDeckSteady(deckId: DeckId, ignore: readonly (keyof DeckState)[]): DeckState {
    const last = useRef<DeckState | null>(null);
    return useMixerStore((s) => {
        const deck = s.deck(deckId);
        const prev = last.current;
        if (prev && sameDeckExcept(prev, deck, ignore)) return prev;
        last.current = deck;
        return deck;
    });
}
