/**
 * Subscribe to throttled state events emitted by the Rust core.
 *
 * The core emits `mixer://state` at ~30 Hz with a full MixerState snapshot
 * (cheap, flat struct). We reconcile the zustand store from it. When not
 * running under Tauri, this is a no-op and the UI polls nothing.
 */

import type { HidInputEvent, MixerState } from "./types";

type UnlistenFn = () => void;

export async function subscribeMixerState(
    onState: (s: MixerState) => void,
): Promise<UnlistenFn> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
        return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<MixerState>("mixer://state", (e) => {
        onState(e.payload);
    });
    return unlisten;
}

/** A MIDI control event surfaced while learn mode is active. */
export interface MidiLearnEvent {
    status: number;
    midino: number;
    value: number;
}

export async function subscribeMidiLearn(
    onLearn: (e: MidiLearnEvent) => void,
): Promise<UnlistenFn> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
        return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<MidiLearnEvent>("midi://learn", (e) => {
        onLearn(e.payload);
    });
    return unlisten;
}

/** Subscribe to raw HID input reports from the connected device. */
export async function subscribeHidInput(
    onInput: (e: HidInputEvent) => void,
): Promise<UnlistenFn> {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
        return () => {};
    }
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<HidInputEvent>("hid://input", (e) => {
        onInput(e.payload);
    });
    return unlisten;
}
