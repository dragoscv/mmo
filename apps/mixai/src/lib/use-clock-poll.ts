/**
 * Polls `engine_clock_state`: on requestAnimationFrame, throttled to ≤30 Hz, while a deck plays,
 * and on a 4 Hz timer while none does (an idle app must not make 30 engine calls and 30 store
 * updates a second, nor run a callback on every display frame), and only while the document is
 * visible and the native engine is present. Results land in the perf store.
 *
 * Shared: any number of components may call `useClockPoll()` (waveform panel, deck header,
 * master clock); one loop runs while at least one of them is mounted.
 */

import { useEffect } from "react";
import { engine } from "@/bridge/engine";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";

const MIN_INTERVAL_MS = 1000 / 30;
const IDLE_INTERVAL_MS = 250;

let users = 0;
let stopLoop: (() => void) | null = null;

function startLoop(): () => void {
    let raf = 0;
    let timer = 0;
    let last = 0;
    let inFlight = false;
    let stopped = true;

    const anyPlaying = () => useMixerStore.getState().decks.some((d) => d.playing);

    const poll = (now: number) => {
        if (inFlight) return;
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

    /** Next wake-up: the next frame while a deck plays, else the idle timer. */
    const schedule = () => {
        if (stopped || raf || timer) return;
        if (anyPlaying()) raf = requestAnimationFrame(frame);
        else timer = window.setTimeout(tick, IDLE_INTERVAL_MS);
    };
    const frame = (now: number) => {
        raf = 0;
        if (stopped) return;
        if (now - last >= MIN_INTERVAL_MS) poll(now);
        schedule();
    };
    const tick = () => {
        timer = 0;
        if (stopped) return;
        poll(performance.now());
        schedule();
    };
    /** A deck started while the idle timer was pending: follow it from the next frame. */
    const wake = () => {
        if (stopped || !timer || !anyPlaying()) return;
        window.clearTimeout(timer);
        timer = 0;
        schedule();
    };

    const start = () => {
        if (!stopped || document.hidden) return;
        stopped = false;
        poll(performance.now());
        schedule();
    };
    const stop = () => {
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        if (timer) window.clearTimeout(timer);
        raf = 0;
        timer = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    start();
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = useMixerStore.subscribe(wake);
    return () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibility);
        unsubscribe();
    };
}

export function useClockPoll(): void {
    const native = useMixerStore((s) => s.native);

    useEffect(() => {
        if (!native) return;
        users += 1;
        if (users === 1) stopLoop = startLoop();
        return () => {
            users -= 1;
            if (users === 0) {
                stopLoop?.();
                stopLoop = null;
            }
        };
    }, [native]);
}
