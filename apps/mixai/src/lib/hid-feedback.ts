/**
 * HID LED/feedback driver — the *output* half of the HID loop.
 *
 * Given a preset's `feedback` mappings, this watches the mixer snapshot and
 * writes an output report to the connected device whenever a reflected state
 * changes (play/cue/sync/loop/on-air per deck). It is **state-diffing**: it only
 * writes when a byte actually changes, so the device isn't spammed at 30 Hz —
 * the same approach as the web app's controller drivers.
 *
 * Output report layouts are device-specific, so the byte/value assignments live
 * in the (data-driven) preset, not here. This module just computes the desired
 * bytes from state and pushes diffs through `engine.hidWriteReport`.
 */

import { engine } from "@/bridge/engine";
import type { MixerState, DeckId } from "@/bridge/types";
import type { HidFeedback, HidFeedbackState, HidPreset } from "@/lib/hid-mapping";

/** Resolve whether a feedback state is currently active for its deck. */
function stateActive(state: HidFeedbackState, deck: DeckId | null, s: MixerState): boolean {
    if (state === "onair") {
        // On-air = audible on the master via the crossfader. Deck A is on the
        // left (xf < 0.9), deck B on the right (xf > -0.9); C/D map like A/B.
        const xf = s.crossfader;
        const d = s.decks.find((x) => x.id === deck);
        if (!d || !d.playing) return false;
        if (deck === "a" || deck === "c") return xf < 0.9;
        if (deck === "b" || deck === "d") return xf > -0.9;
        return true;
    }
    const d = s.decks.find((x) => x.id === deck);
    if (!d) return false;
    switch (state) {
        case "play":
            return d.playing;
        case "cue":
            return d.cue;
        case "sync":
            return d.tempo !== 1; // synced/adjusted tempo
        case "loop":
            return d.loopActive;
        default:
            return false;
    }
}

/**
 * Builds the desired output report bytes from the active states. Multiple
 * feedback entries can target the same byte (e.g. different bits) — we OR the
 * on-values together and start from the off-values as the baseline.
 */
function computeReport(feedback: HidFeedback[], reportId: number, s: MixerState): number[] {
    let maxByte = reportId; // report id occupies byte 0
    for (const f of feedback) maxByte = Math.max(maxByte, f.byteIndex);
    const bytes = new Array<number>(maxByte + 1).fill(0);
    bytes[0] = reportId;
    // Baseline: apply off-values first so unset states are explicitly cleared.
    for (const f of feedback) bytes[f.byteIndex] = f.offValue;
    for (const f of feedback) {
        if (stateActive(f.state, f.deck, s)) {
            // OR so bit-flag LEDs on a shared byte coexist.
            bytes[f.byteIndex] = (bytes[f.byteIndex] ?? 0) | f.onValue;
        }
    }
    return bytes;
}

/** Last report we wrote, to diff against (avoid redundant writes). */
let lastReport: number[] | null = null;

/** Reset the diff cache (call on connect/disconnect/preset change). */
export function resetHidFeedback(): void {
    lastReport = null;
}

/**
 * Push LED feedback for the current mixer state. No-op when the preset has no
 * feedback mappings. Only writes when the computed report differs from the last.
 */
export function pushHidFeedback(preset: HidPreset, s: MixerState): void {
    const feedback = preset.feedback;
    if (!feedback || feedback.length === 0) return;
    const report = computeReport(feedback, preset.outputReportId ?? 0, s);
    if (lastReport && sameBytes(lastReport, report)) return;
    lastReport = report;
    void engine.hidWriteReport(report);
}

function sameBytes(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
