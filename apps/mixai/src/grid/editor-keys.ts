/**
 * Keyboard and text-entry logic of the grid editor's marker rows (WP19-37).
 *
 * Kept out of the component (there is no DOM test harness here) so `node --test` can cover
 * the behaviour that kept breaking: the row swallowing keys typed in its own BPM input, and
 * the BPM field snapping back while a value is half-typed.
 */

import { BPM_STEP, isValidBpm } from "./markers.ts";

/** Keyboard / button nudge step in seconds (Shift = coarse). */
export const NUDGE_SEC = 0.005;
export const NUDGE_COARSE_SEC = 0.05;

/** What a key pressed on a marker row should do. */
export type MarkerRowAction =
    | { kind: "nudge"; deltaSec: number }
    | { kind: "retune"; deltaBpm: number }
    | { kind: "remove" };

/**
 * True when the event was raised by the row itself, not by a control inside it.
 *
 * Without this check the row's `onKeyDown` also sees keys bubbling from the BPM input, so
 * Backspace deleted the whole marker and the arrow keys moved it while the user was editing
 * the number.
 */
export function isRowEvent(target: unknown, currentTarget: unknown): boolean {
    return target === currentTarget;
}

/** Row action for `key` (`null` = not ours, let the browser handle it). */
export function markerRowAction(key: string, shiftKey = false): MarkerRowAction | null {
    const deltaSec = shiftKey ? NUDGE_COARSE_SEC : NUDGE_SEC;
    switch (key) {
        case "ArrowLeft":
            return { kind: "nudge", deltaSec: -deltaSec };
        case "ArrowRight":
            return { kind: "nudge", deltaSec };
        case "ArrowUp":
            return { kind: "retune", deltaBpm: BPM_STEP };
        case "ArrowDown":
            return { kind: "retune", deltaBpm: -BPM_STEP };
        case "Delete":
        case "Backspace":
            return { kind: "remove" };
        default:
            return null;
    }
}

/** The BPM a marker shows while it is not being edited. */
export function bpmDraft(bpm: number): string {
    return bpm.toFixed(2);
}

/**
 * Commit a typed BPM: the parsed value when it is a tempo the engine accepts, else `null`
 * (the field reverts). Nothing is committed while the value is still being typed — the editor
 * only calls this on blur or Enter, so "1" on the way to "128" is never applied.
 */
export function commitBpmDraft(draft: string): number | null {
    const v = Number.parseFloat(draft.replace(",", "."));
    return isValidBpm(v) ? v : null;
}
