"use client";

/**
 * audio-diagnostics.ts
 *
 * Single-mount diagnostic logger that records every event likely to
 * correlate with "the sound just changed when I switched windows":
 *
 *   - window focus / blur
 *   - document visibility change (tab hidden / shown)
 *   - browser AudioContext state changes (running / suspended / closed)
 *   - native engine underrun count deltas
 *   - native engine DSP block max spikes
 *   - WASAPI / driver hot-swap detection (sample rate or backend
 *     changing under us)
 *
 * Everything goes through the existing `dlog("audio-diag", …)` channel
 * so it shows up in the Dev Debugger's Logs tab and can be copied with
 * the new "Copy logs" button.
 *
 * Mount once near the root; no UI of its own.
 */

import { useEffect, useRef } from "react";
import { dlog } from "@/lib/dev-debugger";
import { useLiveMetersField } from "@/components/live/live-meters-store";

export function AudioDiagnosticsLogger() {
    // Track the last sample rate / backend / underrun count so we only
    // log DELTAS — a sample-rate change mid-session is meaningful, but
    // 100k log lines saying "still 48 kHz" would be noise.
    const lastBackend = useRef<string>("");
    const lastSampleRate = useRef<number>(0);
    const lastFrameSize = useRef<number>(0);
    const lastUnderruns = useRef<number>(0);
    const lastRunning = useRef<boolean>(false);
    const lastDspMax = useRef<number>(0);

    const nativeRunning = useLiveMetersField(s => s.nativeRunning);
    const nativeBackend = useLiveMetersField(s => s.nativeBackend);
    const nativeSampleRate = useLiveMetersField(s => s.nativeSampleRate);
    const nativeFrameSize = useLiveMetersField(s => s.nativeFrameSize);
    const nativeUnderruns = useLiveMetersField(s => s.nativeUnderruns);
    const nativeDspMax = useLiveMetersField(s => s.nativeDspMaxMs);

    // ── Window focus / blur ──────────────────────────────────────────────
    useEffect(() => {
        const onFocus = () => dlog("audio-diag", "window focus", { hidden: document.hidden }, "info");
        const onBlur = () => dlog("audio-diag", "window blur", { hidden: document.hidden }, "warn");
        const onVis = () => dlog(
            "audio-diag",
            `document ${document.hidden ? "hidden" : "visible"}`,
            undefined,
            document.hidden ? "warn" : "info",
        );
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("blur", onBlur);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, []);

    // ── Browser AudioContext state ───────────────────────────────────────
    // We don't have direct access to every AudioContext from here, so we
    // sniff a globally exposed one (mixer-engine.ts publishes window.
    // __mmo_audio_ctx). The Live engine doesn't expose itself globally
    // yet — adding that here is overkill; the Performance widget already
    // shows live engine state and that's enough.
    useEffect(() => {
        const ctx = (window as unknown as { __mmo_audio_ctx?: AudioContext }).__mmo_audio_ctx;
        if (!ctx) return;
        const onStateChange = () => dlog(
            "audio-diag",
            `AudioContext.state = ${ctx.state}`,
            { sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency },
            ctx.state === "running" ? "info" : "warn",
        );
        ctx.addEventListener?.("statechange", onStateChange);
        return () => ctx.removeEventListener?.("statechange", onStateChange);
    }, []);

    // ── Native engine running state ──────────────────────────────────────
    useEffect(() => {
        if (nativeRunning !== lastRunning.current) {
            lastRunning.current = nativeRunning;
            dlog(
                "audio-diag",
                `native engine ${nativeRunning ? "STARTED" : "STOPPED"}`,
                {
                    backend: nativeBackend,
                    sampleRate: nativeSampleRate,
                    frameSize: nativeFrameSize,
                },
                nativeRunning ? "info" : "warn",
            );
        }
    }, [nativeRunning, nativeBackend, nativeSampleRate, nativeFrameSize]);

    // ── Native parameter deltas (backend / sample rate / frame size) ─────
    // Hot swaps mid-session are RARE but they DO happen on Windows when
    // the user changes the default device, and they can manifest as a
    // sudden tone change. Logging them gives the user something concrete
    // to point at.
    useEffect(() => {
        if (!nativeRunning) return;
        if (nativeBackend && nativeBackend !== lastBackend.current && lastBackend.current) {
            dlog("audio-diag", `BACKEND CHANGED: ${lastBackend.current} → ${nativeBackend}`, undefined, "warn");
        }
        lastBackend.current = nativeBackend;

        if (nativeSampleRate && nativeSampleRate !== lastSampleRate.current && lastSampleRate.current) {
            dlog(
                "audio-diag",
                `SAMPLE RATE CHANGED: ${lastSampleRate.current} → ${nativeSampleRate} Hz`,
                undefined,
                "warn",
            );
        }
        lastSampleRate.current = nativeSampleRate;

        if (nativeFrameSize && nativeFrameSize !== lastFrameSize.current && lastFrameSize.current) {
            dlog(
                "audio-diag",
                `FRAME SIZE CHANGED: ${lastFrameSize.current} → ${nativeFrameSize}`,
                undefined,
                "warn",
            );
        }
        lastFrameSize.current = nativeFrameSize;
    }, [nativeRunning, nativeBackend, nativeSampleRate, nativeFrameSize]);

    // ── Underrun deltas — every new xrun is a click/glitch ───────────────
    useEffect(() => {
        const delta = nativeUnderruns - lastUnderruns.current;
        if (delta > 0 && lastUnderruns.current >= 0) {
            dlog(
                "audio-diag",
                `XRUN +${delta} (total ${nativeUnderruns})`,
                { dspMax: nativeDspMax, hidden: document.hidden, focused: document.hasFocus() },
                "error",
            );
        }
        lastUnderruns.current = nativeUnderruns;
    }, [nativeUnderruns, nativeDspMax]);

    // ── DSP block max spikes — early warning ────────────────────────────
    // We log a warning whenever the per-block max DOUBLES from the
    // previous reading AND exceeds 1ms. That catches CPU contention
    // events (focus change, GC, OS interruption) before they turn into
    // actual underruns.
    useEffect(() => {
        if (nativeDspMax > 1 && nativeDspMax > lastDspMax.current * 2) {
            dlog(
                "audio-diag",
                `DSP spike: ${lastDspMax.current.toFixed(2)} → ${nativeDspMax.toFixed(2)} ms`,
                { hidden: document.hidden, focused: document.hasFocus() },
                "warn",
            );
        }
        lastDspMax.current = nativeDspMax;
    }, [nativeDspMax]);

    return null;
}
