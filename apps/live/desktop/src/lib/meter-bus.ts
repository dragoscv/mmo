/**
 * Meters arrive at 30 Hz; pushing them through React state would re-render the whole screen. They
 * go into this tiny bus instead and animated widgets read `latest` from requestAnimationFrame.
 */
import { useEffect, useState } from "react";
import type { Meters } from "./protocol";

let latest: Meters | null = null;
let stamp = 0;
const subs = new Set<() => void>();

export const meterBus = {
    publish(m: Meters) {
        latest = m;
        stamp = performance.now();
    },
    clear() {
        latest = null;
        for (const s of subs) s();
    },
    get latest(): Meters | null {
        return latest;
    },
    /** ms since the last meters frame (stale meters fall to silence). */
    age(): number {
        return latest ? performance.now() - stamp : Number.POSITIVE_INFINITY;
    },
};

/** Low-rate snapshot for text readouts (DSP %, dropouts) without 30 Hz re-renders. */
export function useMeterSample(hz = 4): Meters | null {
    const [m, setM] = useState<Meters | null>(null);
    useEffect(() => {
        const id = window.setInterval(() => setM(meterBus.age() < 1500 ? latest : null), 1000 / hz);
        return () => window.clearInterval(id);
    }, [hz]);
    return m;
}

type Draw = (m: Meters | null, dt: number) => void;
const draws = new Set<Draw>();
let raf = 0;
let last = 0;
let acc = 0;
let reducedMotion = false;

function tick(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    // Reduced motion: ~10 fps, no smoothing animation between frames.
    if (!reducedMotion || acc >= 0.1) {
        const m = meterBus.age() < 500 ? latest : null;
        for (const d of draws) d(m, acc);
        acc = 0;
    }
    raf = draws.size ? requestAnimationFrame(tick) : 0;
}

export function setReducedMotion(on: boolean) {
    reducedMotion = on;
}

/** Register a draw callback on the single shared requestAnimationFrame loop; returns a cleanup. */
export function frameLoop(draw: Draw): () => void {
    draws.add(draw);
    if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
    }
    return () => {
        draws.delete(draw);
    };
}

/** Map dBFS to a 0..1 meter position (-60 dB floor, +6 dB top). */
export function dbToPos(db: number): number {
    return Math.min(1, Math.max(0, (db + 60) / 66));
}
