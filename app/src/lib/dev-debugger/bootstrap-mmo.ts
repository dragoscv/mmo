/**
 * Bootstrap — wires app-specific telemetry sources (mixer engine, RAF
 * scheduler) into the app-agnostic dev-debugger store.
 *
 * Imported once on the client (e.g. from DevDebuggerButton) so the snapshot
 * providers are available whenever the overlay opens.
 */

import { registerAudioSnapshot, registerRafSnapshot, type AudioSnapshot } from "@/lib/dev-debugger";
import { getRafSchedulerStats } from "@/lib/raf-scheduler";

let installed = false;

export function installAppDebugSources() {
    if (installed || typeof window === "undefined") return;
    installed = true;

    registerAudioSnapshot((): AudioSnapshot | null => {
        const ctx = (window as unknown as { __mmo_audio_ctx?: AudioContext }).__mmo_audio_ctx;
        if (!ctx) return null;
        return {
            state: ctx.state,
            sampleRate: ctx.sampleRate,
            baseLatency: (ctx.baseLatency ?? 0) * 1000,
            outputLatency: (ctx.outputLatency ?? 0) * 1000,
            currentTime: ctx.currentTime,
        };
    });

    registerRafSnapshot(() => getRafSchedulerStats());
}
