/**
 * Beat-reactive accent (opt-in, Settings → Appearance): writes the master beat
 * phase to a CSS custom property `--beat` (1 on the beat, decaying to 0) on the
 * shell element only (not <html>, which would restyle the whole document) so the
 * title bar line / deck glow can pulse with the music. Uses the clock
 * the master-clock panel already polls (perf store) — no extra IPC. Off when
 * motion is reduced (OS, pref or governor): then `--beat` stays 0.
 */
import { useEffect } from "react";
import { usePerfStore } from "@/state/perf-store";
import { useShellPrefs } from "./shell-prefs";
import { appMotionAllowed } from "./motion";

/** 1 at the beat, exponential-ish decay to 0 by 60 % of the beat. */
export function beatPulse(beatPhase: number): number {
    const p = beatPhase - Math.floor(beatPhase);
    return p >= 0.6 ? 0 : Math.round((1 - p / 0.6) ** 2 * 1000) / 1000;
}

export function useBeatAccent(): void {
    const on = useShellPrefs((s) => s.beatAccent);
    useEffect(() => {
        const root = document.querySelector<HTMLElement>(".mixai-shell");
        if (!root) return;
        if (!on) {
            root.style.removeProperty("--beat");
            return;
        }
        const osReduced = matchMedia("(prefers-reduced-motion: reduce)");
        let raf = 0;
        let prev = -1;
        const loop = () => {
            const c = usePerfStore.getState().clock;
            const v = c && c.bpm > 0 && appMotionAllowed() && !osReduced.matches ? beatPulse(c.beatPhase) : 0;
            if (v !== prev) {
                root.style.setProperty("--beat", String(v));
                prev = v;
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => {
            cancelAnimationFrame(raf);
            root.style.removeProperty("--beat");
        };
    }, [on]);
}
