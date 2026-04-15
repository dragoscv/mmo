"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

export interface PerformanceStats {
    fps: number;
    jsHeapUsed: number;    // MB
    jsHeapTotal: number;   // MB
    jsHeapLimit: number;   // MB
    deviceMemory: number;  // GB (approximate)
    cpuCores: number;
    audioLatency: number;  // ms
    domNodes: number;
}

// ─── External Store ──────────────────────────────────────────────────────

let current: PerformanceStats = {
    fps: 0,
    jsHeapUsed: 0,
    jsHeapTotal: 0,
    jsHeapLimit: 0,
    deviceMemory: 0,
    cpuCores: 0,
    audioLatency: 0,
    domNodes: 0,
};

const listeners = new Set<() => void>();
let rafId = 0;
let refCount = 0;
let frameCount = 0;
let lastFpsTime = 0;
let lastDomCount = 0;
let lastDomCountTime = 0;

function notify() {
    listeners.forEach((fn) => fn());
}

function tick(now: number) {
    frameCount++;
    if (now - lastFpsTime >= 1000) {
        const fps = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;

        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
        const jsHeapUsed = mem ? mem.usedJSHeapSize / 1048576 : 0;
        const jsHeapTotal = mem ? mem.totalJSHeapSize / 1048576 : 0;
        const jsHeapLimit = mem ? mem.jsHeapSizeLimit / 1048576 : 0;

        const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory || 0;
        const cpuCores = navigator.hardwareConcurrency || 0;

        // DOM node count — expensive, run every 5 seconds only
        if (now - lastDomCountTime >= 5000) {
            lastDomCountTime = now;
            lastDomCount = document.getElementsByTagName("*").length;
        }
        const domNodes = lastDomCount;

        // Audio latency from any existing AudioContext
        let audioLatency = 0;
        try {
            const ctx = (window as unknown as { __mmo_audio_ctx?: AudioContext }).__mmo_audio_ctx;
            if (ctx) {
                audioLatency = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
            }
        } catch { /* ignore */ }

        const next = { fps, jsHeapUsed, jsHeapTotal, jsHeapLimit, deviceMemory, cpuCores, audioLatency, domNodes };
        // Only notify if values actually changed (avoid unnecessary subscriber re-renders)
        if (next.fps !== current.fps || next.jsHeapUsed !== current.jsHeapUsed || next.domNodes !== current.domNodes || next.audioLatency !== current.audioLatency) {
            current = next;
            notify();
        }
    }
    rafId = requestAnimationFrame(tick);
}

function startMonitor() {
    if (refCount === 0) {
        lastFpsTime = performance.now();
        frameCount = 0;
        rafId = requestAnimationFrame(tick);
    }
    refCount++;
}

function stopMonitor() {
    refCount--;
    if (refCount <= 0) {
        refCount = 0;
        cancelAnimationFrame(rafId);
    }
}

function getSnapshot(): PerformanceStats {
    return current;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ─── Hook ────────────────────────────────────────────────────────────────

export function usePerformanceStats(): PerformanceStats {
    useEffect(() => {
        startMonitor();
        return () => stopMonitor();
    }, []);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
