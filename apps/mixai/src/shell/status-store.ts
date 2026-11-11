/**
 * Slow status values for the status bar.
 *
 * The engine snapshot arrives ~30 times a second and its audio load and buffer size jitter on
 * every one. The bar must not render at that rate (idle must be free), so this module samples
 * the mixer store OUTSIDE React and publishes:
 *   - every FAST_MS: the peak audio load of the window (whole percent, with a dead band), the
 *     overrun count, and the buffer latency that was reported most often in the window;
 *   - every SLOW_MS (and when Settings closes): the companion connection and the name of the
 *     opened output device.
 * A value is written only when it changed, so a steady app renders nothing.
 */
import { create } from "zustand";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { loadPct, modeOf, steadyPct } from "./status-math";

export type CompanionLink = "online" | "unpaired" | "offline";

export interface StatusState {
    /** Peak audio load of the last window, whole percent. */
    loadPct: number;
    /** Audio callbacks that missed their buffer period since the stream started. */
    overruns: number;
    /** Settled buffer latency in ms (0 = not known yet). */
    latencyMs: number;
    /** null until the first probe answered. */
    companion: CompanionLink | null;
    /** Name of the opened output device (null = unknown / browser preview). */
    device: string | null;
}

export const FAST_MS = 2000;
export const SLOW_MS = 15_000;

export const useStatusStore = create<StatusState>(() => ({ loadPct: 0, overruns: 0, latencyMs: 0, companion: null, device: null }));

function publish(next: Partial<StatusState>): void {
    const cur = useStatusStore.getState();
    for (const k of Object.keys(next) as (keyof StatusState)[]) {
        if (cur[k] !== next[k]) {
            useStatusStore.setState(next);
            return;
        }
    }
}

function run(): () => void {
    let peak = 0;
    const seen = new Map<number, number>();
    const take = (s: { dspLoad?: number; latencyMs: number }) => {
        const load = s.dspLoad ?? 0;
        if (load > peak) peak = load;
        seen.set(s.latencyMs, (seen.get(s.latencyMs) ?? 0) + 1);
    };
    const flush = () => {
        const m = useMixerStore.getState();
        // No snapshot changed in this window (steady engine / browser preview): current values.
        if (seen.size === 0) take(m);
        const cur = useStatusStore.getState();
        publish({ loadPct: steadyPct(cur.loadPct, loadPct(peak)), overruns: m.overruns ?? 0, latencyMs: modeOf(seen, cur.latencyMs) });
        peak = 0;
        seen.clear();
    };
    const offMixer = useMixerStore.subscribe((s) => {
        take(s);
        // Show the first real buffer size at once instead of after a whole window.
        if (s.latencyMs > 0 && useStatusStore.getState().latencyMs === 0) flush();
    });
    flush();
    const fast = setInterval(flush, FAST_MS);

    let alive = true;
    let busy = false;
    const probe = async () => {
        if (busy || document.hidden) return;
        busy = true;
        try {
            if (!(await engine.isNative())) {
                if (alive) publish({ companion: "offline", device: null });
                return;
            }
            const [st, out] = await Promise.all([engine.companionStatus().catch(() => null), engine.audioOutputInfo().catch(() => null)]);
            if (alive) publish({ companion: !st?.online ? "offline" : st.authed ? "online" : "unpaired", device: out?.deviceName ?? null });
        } finally {
            busy = false;
        }
    };
    void probe();
    const slow = setInterval(() => void probe(), SLOW_MS);
    const onVisible = () => {
        if (!document.hidden) void probe();
    };
    document.addEventListener("visibilitychange", onVisible);
    // The output device and the companion connection are changed in Settings.
    const offUi = useUiStore.subscribe((s, prev) => {
        if (prev.settingsOpen && !s.settingsOpen) void probe();
    });

    return () => {
        alive = false;
        clearInterval(fast);
        clearInterval(slow);
        document.removeEventListener("visibilitychange", onVisible);
        offMixer();
        offUi();
    };
}

let users = 0;
let stop: (() => void) | null = null;

/** Start sampling (shared by every mounted consumer); returns the matching stop. */
export function startStatus(): () => void {
    users += 1;
    if (users === 1) stop = run();
    return () => {
        users -= 1;
        if (users === 0) {
            stop?.();
            stop = null;
        }
    };
}
