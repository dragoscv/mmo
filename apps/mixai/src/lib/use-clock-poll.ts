/**
 * Polls `engine_clock_state` on requestAnimationFrame, throttled to ≤30 Hz,
 * and only while the document is visible and the native engine is present.
 * Mounted once (by the master clock panel); results land in the perf store.
 */

import { useEffect } from "react";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";

const MIN_INTERVAL_MS = 1000 / 30;

export function useClockPoll(): void {
    const native = useMixerStore((s) => s.native);

    useEffect(() => {
        if (!native) return;
        let raf = 0;
        let last = 0;
        let inFlight = false;
        let stopped = false;

        const frame = (now: number) => {
            if (stopped) return;
            raf = requestAnimationFrame(frame);
            if (inFlight || now - last < MIN_INTERVAL_MS) return;
            last = now;
            inFlight = true;
            engine
                .clockState()
                .then((c) => usePerfStore.getState().setClock(c))
                .catch(() => undefined)
                .finally(() => {
                    inFlight = false;
                });
        };

        const start = () => {
            if (raf || document.hidden) return;
            stopped = false;
            raf = requestAnimationFrame(frame);
        };
        const stop = () => {
            stopped = true;
            if (raf) cancelAnimationFrame(raf);
            raf = 0;
        };
        const onVisibility = () => (document.hidden ? stop() : start());

        start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [native]);
}
