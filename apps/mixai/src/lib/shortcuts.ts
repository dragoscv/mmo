/**
 * Keyboard shortcuts — pro-grade deck control from the laptop keyboard, no
 * controller required. The left-hand cluster drives Deck A, the right-hand
 * cluster Deck B (a layout DJs coming from Serato/rekordbox will recognize).
 *
 * Each binding documents its key + label so the same table can drive both the
 * live key handler and the on-screen cheat-sheet overlay.
 */

import type { DeckId } from "@/bridge/types";

export interface Shortcut {
    /** `KeyboardEvent.code` to match (layout-independent). */
    code: string;
    /** Human-readable key label for the overlay (e.g. "Q", "Space"). */
    keyLabel: string;
    /** What the shortcut does (overlay description). */
    label: string;
    /** Deck this binding targets, or null for global. */
    deck: DeckId | null;
    /** Action identifier handled by the dispatcher. */
    action: ShortcutAction;
    /** Optional numeric argument (e.g. hot-cue slot, nudge direction). */
    arg?: number;
}

export type ShortcutAction =
    | "play"
    | "cue"
    | "sync"
    | "nudge"
    | "loopToggle"
    | "hotcue"
    | "crossfaderTo"
    | "crossfaderCenter"
    | "toggleHelp";

/** Group label used to organize the overlay cheat-sheet. */
export interface ShortcutGroup {
    title: string;
    items: Shortcut[];
}

const deckA: Shortcut[] = [
    { code: "KeyQ", keyLabel: "Q", label: "Play / Pause", deck: "a", action: "play" },
    { code: "KeyA", keyLabel: "A", label: "Cue", deck: "a", action: "cue" },
    { code: "KeyS", keyLabel: "S", label: "Sync", deck: "a", action: "sync" },
    { code: "KeyZ", keyLabel: "Z", label: "Nudge back", deck: "a", action: "nudge", arg: -1 },
    { code: "KeyX", keyLabel: "X", label: "Nudge forward", deck: "a", action: "nudge", arg: 1 },
    { code: "KeyW", keyLabel: "W", label: "Loop on/off", deck: "a", action: "loopToggle" },
    { code: "Digit1", keyLabel: "1", label: "Hot-cue 1", deck: "a", action: "hotcue", arg: 0 },
    { code: "Digit2", keyLabel: "2", label: "Hot-cue 2", deck: "a", action: "hotcue", arg: 1 },
    { code: "Digit3", keyLabel: "3", label: "Hot-cue 3", deck: "a", action: "hotcue", arg: 2 },
    { code: "Digit4", keyLabel: "4", label: "Hot-cue 4", deck: "a", action: "hotcue", arg: 3 },
];

const deckB: Shortcut[] = [
    { code: "KeyP", keyLabel: "P", label: "Play / Pause", deck: "b", action: "play" },
    { code: "Semicolon", keyLabel: ";", label: "Cue", deck: "b", action: "cue" },
    { code: "KeyL", keyLabel: "L", label: "Sync", deck: "b", action: "sync" },
    { code: "Comma", keyLabel: ",", label: "Nudge back", deck: "b", action: "nudge", arg: -1 },
    { code: "Period", keyLabel: ".", label: "Nudge forward", deck: "b", action: "nudge", arg: 1 },
    { code: "KeyO", keyLabel: "O", label: "Loop on/off", deck: "b", action: "loopToggle" },
    { code: "Digit7", keyLabel: "7", label: "Hot-cue 1", deck: "b", action: "hotcue", arg: 0 },
    { code: "Digit8", keyLabel: "8", label: "Hot-cue 2", deck: "b", action: "hotcue", arg: 1 },
    { code: "Digit9", keyLabel: "9", label: "Hot-cue 3", deck: "b", action: "hotcue", arg: 2 },
    { code: "Digit0", keyLabel: "0", label: "Hot-cue 4", deck: "b", action: "hotcue", arg: 3 },
];

const global: Shortcut[] = [
    { code: "ArrowLeft", keyLabel: "←", label: "Crossfade to A", deck: null, action: "crossfaderTo", arg: -1 },
    { code: "ArrowRight", keyLabel: "→", label: "Crossfade to B", deck: null, action: "crossfaderTo", arg: 1 },
    { code: "ArrowDown", keyLabel: "↓", label: "Center crossfader", deck: null, action: "crossfaderCenter" },
    { code: "Slash", keyLabel: "?", label: "Toggle this help", deck: null, action: "toggleHelp" },
];

/** Cheat-sheet groups for the overlay. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
    { title: "Deck A", items: deckA },
    { title: "Deck B", items: deckB },
    { title: "Mixer", items: global },
];

/** Flat lookup by `KeyboardEvent.code`. */
export const SHORTCUTS_BY_CODE: ReadonlyMap<string, Shortcut> = new Map(
    [...deckA, ...deckB, ...global].map((s) => [s.code, s]),
);

/** Every default shortcut, flattened (deck A, deck B, global). */
export const ALL_SHORTCUTS: readonly Shortcut[] = [...deckA, ...deckB, ...global];

/** Stable identity for a binding, independent of which key is bound to it.
 *  Used to persist user remaps so they survive default-key changes. */
export function shortcutId(s: Pick<Shortcut, "action" | "deck" | "arg">): string {
    return `${s.action}:${s.deck ?? ""}:${s.arg ?? ""}`;
}

/** Lookup a default shortcut by its stable id. */
export const SHORTCUTS_BY_ID: ReadonlyMap<string, Shortcut> = new Map(
    ALL_SHORTCUTS.map((s) => [shortcutId(s), s]),
);

/** Pretty label for a `KeyboardEvent.code` (e.g. `KeyQ`→`Q`, `Digit1`→`1`). */
export function codeLabel(code: string): string {
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    switch (code) {
        case "Semicolon":
            return ";";
        case "Comma":
            return ",";
        case "Period":
            return ".";
        case "Slash":
            return "?";
        case "ArrowLeft":
            return "←";
        case "ArrowRight":
            return "→";
        case "ArrowUp":
            return "↑";
        case "ArrowDown":
            return "↓";
        case "Space":
            return "Space";
        default:
            return code;
    }
}
