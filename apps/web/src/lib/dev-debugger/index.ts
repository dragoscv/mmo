/**
 * dev-debugger — public API
 * ─────────────────────────
 * Drop-in performance/debugging telemetry. Reusable across apps.
 *
 * Quick start (in app code):
 *
 *   import { dlog, useRenderCount } from "@/lib/dev-debugger";
 *
 *   useRenderCount("MixerView");
 *   dlog("audio", "deck loaded", { id, durationSec });
 *
 * Open the overlay via <DevDebuggerButton /> (already mounted in the
 * Performance card). Click "Copy Report" to grab a full snapshot you can
 * paste into a chat for diagnosis.
 */

import { getReport, type DebugReport } from "./store";

export {
    dlog, dmark, dtime, dtimeAsync, addNote, clearAll,
    registerAudioSnapshot, registerRafSnapshot,
    attachOverlay, detachOverlay, subscribe,
    getReport, getFrameSamples, getFpsBuckets, getMemSamples,
    getRecentLongTasks, getRecentLoaf, getResources, getErrors,
    getConsole, getCustomLogs, getRenderCounts, getWebVitals,
    getNotes, getAudioSnapshot, getRafSnapshot,
} from "./store";

export type {
    LogEntry, LogLevel, LongTaskEntry, LoafEntry, FrameSample,
    MemorySample, ResourceEntry, ErrorEntry, RenderCountEntry,
    WebVitals, AudioSnapshot, RafSchedulerSnapshot, DebugReport,
} from "./store";

// Client-only React hook; safe to re-export because the underlying module
// has a "use client" directive — Next treats this as a client reference
// even when imported from a server module (the server-side `dlog` etc.
// remain available without dragging React in).
export { useRenderCount } from "./use-render-count";

/** Format the report as a compact, copy-pasteable Markdown block. */
export function formatReport(r: DebugReport): string {
    const fmt = (n: number | null | undefined, d = 1) => (n == null ? "—" : n.toFixed(d));
    const lines: string[] = [];
    lines.push(`# Debug Report`);
    lines.push(`Generated: ${r.generatedAt}`);
    lines.push(`Session start: ${r.sessionStart}  ·  Uptime: ${(r.uptimeMs / 1000).toFixed(1)} s`);
    lines.push(`URL: ${r.url}`);
    lines.push(`Viewport: ${r.viewport.w}×${r.viewport.h} @${r.viewport.dpr}x`);
    lines.push(`UA: ${r.userAgent}`);
    lines.push("");

    lines.push(`## FPS`);
    lines.push(`current=${r.fps.current}  avg1s=${fmt(r.fps.avg1s)}  avg5s=${fmt(r.fps.avg5s)}  avg30s=${fmt(r.fps.avg30s)}  avg60s=${fmt(r.fps.avg60s)}`);
    lines.push(`min=${r.fps.min}  max=${r.fps.max}  p1=${r.fps.p1}  p5=${r.fps.p5}  jank%=${fmt(r.fps.jankPct)}`);
    lines.push("");

    lines.push(`## Frame time (ms)`);
    lines.push(`avg=${fmt(r.frameTime.avg, 2)}  p50=${fmt(r.frameTime.p50, 2)}  p95=${fmt(r.frameTime.p95, 2)}  p99=${fmt(r.frameTime.p99, 2)}  max=${fmt(r.frameTime.max, 2)}  n=${r.frameTime.samples}`);
    lines.push("");

    if (r.memory) {
        lines.push(`## Memory (MB)`);
        lines.push(`used=${fmt(r.memory.used, 1)}  total=${fmt(r.memory.total, 1)}  limit=${fmt(r.memory.limit, 1)}`);
        lines.push("");
    }

    lines.push(`## Web Vitals`);
    lines.push(`LCP=${fmt(r.webVitals.lcp, 0)} ms  FCP=${fmt(r.webVitals.fcp, 0)} ms  CLS=${fmt(r.webVitals.cls, 3)}  INP=${fmt(r.webVitals.inp, 0)} ms  TTFB=${fmt(r.webVitals.ttfb, 0)} ms`);
    lines.push("");

    lines.push(`## Long tasks (>50 ms)`);
    lines.push(`count=${r.longTasks.count}  total=${fmt(r.longTasks.totalMs, 0)} ms  longest=${fmt(r.longTasks.longestMs, 1)} ms`);
    for (const e of r.longTasks.recent.slice(-10)) {
        lines.push(`  · ${fmt(e.duration, 1)} ms @ ${fmt(e.t, 0)} ms — ${e.attribution || e.name}`);
    }
    lines.push("");

    if (r.loaf.count > 0) {
        lines.push(`## Long animation frames (LoAF)`);
        lines.push(`count=${r.loaf.count}  total=${fmt(r.loaf.totalMs, 0)} ms  longest=${fmt(r.loaf.longestMs, 1)} ms`);
        for (const e of r.loaf.recent.slice(-5)) {
            lines.push(`  · ${fmt(e.duration, 1)} ms (blocking ${fmt(e.blockingDuration, 1)}) — scripts: ${e.scripts.map(s => `${s.name}=${fmt(s.duration, 1)}`).join(", ")}`);
        }
        lines.push("");
    }

    if (r.audio) {
        lines.push(`## Audio context`);
        lines.push("```json");
        lines.push(JSON.stringify(r.audio, null, 2));
        lines.push("```");
        lines.push("");
    }

    if (r.rafScheduler) {
        lines.push(`## RAF scheduler`);
        lines.push("```json");
        lines.push(JSON.stringify(r.rafScheduler, null, 2));
        lines.push("```");
        lines.push("");
    }

    if (r.renderCounts.length > 0) {
        lines.push(`## Top render counts`);
        for (const rc of r.renderCounts.slice(0, 20)) {
            lines.push(`  · ${rc.count.toString().padStart(5)}  ${rc.name}  (last Δ=${fmt(rc.lastDelta, 0)} ms)`);
        }
        lines.push("");
    }

    if (r.errors.length > 0) {
        lines.push(`## Errors (${r.errors.length})`);
        for (const e of r.errors.slice(-10)) {
            lines.push(`  · [${e.kind}] ${e.message}${e.source ? ` @ ${e.source}:${e.line}:${e.col}` : ""}`);
            if (e.stack) {
                lines.push("    " + e.stack.split("\n").slice(0, 4).join("\n    "));
            }
        }
        lines.push("");
    }

    if (r.customLogs.length > 0) {
        lines.push(`## Custom logs (last ${Math.min(30, r.customLogs.length)})`);
        for (const e of r.customLogs.slice(-30)) {
            lines.push(`  · ${e.level.padEnd(5)} [${e.category}] ${e.msg}`);
        }
        lines.push("");
    }

    if (r.console.length > 0) {
        lines.push(`## Console (last 30)`);
        for (const e of r.console.slice(-30)) {
            lines.push(`  · ${e.level.padEnd(5)} ${e.msg.slice(0, 200)}`);
        }
        lines.push("");
    }

    if (r.resources.recent.length > 0) {
        lines.push(`## Recent resources (last 10)`);
        for (const e of r.resources.recent.slice(-10)) {
            lines.push(`  · ${fmt(e.duration, 0)} ms ${(e.transferSize / 1024).toFixed(1)} KB [${e.initiator}] ${e.name.slice(-80)}`);
        }
        lines.push("");
    }

    if (r.notes.length > 0) {
        lines.push(`## Notes`);
        for (const n of r.notes) lines.push(`  · ${n}`);
        lines.push("");
    }

    return lines.join("\n");
}

/** Copy a fresh report to clipboard. Returns the formatted string. */
export async function copyReport(): Promise<string> {
    const r = getReport();
    const text = formatReport(r);
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        // Fallback: legacy execCommand
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* ignore */ }
        document.body.removeChild(ta);
    }
    return text;
}
