/**
 * Stem performance commands of the Rust shell (WP19-41, `src-tauri/src/stems.rs`): per-stem
 * crossfader, stem mute with an echo tail (mute FX) and loops stored on hot cues.
 *
 * Every wrapper answers `true` when the engine took the command and `false` otherwise (no
 * engine in design mode, a shell built before the command existed, a refused value). None of
 * them throws: the caller's optimistic patch is simply replaced by the next engine snapshot.
 *
 * The state these commands change is on `DeckState` (./types.ts): `stemXf`, `stemMuteFx`,
 * `stemMuteFxBeats`, `hotCueLoops` (optional there: a shell built before 1.6 does not send them).
 */
import type { DeckId } from "./types";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn | null> {
    if (invokeImpl) return invokeImpl;
    // Tauri injects `__TAURI_INTERNALS__`; in a plain browser it is undefined.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        const mod = await import("@tauri-apps/api/core");
        invokeImpl = mod.invoke as InvokeFn;
        return invokeImpl;
    }
    return null;
}

async function send(cmd: string, args: Record<string, unknown>): Promise<boolean> {
    try {
        const invoke = await getInvoke();
        if (!invoke) {
            if (import.meta.env?.DEV) console.debug(`[mixai mock] ${cmd}`, args);
            return false;
        }
        await invoke<null>(cmd, args);
        return true;
    } catch (e) {
        // An older shell answers "not available in this build"; a bad value is refused with a reason.
        if (import.meta.env?.DEV) console.warn(`[mixai] ${cmd} refused:`, e);
        return false;
    }
}

/**
 * Mute / unmute stem `idx` (0=vocals, 1=drums, 2=bass, 3=melody). An unmute returns to the level
 * the stem had before the mute. With the mute FX on, a mute on a playing deck leaves an echo tail
 * (a plain mute on a track without a tempo, on a paused deck and in reverse).
 */
export function setStemMute(deck: DeckId, idx: number, on: boolean): Promise<boolean> {
    return send("deck_set_stem_mute", { deck, idx, on });
}

/** Stem crossfader of stem `idx`: −1 (side A) .. +1 (side B), 0 = the stem follows the deck. */
export function setStemXf(deck: DeckId, idx: number, value: number): Promise<boolean> {
    return send("deck_set_stem_xf", { deck, idx, value });
}

/** Stem mute FX on/off and its echo time in beats (1/32 .. 8). */
export function setStemMuteFx(deck: DeckId, on: boolean, beats: number): Promise<boolean> {
    return send("deck_set_stem_mute_fx", { deck, on, beats });
}

/** Cue loop: store the running loop on hot cue `slot` (0..7); jumping to that cue starts the loop again. */
export function saveCueLoop(deck: DeckId, slot: number): Promise<boolean> {
    return send("deck_save_cue_loop", { deck, slot });
}
