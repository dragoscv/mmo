/**
 * Wires global keyboard shortcuts to engine actions. Mounted once at the app
 * root. Ignores keystrokes while the user is typing in an input/textarea/select
 * or an editable element so library search and settings fields keep working.
 */

import { useEffect } from "react";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { matchShortcut, type Shortcut } from "@/lib/shortcuts";
import { useKeybindStore } from "@/state/keybind-store";
import { usePerfStore } from "@/state/perf-store";

/** True when focus is in a field where typing should win over shortcuts. */
function isEditableTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Nudge a deck by a small relative seek (beat-matching feel). */
async function nudge(deck: Shortcut["deck"], dir: number): Promise<void> {
    if (!deck) return;
    const d = useMixerStore.getState().deck(deck);
    if (!d.loaded) return;
    const next = Math.max(0, Math.min(d.duration, d.position + dir * 0.05));
    await engine.seek(deck, next);
}

async function dispatch(s: Shortcut, shift = false): Promise<void> {
    const ui = useUiStore.getState();
    switch (s.action) {
        case "toggleHelp":
            ui.setShortcutsOpen(!ui.shortcutsOpen);
            return;
        case "crossfaderTo":
            await engine.setCrossfader(s.arg ?? 0);
            return;
        case "crossfaderCenter":
            await engine.setCrossfader(0);
            return;
        default:
            break;
    }

    if (!s.deck) return;
    const deck = useMixerStore.getState().deck(s.deck);
    switch (s.action) {
        case "play":
            await (deck.playing ? engine.pause(s.deck) : engine.play(s.deck));
            return;
        case "cue":
            await engine.setCue(s.deck, !deck.cue);
            return;
        case "sync":
            // Tap = phase sync to the master clock; Shift = toggle sync lock.
            if (shift) {
                const perf = usePerfStore.getState();
                perf.setSyncLock(s.deck, !perf.decks[s.deck].syncLock);
            } else {
                usePerfStore.getState().phaseSync(s.deck);
            }
            return;
        case "loopToggle":
            await engine.loopToggle(s.deck);
            return;
        case "nudge":
            await nudge(s.deck, s.arg ?? 0);
            return;
        case "hotcue":
            await engine.jumpHotCue(s.deck, s.arg ?? 0);
            return;
        default:
            return;
    }
}

export function useShortcuts(): void {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // A control that used the key (list, slider, radio group) called preventDefault: the
            // key is not a shortcut then. Modifier combos pass through to the OS / browser.
            const s = matchShortcut(e, isEditableTarget(e.target), useKeybindStore.getState().bindings);
            if (!s) return;
            e.preventDefault();
            void dispatch(s, e.shiftKey);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}
