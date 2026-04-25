/**
 * Shared `requestAnimationFrame` scheduler + AnalyserNode data cache.
 *
 * Why this exists
 * ───────────────
 * The mixer used to spin up one RAF loop per visual component (level meters,
 * waveforms, equalizer, stems, beat indicator…). On a mid-range Intel i5 that
 * easily added up to 8–12 independent loops, each calling
 * `analyser.getByteFrequencyData()` separately every frame. The result: <30 fps
 * and audible UI jank during playback.
 *
 * This module exposes ONE rAF loop that fans out to all subscribers. It also
 * caches the latest frequency-domain & time-domain reads per AnalyserNode so
 * multiple visualisers reading the same node only pay the cost ONCE per frame.
 *
 * Subscribers can declare a target FPS (e.g. level meters at 30 fps, waveforms
 * at 60 fps) and the scheduler will skip frames for them automatically.
 *
 * The loop is self-pausing: when the last subscriber unsubscribes, no more
 * `requestAnimationFrame` is queued — costing zero CPU at idle.
 */

import { useEffect, useRef } from "react";

// ─── Types ───────────────────────────────────────────────────────────────

export type RafCallback = (now: number, dt: number) => void;

export interface RafSubscribeOptions {
    /** Target frames-per-second for this subscriber. Frames in excess are dropped.
     *  Use 60 for waveforms/playheads, 30 for meters/spectrums, 15 for low-pri. */
    fps?: number;
    /** When `false`, the subscriber is suspended (no callbacks) until set true.
     *  Useful for "pause when not playing" optimisations. */
    enabled?: boolean;
}

interface Subscriber {
    cb: RafCallback;
    intervalMs: number;       // 1000/fps; 0 = every frame
    lastCalled: number;       // timestamp of last callback
    enabled: boolean;
}

// ─── Internal state ──────────────────────────────────────────────────────

const subscribers = new Set<Subscriber>();
let rafId: number | null = null;
let lastFrame = 0;

// Shared per-frame analyser caches. Cleared at the start of each frame so
// the first reader pays the cost; subsequent readers get a cached buffer.
const freqCache = new WeakMap<AnalyserNode, Uint8Array>();
const freqCacheValid = new WeakSet<AnalyserNode>();
const timeCache = new WeakMap<AnalyserNode, Float32Array>();
const timeCacheValid = new WeakSet<AnalyserNode>();

// ─── Loop ────────────────────────────────────────────────────────────────

function tick(now: number) {
    const dt = lastFrame === 0 ? 16.7 : now - lastFrame;
    lastFrame = now;

    // Invalidate analyser caches for the new frame. Buffers themselves are
    // kept (allocated once per node) — only the "valid" flag is reset.
    // WeakSet has no `clear()`; we rely on lazy invalidation done inside the
    // hooks below — they check the flag and refresh per node when stale.
    // Cheaper: replace the WeakSets so old flags are GC'd next cycle.
    // (Replacement is O(1) and avoids per-node clear cost.)
    freqValidGen++;
    timeValidGen++;

    for (const sub of subscribers) {
        if (!sub.enabled) continue;
        if (sub.intervalMs > 0 && now - sub.lastCalled < sub.intervalMs - 1) continue;
        sub.lastCalled = now;
        try {
            sub.cb(now, dt);
        } catch (err) {
            // Never let one bad subscriber kill the whole loop.
            console.warn("[raf-scheduler] subscriber threw:", err);
        }
    }

    if (subscribers.size > 0) {
        rafId = requestAnimationFrame(tick);
    } else {
        rafId = null;
        lastFrame = 0;
    }
}

function ensureRunning() {
    if (rafId === null && typeof requestAnimationFrame !== "undefined") {
        rafId = requestAnimationFrame(tick);
    }
}

// Generation counters for cache validity (cheaper than WeakSet rotation).
let freqValidGen = 0;
let timeValidGen = 0;
const freqLastGen = new WeakMap<AnalyserNode, number>();
const timeLastGen = new WeakMap<AnalyserNode, number>();

// ─── Public scheduler API ────────────────────────────────────────────────

/** Subscribe a callback to the shared rAF loop. Returns an unsubscribe fn. */
export function subscribeRaf(cb: RafCallback, opts: RafSubscribeOptions = {}): () => void {
    const fps = opts.fps && opts.fps > 0 ? opts.fps : 0;
    const sub: Subscriber = {
        cb,
        intervalMs: fps > 0 ? 1000 / fps : 0,
        lastCalled: 0,
        enabled: opts.enabled !== false,
    };
    subscribers.add(sub);
    ensureRunning();
    return () => {
        subscribers.delete(sub);
    };
}

/** Read frequency data for an analyser ONCE per frame. Subsequent readers in
 *  the same frame receive the cached buffer (no extra Web Audio call). */
export function getSharedFrequencyData(analyser: AnalyserNode): Uint8Array {
    let buf = freqCache.get(analyser);
    if (!buf || buf.length !== analyser.frequencyBinCount) {
        // Backed by a real ArrayBuffer (not SharedArrayBuffer) so the dom
        // typings for getByteFrequencyData accept it under strict TS.
        buf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
        freqCache.set(analyser, buf);
        freqLastGen.set(analyser, -1);
    }
    if (freqLastGen.get(analyser) !== freqValidGen) {
        analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>);
        freqLastGen.set(analyser, freqValidGen);
    }
    return buf;
}

/** Same as above, but for time-domain (waveform) reads. */
export function getSharedTimeDomainData(analyser: AnalyserNode): Float32Array {
    let buf = timeCache.get(analyser);
    if (!buf || buf.length !== analyser.fftSize) {
        buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
        timeCache.set(analyser, buf);
        timeLastGen.set(analyser, -1);
    }
    if (timeLastGen.get(analyser) !== timeValidGen) {
        analyser.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
        timeLastGen.set(analyser, timeValidGen);
    }
    return buf;
}

// ─── Diagnostics ────────────────────────────────────────────────────────

/** Live snapshot of scheduler internals — useful for the dev debugger. */
export function getRafSchedulerStats() {
    const subs = Array.from(subscribers);
    const fpsTargets: Record<string, number> = {};
    for (const s of subs) {
        const k = s.intervalMs === 0 ? "uncapped" : `${Math.round(1000 / s.intervalMs)}fps`;
        fpsTargets[k] = (fpsTargets[k] ?? 0) + 1;
    }
    return {
        subscribers: subs.length,
        running: rafId !== null,
        enabled: subs.filter((s) => s.enabled).length,
        suspended: subs.filter((s) => !s.enabled).length,
        fpsTargets,
    };
}

// ─── React helpers ───────────────────────────────────────────────────────

/**
 * React hook variant of `subscribeRaf`. The latest `cb` is always invoked
 * (no stale closures) without re-subscribing on every render. Toggle
 * `enabled` to pause without unsubscribing — cheaper than churn.
 */
export function useRafCallback(cb: RafCallback, opts: RafSubscribeOptions = {}) {
    const cbRef = useRef(cb);
    cbRef.current = cb;
    const { fps, enabled } = opts;

    useEffect(() => {
        const wrapped: RafCallback = (now, dt) => cbRef.current(now, dt);
        return subscribeRaf(wrapped, { fps, enabled });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fps, enabled]);
}
