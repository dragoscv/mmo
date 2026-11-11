/**
 * Crossfader curve and per-deck crossfader side: wiring of `xfader-core.ts` to the real store
 * and engine.
 *
 * The engine reports both in its snapshot (`MixerState.crossfaderCurve`,
 * `DeckState.crossfaderAssign`) and changes them with
 *
 *   engine.setCrossfaderCurve(curve: "linear" | "smooth" | "sharp")      -> `set_crossfader_curve`
 *   engine.setCrossfaderAssign(deck: DeckId, assign: "a" | "thru" | "b") -> `deck_set_crossfader_assign`
 *
 * Both are optimistic and fail soft: the store is patched at once, and when the engine refuses
 * (an executable older than the commands answers "command not found") the previous value comes
 * back. A refusal is logged once per kind, not once per click.
 */
import { engine } from "@/bridge/engine";
import type { DeckId } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { makeXfader, type XfAssign, type XfCurve } from "./xfader-core";

export type { XfAssign, XfCurve };

const live = makeXfader({
    getCurve: () => useMixerStore.getState().crossfaderCurve,
    putCurve: (curve) => useMixerStore.getState().patchMixer({ crossfaderCurve: curve }),
    getAssign: (deck) => useMixerStore.getState().deck(deck).crossfaderAssign,
    putAssign: (deck, assign) => useMixerStore.getState().patchDeck(deck, { crossfaderAssign: assign }),
    sendCurve: (curve) => engine.setCrossfaderCurve(curve),
    sendAssign: (deck, assign) => engine.setCrossfaderAssign(deck, assign),
    warn: (what, err) => console.warn(`[mixai] crossfader ${what} was not applied by the engine`, err),
});

export function setCurve(curve: XfCurve): void {
    void live.setCurve(curve);
}

export function setAssign(deck: DeckId, assign: XfAssign): void {
    void live.setAssign(deck, assign);
}
