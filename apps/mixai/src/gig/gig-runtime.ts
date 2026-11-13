/**
 * Gig lock: the part that talks to the shell and the rest of the app (started once by App.tsx
 * with `startGig()`; pop-out windows do not start it, they only follow the stored lock).
 *
 *  - Shell: every change of the lock, and every page load, is sent with `gig_set_locked`, so
 *    keep-awake and the shell's close confirmation follow the webview (after a reload or a
 *    crash with the lock stored, the request is made again). A shell without the command
 *    (an older app shell) = "not available", silently. A call that fails is tried again twice;
 *    after that the popover says the shell did not confirm the lock.
 *  - Ctrl/Cmd+Shift+G: lock; while locked the first press arms and a second one unlocks.
 *  - `gig://close-request`: the shell held a close of the main window back: ask the DJ.
 *  - Going locked (and starting locked) closes Settings and switches off what Settings can
 *    leave running: MIDI learn, HID learn, a 30 s skin try (`enforceLock` in gig-core).
 *  - The folder of the last recording is remembered for the disk check.
 *
 * Every exit undoes it: the returned stop removes the key listener, the store subscriptions
 * and the shell event (also when that subscription resolves after the stop).
 */
import { engine } from "@/bridge/engine";
import { gig, subscribeCloseRequest } from "@/bridge/gig";
import { windowCtl } from "@/bridge/window";
import { usePackStore } from "@/packs/pack-store";
import { useHidStore } from "@/state/hid-store";
import { useRecordingStore } from "@/state/recording-store";
import { useUiStore } from "@/state/ui-store";
import { rememberRecordingPath } from "./gig-checks";
import { closeAnyway, enforceLock, runShellSync, type CloseResult } from "./gig-core";
import { useGigStore } from "./gig-store";

let syncing = false;

/**
 * Tell the shell where the lock stands. Calls never overlap; the newest state is sent last,
 * and a failed call is retried (the rule is `runShellSync` in gig-core).
 */
export async function syncShell(): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
        const link = await runShellSync({
            locked: () => useGigStore.getState().locked,
            setLocked: (locked) => gig.setLocked(locked),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        });
        useGigStore.getState().setAwake(link);
    } finally {
        syncing = false;
    }
}

/** Does the ENGINE record right now? (The page's own flag is not re-read after a page reload.) False when it cannot be asked. */
export async function engineRecording(): Promise<boolean> {
    try {
        return (await engine.isRecording()) === true;
    } catch {
        return false;
    }
}

/**
 * "Close anyway": the engine is asked whether a recording runs; if so it is stopped through
 * the engine (the call returns when the WAV is complete on disk) and only then the window is
 * closed, without another question. The answer says how it went: the question stays on screen
 * unless it is "closed". A shell without `gig_close_window` does not hold the window either,
 * so a plain close does it there. The rule is `closeAnyway` in gig-core.
 */
export function closeForReal(): Promise<CloseResult> {
    return closeAnyway({
        isRecording: () => engine.isRecording(),
        stopRecording: async () => {
            await engine.stopRecording();
            // The page's own flag follows (title bar REC button, set tracklist).
            useRecordingStore.setState({ recording: false, startedAt: 0, path: null });
        },
        closeWindow: () => gig.closeWindow(),
        closeUnasked: () => windowCtl.closeUnasked(),
    });
}

/** What going locked switches off (also at a start that comes back locked: a page reload keeps the engine's learn flag). */
function onLocked(): void {
    enforceLock({
        // Written straight to the store: closing Settings is never gated.
        closeSettings: () => {
            if (useUiStore.getState().settingsOpen) useUiStore.setState({ settingsOpen: false });
        },
        midiLearnOff: () => engine.midiSetLearn(false),
        hidLearnOff: () => {
            if (useHidStore.getState().learning) useHidStore.getState().setLearning(false);
        },
        endSkinTry: () => {
            if (usePackStore.getState().trying) usePackStore.getState().endTry();
        },
    });
}

export function startGig(): () => void {
    let stopped = false;

    void syncShell();
    if (useGigStore.getState().locked) onLocked();
    const offLock = useGigStore.subscribe((s, prev) => {
        if (s.locked === prev.locked) return;
        void syncShell();
        if (s.locked) onLocked();
    });

    const onKey = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyG") return;
        e.preventDefault();
        // A held key is one press.
        if (e.repeat) return;
        useGigStore.getState().hotkey();
    };
    window.addEventListener("keydown", onKey);

    let offClose: (() => void) | undefined;
    void subscribeCloseRequest(() => {
        if (useGigStore.getState().locked) {
            useGigStore.getState().setCloseAsk(true);
            // Without this answer the shell stops holding the window (a dead page must not trap it).
            void gig.closeSeen().catch(() => undefined);
        } else {
            // The shell still thought the lock was on: put it right and let the window go.
            void syncShell().then(() => gig.closeWindow().catch(() => undefined));
        }
    })
        .then((off) => {
            // The stop ran while the subscription was being made: drop it now.
            if (stopped) off();
            else offClose = off;
        })
        .catch(() => undefined);

    rememberRecordingPath(useRecordingStore.getState().path);
    const offRec = useRecordingStore.subscribe((s, prev) => {
        if (s.path !== prev.path) rememberRecordingPath(s.path);
    });

    return () => {
        stopped = true;
        offLock();
        offRec();
        window.removeEventListener("keydown", onKey);
        offClose?.();
    };
}

// Development builds only: handles for remote-debugger tests (`window.__decksExt.gigDebug`).
if (import.meta.env?.DEV) void import("./gig-dev");
