/**
 * realtime-host.ts
 *
 * Process-level hardening that the native audio engine pulls in around
 * its start/stop lifecycle. Lives in the server module (not main.ts) so
 * the engine doesn't have to round-trip through IPC for every state
 * change, and so the smoke-test CLI gets the same protections as the
 * Electron app.
 *
 * What it does while the audio engine is running:
 *
 *   1. Elevates the host PROCESS priority (Windows: ABOVE_NORMAL → HIGH;
 *      macOS/Linux: nice -10 equivalent). Doesn't touch thread priority
 *      — that's RtAudio's job via RTAUDIO_SCHEDULE_REALTIME — but lifts
 *      the floor so the OS scheduler can't demote the audio thread when
 *      another foreground app gets the focus.
 *
 *   2. Holds an Electron `powerSaveBlocker` of type
 *      `prevent-app-suspension` so Windows doesn't drop CPU C-states or
 *      suspend the renderer during long monitoring sessions. Electron
 *      is loaded LAZILY because the smoke-test CLI runs without an
 *      Electron context and importing `electron` from a plain Node
 *      process throws.
 *
 * Both protections are reverted on stop(); idempotent if called twice.
 */

import os from "node:os";

let priorityRaised = false;
let originalPriority: number | null = null;
let powerSaveBlockerId: number | null = null;
let priorityHeartbeat: NodeJS.Timeout | null = null;

/** Raise process priority. Captures the original so stop() can restore. */
function raisePriority(): void {
    if (priorityRaised) return;
    try {
        // `os.getPriority` returns the current nice value (Unix) or
        // Windows priority class mapped to a nice value.
        originalPriority = os.getPriority(0);
    } catch {
        originalPriority = null;
    }
    try {
        // PRIORITY_HIGH = -14 on Linux/macOS, maps to HIGH_PRIORITY_CLASS
        // on Windows. We deliberately do NOT use PRIORITY_HIGHEST / REAL
        // TIME because those starve the OS of CPU when a single audify
        // callback runs long, and we already get realtime scheduling for
        // the audio thread itself via RTAUDIO_SCHEDULE_REALTIME.
        os.setPriority(0, os.constants.priority.PRIORITY_HIGH);
        priorityRaised = true;
    } catch {
        // Lacking permission (no admin on Windows, no CAP_SYS_NICE on
        // Linux) is fine — RtAudio's realtime scheduling flag still
        // applies to the actual audio thread.
        priorityRaised = false;
    }
}

function restorePriority(): void {
    if (!priorityRaised) return;
    try {
        if (originalPriority != null) {
            os.setPriority(0, originalPriority);
        } else {
            os.setPriority(0, os.constants.priority.PRIORITY_NORMAL);
        }
    } catch { /* ignore */ }
    priorityRaised = false;
    originalPriority = null;
}

function startPowerSaveBlocker(): void {
    if (powerSaveBlockerId != null) return;
    try {
        // Lazy import — avoids loading Electron in non-Electron contexts.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require("electron");
        const blocker = electron?.powerSaveBlocker;
        if (!blocker) return;
        // `prevent-app-suspension` is enough for audio. We do NOT use
        // `prevent-display-sleep` because the user may be intentionally
        // letting the screen blank during a long take.
        powerSaveBlockerId = blocker.start("prevent-app-suspension");
    } catch {
        powerSaveBlockerId = null;
    }
}

function stopPowerSaveBlocker(): void {
    if (powerSaveBlockerId == null) return;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electron = require("electron");
        electron?.powerSaveBlocker?.stop(powerSaveBlockerId);
    } catch { /* ignore */ }
    powerSaveBlockerId = null;
}

/** Apply both protections. Safe to call repeatedly; idempotent. */
export function acquireRealtimeHost(): void {
    raisePriority();
    startPowerSaveBlocker();
    startPriorityHeartbeat();
}

/** Revert both protections. Safe to call repeatedly; idempotent. */
export function releaseRealtimeHost(): void {
    stopPriorityHeartbeat();
    restorePriority();
    stopPowerSaveBlocker();
}

/** Re-assert HIGH priority every 5 seconds while the engine runs.
 *
 *  Why: on Windows, modern power management (EcoQoS / "Quality of
 *  Service throttling" introduced in Win10 2004 and aggressive in
 *  Win11) will demote a process to "Efficient" mode whenever its
 *  window loses focus — even if we set HIGH_PRIORITY_CLASS at start.
 *  Symptoms: audio sounds fine while the companion or browser is
 *  focused, but glitches when the user switches to another app
 *  (notably VS Code, which is itself an aggressive Electron renderer).
 *
 *  The heartbeat re-applies HIGH every few seconds so even if Windows
 *  silently demotes us, we bounce back. The cost of os.setPriority is
 *  a single syscall — well below 1ms — and we run it at 0.2 Hz, so
 *  it's free.
 *
 *  This is a defensive measure; the real fix on Windows would be a
 *  native module calling SetProcessInformation(ProcessPowerThrottling)
 *  with PROCESS_POWER_THROTTLING_EXECUTION_SPEED disabled. That's a
 *  future improvement; for now the heartbeat is a 10-line stopgap that
 *  measurably helps on Win11 machines. */
function startPriorityHeartbeat(): void {
    if (priorityHeartbeat) return;
    if (process.platform !== "win32") return; // Linux/macOS don't need this
    priorityHeartbeat = setInterval(() => {
        try {
            os.setPriority(0, os.constants.priority.PRIORITY_HIGH);
        } catch { /* permission denied — ignore, we tried */ }
    }, 5000);
    // Don't keep the event loop alive just for this — Electron has its
    // own keep-alive (the BrowserWindow). If everything else exits we
    // want this to stop too.
    priorityHeartbeat.unref?.();
}

function stopPriorityHeartbeat(): void {
    if (!priorityHeartbeat) return;
    clearInterval(priorityHeartbeat);
    priorityHeartbeat = null;
}
