/**
 * dev-debugger / store
 * ────────────────────
 * Central, app-agnostic, **always-on (cheap) + opt-in (deeper)** performance
 * & debugging telemetry store. Designed to be:
 *
 *   • Drop-in reusable across apps  (no app-specific imports)
 *   • Zero-cost when the overlay is closed (collectors lazy-attach)
 *   • Bounded-memory (ring buffers everywhere — never leaks)
 *   • Read via getReport() for copy-to-clipboard sharing
 *
 * What we capture
 * ───────────────
 *   FPS               — per-second buckets (60 buckets = 1 min history)
 *   Frame times       — rolling histogram (last 1024 frames)
 *   Long tasks        — PerformanceObserver "longtask"
 *   Long anim frames  — PerformanceObserver "long-animation-frame" (LoAF)
 *   Memory            — performance.memory snapshots every 1 s
 *   Web Vitals        — LCP, CLS, INP, FCP, TTFB
 *   Resource timing   — last 200 fetch / xhr / img / script entries
 *   Console capture   — last 500 log/info/warn/error entries (intercepted)
 *   Error capture     — window.onerror + unhandledrejection
 *   Custom logs       — dlog(category, msg, data?)
 *   User marks        — dmark(label) / dtime(label) → performance.measure
 *   Render counts     — useRenderCount(name) per component
 *   Audio context     — caller registers a snapshot fn (engine-agnostic)
 *   RAF scheduler     — caller registers a snapshot fn (scheduler-agnostic)
 *
 * Always-on (cheap) — installed once on first import in the browser:
 *   error capture, unhandledrejection capture, frame-time RAF.
 *
 * Heavy collectors (PerformanceObservers, console intercept) attach lazily
 * when the overlay mounts, and detach again when it unmounts, so the
 * production cost when nothing is open is negligible.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
    t: number;              // performance.now() at insertion
    wallTs: number;         // Date.now() at insertion (for export)
    level: LogLevel;
    category: string;
    msg: string;
    data?: unknown;
}

export interface LongTaskEntry {
    t: number;
    duration: number;       // ms
    name: string;
    attribution?: string;
}

export interface LoafEntry {
    t: number;
    duration: number;       // ms
    blockingDuration: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: { name: string; duration: number; invoker?: string }[];
}

export interface FrameSample {
    t: number;        // performance.now()
    dt: number;       // ms since previous frame
}

export interface MemorySample {
    t: number;
    used: number;     // MB
    total: number;    // MB
    limit: number;    // MB
}

export interface ResourceEntry {
    t: number;
    name: string;
    initiator: string;
    duration: number;
    transferSize: number;
    decodedSize: number;
}

export interface ErrorEntry {
    t: number;
    wallTs: number;
    kind: "error" | "rejection";
    message: string;
    source?: string;
    line?: number;
    col?: number;
    stack?: string;
}

export interface RenderCountEntry {
    name: string;
    count: number;
    last: number;       // performance.now() of last render
    lastDelta: number;  // ms since previous render
}

export interface WebVitals {
    lcp: number | null;
    cls: number | null;
    inp: number | null;
    fcp: number | null;
    ttfb: number | null;
}

export interface AudioSnapshot {
    state: string;
    sampleRate: number;
    baseLatency: number;
    outputLatency: number;
    currentTime: number;
    [k: string]: unknown;
}

export interface RafSchedulerSnapshot {
    subscribers: number;
    running: boolean;
    [k: string]: unknown;
}

export interface DebugReport {
    generatedAt: string;
    sessionStart: string;
    uptimeMs: number;
    url: string;
    userAgent: string;
    viewport: { w: number; h: number; dpr: number };
    fps: { current: number; avg1s: number; avg5s: number; avg30s: number; avg60s: number; min: number; max: number; p1: number; p5: number; jankPct: number };
    frameTime: { avg: number; p50: number; p95: number; p99: number; max: number; samples: number };
    memory: MemorySample | null;
    webVitals: WebVitals;
    longTasks: { count: number; totalMs: number; longestMs: number; recent: LongTaskEntry[] };
    loaf: { count: number; totalMs: number; longestMs: number; recent: LoafEntry[] };
    audio: AudioSnapshot | null;
    rafScheduler: RafSchedulerSnapshot | null;
    renderCounts: RenderCountEntry[];
    resources: { count: number; totalKb: number; recent: ResourceEntry[] };
    errors: ErrorEntry[];
    console: LogEntry[];
    customLogs: LogEntry[];
    notes: string[];
}

// ─── Ring buffer ─────────────────────────────────────────────────────────

class Ring<T> {
    private buf: T[];
    private idx = 0;
    private len = 0;
    constructor(public readonly cap: number) {
        this.buf = new Array(cap);
    }
    push(v: T) {
        this.buf[this.idx] = v;
        this.idx = (this.idx + 1) % this.cap;
        if (this.len < this.cap) this.len++;
    }
    /** Returns oldest → newest. */
    toArray(): T[] {
        if (this.len < this.cap) return this.buf.slice(0, this.len);
        return this.buf.slice(this.idx).concat(this.buf.slice(0, this.idx));
    }
    last(n: number): T[] {
        const a = this.toArray();
        return a.slice(Math.max(0, a.length - n));
    }
    clear() { this.idx = 0; this.len = 0; this.buf = new Array(this.cap); }
    get size() { return this.len; }
}

// ─── Module state ────────────────────────────────────────────────────────

const isBrowser = typeof window !== "undefined";

const SESSION_START_WALL = isBrowser ? Date.now() : 0;
const SESSION_START_PERF = isBrowser ? performance.now() : 0;

// Frame samples (last ~17 s @ 60 fps, ~8 s @ 120 fps)
const frameSamples = new Ring<FrameSample>(1024);

// Per-second FPS buckets (60 = last minute)
interface FpsBucket { tSec: number; frames: number; }
const fpsBuckets = new Ring<FpsBucket>(60);
let currentBucket: FpsBucket | null = null;

// Memory samples (last 5 minutes @ 1 sample/s)
const memSamples = new Ring<MemorySample>(300);

const longTasks = new Ring<LongTaskEntry>(256);
let longTaskTotalMs = 0;
let longTaskLongestMs = 0;
let longTaskCount = 0;

const loafEntries = new Ring<LoafEntry>(128);
let loafTotalMs = 0;
let loafLongestMs = 0;
let loafCount = 0;

const resources = new Ring<ResourceEntry>(200);
let resourceTotalBytes = 0;
let resourceCount = 0;

const errors = new Ring<ErrorEntry>(100);
const consoleEntries = new Ring<LogEntry>(500);
const customLogs = new Ring<LogEntry>(500);
const notes: string[] = [];

const renderCounts = new Map<string, RenderCountEntry>();

const webVitals: WebVitals = { lcp: null, cls: null, inp: null, fcp: null, ttfb: null };

// External snapshot providers (injected by app)
let audioSnapshotFn: (() => AudioSnapshot | null) | null = null;
let rafSnapshotFn: (() => RafSchedulerSnapshot | null) | null = null;

// Subscribers (overlay UI re-renders at low fps)
const subscribers = new Set<() => void>();

function notify() {
    for (const fn of subscribers) {
        try { fn(); } catch { /* ignore */ }
    }
}

// ─── Always-on collectors ────────────────────────────────────────────────

let alwaysOnInstalled = false;
let frameRafId = 0;
let lastFrameTs = 0;
let originalConsole: Partial<Pick<Console, "debug" | "info" | "log" | "warn" | "error">> | null = null;

function installAlwaysOn() {
    if (!isBrowser || alwaysOnInstalled) return;
    alwaysOnInstalled = true;

    // Frame timing — single, cheap RAF that runs forever once any consumer
    // exists. Cost: ~1 division + 1 ring push per frame. Negligible.
    const frameTick = (now: number) => {
        if (lastFrameTs > 0) {
            const dt = now - lastFrameTs;
            frameSamples.push({ t: now, dt });
            const sec = Math.floor(now / 1000);
            if (!currentBucket || currentBucket.tSec !== sec) {
                if (currentBucket) fpsBuckets.push(currentBucket);
                currentBucket = { tSec: sec, frames: 0 };
            }
            currentBucket.frames++;
        }
        lastFrameTs = now;
        frameRafId = requestAnimationFrame(frameTick);
    };
    frameRafId = requestAnimationFrame(frameTick);

    // Errors
    window.addEventListener("error", (ev) => {
        errors.push({
            t: performance.now(),
            wallTs: Date.now(),
            kind: "error",
            message: ev.message || String(ev.error),
            source: ev.filename,
            line: ev.lineno,
            col: ev.colno,
            stack: ev.error?.stack,
        });
        notify();
    });
    window.addEventListener("unhandledrejection", (ev) => {
        const r = ev.reason;
        errors.push({
            t: performance.now(),
            wallTs: Date.now(),
            kind: "rejection",
            message: r instanceof Error ? r.message : String(r),
            stack: r instanceof Error ? r.stack : undefined,
        });
        notify();
    });
}

// ─── Lazy heavy collectors (attach when overlay opens) ───────────────────

let heavyAttached = 0;        // ref-counted
let heavyObservers: PerformanceObserver[] = [];
let heavyMemTimer = 0;

function attachHeavy() {
    if (!isBrowser) return;
    heavyAttached++;
    if (heavyAttached > 1) return;

    // Long tasks
    try {
        const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                const e: LongTaskEntry = {
                    t: entry.startTime,
                    duration: entry.duration,
                    name: entry.name,
                    attribution: (entry as PerformanceEntry & { attribution?: { name: string }[] }).attribution?.[0]?.name,
                };
                longTasks.push(e);
                longTaskCount++;
                longTaskTotalMs += entry.duration;
                if (entry.duration > longTaskLongestMs) longTaskLongestMs = entry.duration;
            }
            notify();
        });
        po.observe({ type: "longtask", buffered: true });
        heavyObservers.push(po);
    } catch { /* unsupported */ }

    // Long animation frames (LoAF) — Chrome 123+
    try {
        const po = new PerformanceObserver((list) => {
            type LoafScript = { name: string; duration: number; invoker?: string };
            type LoafPerfEntry = PerformanceEntry & {
                blockingDuration?: number;
                renderStart?: number;
                styleAndLayoutStart?: number;
                scripts?: LoafScript[];
            };
            for (const entry of list.getEntries() as LoafPerfEntry[]) {
                const scripts = (entry.scripts || []).slice(0, 8).map((s) => ({
                    name: s.name,
                    duration: s.duration,
                    invoker: s.invoker,
                }));
                const e: LoafEntry = {
                    t: entry.startTime,
                    duration: entry.duration,
                    blockingDuration: entry.blockingDuration ?? 0,
                    renderStart: entry.renderStart ?? 0,
                    styleAndLayoutStart: entry.styleAndLayoutStart ?? 0,
                    scripts,
                };
                loafEntries.push(e);
                loafCount++;
                loafTotalMs += entry.duration;
                if (entry.duration > loafLongestMs) loafLongestMs = entry.duration;
            }
            notify();
        });
        po.observe({ type: "long-animation-frame", buffered: true });
        heavyObservers.push(po);
    } catch { /* unsupported */ }

    // Resource timing
    try {
        const po = new PerformanceObserver((list) => {
            for (const entry of list.getEntriesByType("resource")) {
                const r = entry as PerformanceResourceTiming;
                const e: ResourceEntry = {
                    t: r.startTime,
                    name: r.name,
                    initiator: r.initiatorType,
                    duration: r.duration,
                    transferSize: r.transferSize || 0,
                    decodedSize: r.decodedBodySize || 0,
                };
                resources.push(e);
                resourceCount++;
                resourceTotalBytes += r.transferSize || 0;
            }
        });
        po.observe({ type: "resource", buffered: true });
        heavyObservers.push(po);
    } catch { /* unsupported */ }

    // Web Vitals (rough — not the official polyfill, but close enough for
    // in-app debugging without an extra dep).
    try {
        const lcpPo = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const last = entries[entries.length - 1];
            if (last) webVitals.lcp = last.startTime;
        });
        lcpPo.observe({ type: "largest-contentful-paint", buffered: true });
        heavyObservers.push(lcpPo);

        const fcpPo = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
                if (e.name === "first-contentful-paint") webVitals.fcp = e.startTime;
            }
        });
        fcpPo.observe({ type: "paint", buffered: true });
        heavyObservers.push(fcpPo);

        const clsPo = new PerformanceObserver((list) => {
            let cls = webVitals.cls ?? 0;
            for (const e of list.getEntries() as (PerformanceEntry & { hadRecentInput?: boolean; value?: number })[]) {
                if (!e.hadRecentInput) cls += e.value ?? 0;
            }
            webVitals.cls = cls;
        });
        clsPo.observe({ type: "layout-shift", buffered: true });
        heavyObservers.push(clsPo);

        // INP via "event" entries (max duration is a reasonable INP proxy)
        const inpPo = new PerformanceObserver((list) => {
            let max = webVitals.inp ?? 0;
            for (const e of list.getEntries()) {
                if (e.duration > max) max = e.duration;
            }
            webVitals.inp = max;
        });
        try {
            inpPo.observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
        } catch {
            inpPo.observe({ type: "event", buffered: true });
        }
        heavyObservers.push(inpPo);

        // TTFB from navigation entry
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        if (nav) webVitals.ttfb = nav.responseStart;
    } catch { /* unsupported */ }

    // Memory poll (1 Hz)
    if ((performance as unknown as { memory?: unknown }).memory) {
        heavyMemTimer = window.setInterval(() => {
            const mem = (performance as unknown as { memory: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
            memSamples.push({
                t: performance.now(),
                used: mem.usedJSHeapSize / 1048576,
                total: mem.totalJSHeapSize / 1048576,
                limit: mem.jsHeapSizeLimit / 1048576,
            });
        }, 1000);
    }

    // Console interception
    if (!originalConsole) {
        originalConsole = {
            debug: console.debug.bind(console),
            info: console.info.bind(console),
            log: console.log.bind(console),
            warn: console.warn.bind(console),
            error: console.error.bind(console),
        };
        const wrap = (level: LogLevel, original: (...a: unknown[]) => void) => (...args: unknown[]) => {
            try {
                consoleEntries.push({
                    t: performance.now(),
                    wallTs: Date.now(),
                    level,
                    category: "console",
                    msg: args.map(stringifyArg).join(" "),
                    data: args.length > 1 ? args : undefined,
                });
            } catch { /* never let logging break logging */ }
            original(...args);
        };
        console.debug = wrap("debug", originalConsole.debug as never);
        console.info = wrap("info", originalConsole.info as never);
        console.log = wrap("info", originalConsole.log as never);
        console.warn = wrap("warn", originalConsole.warn as never);
        console.error = wrap("error", originalConsole.error as never);
    }
}

function detachHeavy() {
    if (!isBrowser) return;
    heavyAttached = Math.max(0, heavyAttached - 1);
    if (heavyAttached > 0) return;

    for (const po of heavyObservers) {
        try { po.disconnect(); } catch { /* ignore */ }
    }
    heavyObservers = [];
    if (heavyMemTimer) {
        clearInterval(heavyMemTimer);
        heavyMemTimer = 0;
    }
    if (originalConsole) {
        if (originalConsole.debug) console.debug = originalConsole.debug;
        if (originalConsole.info) console.info = originalConsole.info;
        if (originalConsole.log) console.log = originalConsole.log;
        if (originalConsole.warn) console.warn = originalConsole.warn;
        if (originalConsole.error) console.error = originalConsole.error;
        originalConsole = null;
    }
}

function stringifyArg(a: unknown): string {
    if (a == null) return String(a);
    if (typeof a === "string") return a;
    if (typeof a === "number" || typeof a === "boolean") return String(a);
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
}

// ─── Public store API ────────────────────────────────────────────────────

if (isBrowser) installAlwaysOn();

export function subscribe(fn: () => void): () => void {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
}

export function attachOverlay() { attachHeavy(); }
export function detachOverlay() { detachHeavy(); }

// ─── Custom logs / marks ────────────────────────────────────────────────

export function dlog(category: string, msg: string, data?: unknown, level: LogLevel = "info") {
    if (!isBrowser) return;
    customLogs.push({ t: performance.now(), wallTs: Date.now(), level, category, msg, data });
    notify();
}

export function dmark(label: string) {
    if (!isBrowser) return;
    try { performance.mark(label); } catch { /* ignore */ }
    dlog("mark", label, undefined, "debug");
}

export function dtime<T>(label: string, fn: () => T): T {
    if (!isBrowser) return fn();
    const start = performance.now();
    const result = fn();
    const dur = performance.now() - start;
    dlog("timing", `${label} took ${dur.toFixed(2)} ms`, { ms: dur });
    return result;
}

export async function dtimeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!isBrowser) return fn();
    const start = performance.now();
    const result = await fn();
    const dur = performance.now() - start;
    dlog("timing", `${label} took ${dur.toFixed(2)} ms`, { ms: dur });
    return result;
}

export function bumpRenderCount(name: string) {
    const now = isBrowser ? performance.now() : 0;
    const e = renderCounts.get(name);
    if (e) {
        e.lastDelta = now - e.last;
        e.last = now;
        e.count++;
    } else {
        renderCounts.set(name, { name, count: 1, last: now, lastDelta: 0 });
    }
}

export function addNote(s: string) {
    notes.push(`[${new Date().toISOString()}] ${s}`);
    notify();
}

export function clearAll() {
    frameSamples.clear();
    fpsBuckets.clear();
    currentBucket = null;
    memSamples.clear();
    longTasks.clear();
    longTaskTotalMs = longTaskLongestMs = longTaskCount = 0;
    loafEntries.clear();
    loafTotalMs = loafLongestMs = loafCount = 0;
    resources.clear();
    resourceTotalBytes = resourceCount = 0;
    errors.clear();
    consoleEntries.clear();
    customLogs.clear();
    renderCounts.clear();
    notes.length = 0;
    webVitals.lcp = webVitals.cls = webVitals.inp = webVitals.fcp = webVitals.ttfb = null;
    notify();
}

// ─── Snapshot provider registration ─────────────────────────────────────

export function registerAudioSnapshot(fn: (() => AudioSnapshot | null) | null) {
    audioSnapshotFn = fn;
}
export function registerRafSnapshot(fn: (() => RafSchedulerSnapshot | null) | null) {
    rafSnapshotFn = fn;
}

// ─── Computed views ─────────────────────────────────────────────────────

function fpsForLastSeconds(seconds: number): number {
    if (!isBrowser) return 0;
    const buckets = fpsBuckets.toArray();
    if (currentBucket) buckets.push(currentBucket);
    if (buckets.length === 0) return 0;
    const cutoffSec = Math.floor(performance.now() / 1000) - seconds;
    let frames = 0, secs = 0;
    for (const b of buckets) {
        if (b.tSec > cutoffSec) { frames += b.frames; secs++; }
    }
    return secs > 0 ? frames / secs : 0;
}

function frameTimeStats() {
    const samples = frameSamples.toArray();
    if (samples.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0, samples: 0 };
    const dts = samples.map((s) => s.dt).sort((a, b) => a - b);
    const sum = dts.reduce((a, b) => a + b, 0);
    const pick = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
    return {
        avg: sum / dts.length,
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        max: dts[dts.length - 1],
        samples: dts.length,
    };
}

function fpsExtremes(): { min: number; max: number; p1: number; p5: number; jankPct: number } {
    const buckets = fpsBuckets.toArray();
    if (buckets.length === 0) return { min: 0, max: 0, p1: 0, p5: 0, jankPct: 0 };
    const fpsArr = buckets.map((b) => b.frames).sort((a, b) => a - b);
    const pick = (p: number) => fpsArr[Math.min(fpsArr.length - 1, Math.floor(fpsArr.length * p))];
    // jank% = fraction of frames whose dt > 33 ms (i.e. >2× a 60 fps frame)
    const samples = frameSamples.toArray();
    const jank = samples.filter((s) => s.dt > 33).length;
    const jankPct = samples.length > 0 ? (jank / samples.length) * 100 : 0;
    return { min: fpsArr[0], max: fpsArr[fpsArr.length - 1], p1: pick(0.01), p5: pick(0.05), jankPct };
}

export function getReport(): DebugReport {
    const ftStats = frameTimeStats();
    const ext = fpsExtremes();
    const memArr = memSamples.toArray();
    return {
        generatedAt: new Date().toISOString(),
        sessionStart: new Date(SESSION_START_WALL).toISOString(),
        uptimeMs: isBrowser ? performance.now() - SESSION_START_PERF : 0,
        url: isBrowser ? location.href : "",
        userAgent: isBrowser ? navigator.userAgent : "",
        viewport: isBrowser ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio } : { w: 0, h: 0, dpr: 1 },
        fps: {
            current: currentBucket?.frames ?? 0,
            avg1s: fpsForLastSeconds(1),
            avg5s: fpsForLastSeconds(5),
            avg30s: fpsForLastSeconds(30),
            avg60s: fpsForLastSeconds(60),
            min: ext.min,
            max: ext.max,
            p1: ext.p1,
            p5: ext.p5,
            jankPct: ext.jankPct,
        },
        frameTime: ftStats,
        memory: memArr.length > 0 ? memArr[memArr.length - 1] : null,
        webVitals: { ...webVitals },
        longTasks: { count: longTaskCount, totalMs: longTaskTotalMs, longestMs: longTaskLongestMs, recent: longTasks.last(20) },
        loaf: { count: loafCount, totalMs: loafTotalMs, longestMs: loafLongestMs, recent: loafEntries.last(20) },
        audio: audioSnapshotFn ? audioSnapshotFn() : null,
        rafScheduler: rafSnapshotFn ? rafSnapshotFn() : null,
        renderCounts: Array.from(renderCounts.values()).sort((a, b) => b.count - a.count).slice(0, 50),
        resources: { count: resourceCount, totalKb: resourceTotalBytes / 1024, recent: resources.last(20) },
        errors: errors.toArray(),
        console: consoleEntries.last(100),
        customLogs: customLogs.last(100),
        notes: [...notes],
    };
}

// ─── Lightweight live views (cheap reads for the overlay UI) ────────────

export function getFrameSamples() { return frameSamples.toArray(); }
export function getFpsBuckets() { return fpsBuckets.toArray().concat(currentBucket ? [currentBucket] : []); }
export function getMemSamples() { return memSamples.toArray(); }
export function getRecentLongTasks(n = 30) { return longTasks.last(n); }
export function getRecentLoaf(n = 30) { return loafEntries.last(n); }
export function getResources(n = 50) { return resources.last(n); }
export function getErrors() { return errors.toArray(); }
export function getConsole(n = 100) { return consoleEntries.last(n); }
export function getCustomLogs(n = 100) { return customLogs.last(n); }
export function getRenderCounts() { return Array.from(renderCounts.values()).sort((a, b) => b.count - a.count); }
export function getWebVitals() { return webVitals; }
export function getNotes() { return notes; }
export function getAudioSnapshot() { return audioSnapshotFn ? audioSnapshotFn() : null; }
export function getRafSnapshot() { return rafSnapshotFn ? rafSnapshotFn() : null; }
