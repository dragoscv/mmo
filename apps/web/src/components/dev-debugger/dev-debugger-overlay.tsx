"use client";

/**
 * DevDebuggerOverlay — Floating, draggable, resizable diagnostics window.
 *
 * Tabs: Overview · FPS · Memory · Long Tasks · Audio · Renders · Network · Logs · Errors
 *
 * Self-throttled: re-renders at ~4 fps (low overhead) regardless of how
 * busy the underlying telemetry is.
 */

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
    attachOverlay, detachOverlay, subscribe, getReport,
    getFpsBuckets, getFrameSamples, getMemSamples,
    getRecentLongTasks, getRecentLoaf, getResources,
    getErrors, getConsole, getCustomLogs, getRenderCounts,
    getWebVitals, getAudioSnapshot, getRafSnapshot,
    clearAll, addNote,
} from "@/lib/dev-debugger";
import { copyReport, formatReport } from "@/lib/dev-debugger";
import {
    X, Copy, Trash2, Pause, Play, GripVertical,
    Activity, Cpu, AlertTriangle, FileText, Network, Box, Layers, Volume2, Bug,
} from "lucide-react";

type Tab = "overview" | "fps" | "memory" | "longtasks" | "audio" | "renders" | "network" | "logs" | "errors";

const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: "overview", label: "Overview", icon: Bug },
    { id: "fps", label: "FPS", icon: Activity },
    { id: "memory", label: "Memory", icon: Cpu },
    { id: "longtasks", label: "Long Tasks", icon: AlertTriangle },
    { id: "audio", label: "Audio", icon: Volume2 },
    { id: "renders", label: "Renders", icon: Layers },
    { id: "network", label: "Network", icon: Network },
    { id: "logs", label: "Logs", icon: FileText },
    { id: "errors", label: "Errors", icon: AlertTriangle },
];

interface Props { open: boolean; onClose: () => void; }

// ─── Throttled tick subscription (4 fps) ─────────────────────────────────

let tickListeners = new Set<() => void>();
let tickTimer = 0;
let tickValue = 0;

function ensureTick() {
    if (tickTimer) return;
    tickTimer = window.setInterval(() => {
        tickValue++;
        for (const fn of tickListeners) fn();
    }, 250);
}
function stopTickIfIdle() {
    if (tickListeners.size === 0 && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = 0;
    }
}
function useTick(): number {
    return useSyncExternalStore(
        (cb) => {
            tickListeners.add(cb);
            ensureTick();
            return () => { tickListeners.delete(cb); stopTickIfIdle(); };
        },
        () => tickValue,
        () => 0,
    );
}

// ─── Component ───────────────────────────────────────────────────────────

export const DevDebuggerOverlay = memo(function DevDebuggerOverlay({ open, onClose }: Props) {
    const [tab, setTab] = useState<Tab>("overview");
    const [paused, setPaused] = useState(false);
    const [pos, setPos] = useState({ x: 24, y: 80 });
    const [size, setSize] = useState({ w: 560, h: 480 });
    const [copied, setCopied] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => { setMounted(true); }, []);

    useEffect(() => {
        if (!open) return;
        attachOverlay();
        return () => detachOverlay();
    }, [open]);

    // Keep listening to store updates (cheap notify) so e.g. error tab updates
    // immediately on a thrown exception even between ticks.
    useEffect(() => {
        if (!open || paused) return;
        return subscribe(() => { tickValue++; for (const fn of tickListeners) fn(); });
    }, [open, paused]);

    // Drag
    const dragRef = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null);
    const onDragStart = (e: React.PointerEvent) => {
        dragRef.current = { ox: e.clientX, oy: e.clientY, px: pos.x, py: pos.y };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    };
    const onDragMove = (e: React.PointerEvent) => {
        if (!dragRef.current) return;
        const d = dragRef.current;
        setPos({
            x: Math.max(0, Math.min(window.innerWidth - 100, d.px + (e.clientX - d.ox))),
            y: Math.max(0, Math.min(window.innerHeight - 40, d.py + (e.clientY - d.oy))),
        });
    };
    const onDragEnd = () => { dragRef.current = null; };

    // Resize
    const resizeRef = useRef<{ ox: number; oy: number; pw: number; ph: number } | null>(null);
    const onResizeStart = (e: React.PointerEvent) => {
        resizeRef.current = { ox: e.clientX, oy: e.clientY, pw: size.w, ph: size.h };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        e.stopPropagation();
    };
    const onResizeMove = (e: React.PointerEvent) => {
        if (!resizeRef.current) return;
        const d = resizeRef.current;
        setSize({
            w: Math.max(360, d.pw + (e.clientX - d.ox)),
            h: Math.max(280, d.ph + (e.clientY - d.oy)),
        });
    };
    const onResizeEnd = () => { resizeRef.current = null; };

    if (!mounted || !open) return null;

    const onCopy = async () => {
        await copyReport();
        setCopied(true);
        addNote("Report copied to clipboard");
        setTimeout(() => setCopied(false), 1500);
    };
    const onDownload = () => {
        const text = formatReport(getReport());
        const blob = new Blob([text], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `debug-report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return createPortal(
        <div
            className="fixed z-[9999] flex flex-col rounded-lg border border-white/10 bg-[#0b0b0e]/95 backdrop-blur-md shadow-2xl text-white text-xs select-none overflow-hidden"
            style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
            onPointerMove={(e) => { onDragMove(e); onResizeMove(e); }}
            onPointerUp={() => { onDragEnd(); onResizeEnd(); }}
        >
            {/* Header */}
            <div
                className="flex items-center gap-2 px-2 py-1.5 border-b border-white/10 bg-white/[0.03] cursor-move"
                onPointerDown={onDragStart}
            >
                <GripVertical className="h-3.5 w-3.5 text-white/30" />
                <Bug className="h-3.5 w-3.5 text-emerald-400" />
                <span className="font-semibold text-[11px]">Dev Debugger</span>
                <span className="text-white/30 text-[10px] ml-1">{paused ? "(paused)" : "(live)"}</span>
                <div className="ml-auto flex items-center gap-1">
                    <IconBtn title={paused ? "Resume" : "Pause"} onClick={() => setPaused((p) => !p)}>
                        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                    </IconBtn>
                    <IconBtn title="Clear all telemetry" onClick={() => clearAll()}>
                        <Trash2 className="h-3 w-3" />
                    </IconBtn>
                    <IconBtn title="Download report (.md)" onClick={onDownload}>
                        <FileText className="h-3 w-3" />
                    </IconBtn>
                    <IconBtn title="Copy report to clipboard" onClick={onCopy} highlight={copied}>
                        <Copy className="h-3 w-3" />
                        <span className="ml-1 text-[10px]">{copied ? "Copied!" : "Copy"}</span>
                    </IconBtn>
                    <IconBtn title="Close" onClick={onClose}>
                        <X className="h-3 w-3" />
                    </IconBtn>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-0.5 px-1 py-1 border-b border-white/10 bg-white/[0.02] overflow-x-auto shrink-0">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-colors ${tab === t.id ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70 hover:bg-white/5"
                            }`}
                    >
                        <t.icon className="h-3 w-3" />
                        {t.label}
                    </button>
                ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-auto p-2 font-mono">
                {!paused && <TabBody tab={tab} />}
                {paused && <div className="text-white/40 italic p-4">Telemetry paused. Click ▶ to resume.</div>}
            </div>

            {/* Resize grip */}
            <div
                className="absolute right-0 bottom-0 h-3 w-3 cursor-nwse-resize"
                style={{ background: "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%)" }}
                onPointerDown={onResizeStart}
            />
        </div>,
        document.body,
    );
});

function IconBtn({ children, title, onClick, highlight }: {
    children: React.ReactNode; title: string; onClick: () => void; highlight?: boolean;
}) {
    return (
        <button
            title={title}
            onClick={onClick}
            className={`flex items-center px-1.5 py-1 rounded text-[10px] transition-colors ${highlight ? "bg-emerald-500/20 text-emerald-300" : "text-white/50 hover:text-white hover:bg-white/10"
                }`}
        >
            {children}
        </button>
    );
}

// ─── Tab body (re-renders @ ~4 fps via useTick) ──────────────────────────

function TabBody({ tab }: { tab: Tab }) {
    useTick(); // subscribe to throttled refresh

    switch (tab) {
        case "overview": return <OverviewTab />;
        case "fps": return <FpsTab />;
        case "memory": return <MemoryTab />;
        case "longtasks": return <LongTasksTab />;
        case "audio": return <AudioTab />;
        case "renders": return <RendersTab />;
        case "network": return <NetworkTab />;
        case "logs": return <LogsTab />;
        case "errors": return <ErrorsTab />;
    }
}

// ─── Tabs ────────────────────────────────────────────────────────────────

function OverviewTab() {
    const r = getReport();
    return (
        <div className="space-y-2">
            <Section title="FPS">
                <Grid cols={5}>
                    <Stat label="now" value={r.fps.current} />
                    <Stat label="1s" value={r.fps.avg1s.toFixed(1)} />
                    <Stat label="5s" value={r.fps.avg5s.toFixed(1)} />
                    <Stat label="30s" value={r.fps.avg30s.toFixed(1)} />
                    <Stat label="60s" value={r.fps.avg60s.toFixed(1)} />
                </Grid>
                <Grid cols={5} className="mt-1">
                    <Stat label="min" value={r.fps.min} />
                    <Stat label="p1" value={r.fps.p1} />
                    <Stat label="p5" value={r.fps.p5} />
                    <Stat label="max" value={r.fps.max} />
                    <Stat label="jank%" value={r.fps.jankPct.toFixed(1)} warn={r.fps.jankPct > 5} />
                </Grid>
            </Section>
            <Section title="Frame time (ms)">
                <Grid cols={5}>
                    <Stat label="avg" value={r.frameTime.avg.toFixed(2)} />
                    <Stat label="p50" value={r.frameTime.p50.toFixed(2)} />
                    <Stat label="p95" value={r.frameTime.p95.toFixed(2)} warn={r.frameTime.p95 > 16.7} />
                    <Stat label="p99" value={r.frameTime.p99.toFixed(2)} warn={r.frameTime.p99 > 33} />
                    <Stat label="max" value={r.frameTime.max.toFixed(2)} warn={r.frameTime.max > 50} />
                </Grid>
            </Section>
            {r.memory && (
                <Section title="Memory (MB)">
                    <Grid cols={3}>
                        <Stat label="used" value={r.memory.used.toFixed(1)} />
                        <Stat label="total" value={r.memory.total.toFixed(1)} />
                        <Stat label="limit" value={r.memory.limit.toFixed(1)} />
                    </Grid>
                </Section>
            )}
            <Section title="Web Vitals">
                <Grid cols={5}>
                    <Stat label="LCP" value={r.webVitals.lcp == null ? "—" : `${r.webVitals.lcp.toFixed(0)}ms`} warn={(r.webVitals.lcp ?? 0) > 2500} />
                    <Stat label="FCP" value={r.webVitals.fcp == null ? "—" : `${r.webVitals.fcp.toFixed(0)}ms`} />
                    <Stat label="CLS" value={r.webVitals.cls == null ? "—" : r.webVitals.cls.toFixed(3)} warn={(r.webVitals.cls ?? 0) > 0.1} />
                    <Stat label="INP" value={r.webVitals.inp == null ? "—" : `${r.webVitals.inp.toFixed(0)}ms`} warn={(r.webVitals.inp ?? 0) > 200} />
                    <Stat label="TTFB" value={r.webVitals.ttfb == null ? "—" : `${r.webVitals.ttfb.toFixed(0)}ms`} />
                </Grid>
            </Section>
            <Section title="Activity">
                <Grid cols={4}>
                    <Stat label="long tasks" value={r.longTasks.count} warn={r.longTasks.count > 5} />
                    <Stat label="LoAF" value={r.loaf.count} warn={r.loaf.count > 5} />
                    <Stat label="errors" value={r.errors.length} warn={r.errors.length > 0} />
                    <Stat label="resources" value={r.resources.count} />
                </Grid>
            </Section>
        </div>
    );
}

function FpsTab() {
    const buckets = getFpsBuckets();
    const samples = getFrameSamples();
    return (
        <div className="space-y-3">
            <div>
                <div className="text-[10px] text-white/40 mb-1">Per-second FPS (last {buckets.length} s)</div>
                <Sparkline values={buckets.map((b) => b.frames)} max={Math.max(120, ...buckets.map((b) => b.frames))} height={60} />
            </div>
            <div>
                <div className="text-[10px] text-white/40 mb-1">Frame times (ms, last {samples.length} frames)</div>
                <Sparkline values={samples.map((s) => s.dt)} max={50} height={60} colorFn={(v) => v > 33 ? "#f43f5e" : v > 16.7 ? "#fbbf24" : "#34d399"} />
            </div>
        </div>
    );
}

function MemoryTab() {
    const samples = getMemSamples();
    if (samples.length === 0) return <Empty>No memory data (browser may not expose performance.memory).</Empty>;
    const last = samples[samples.length - 1];
    return (
        <div className="space-y-3">
            <Grid cols={3}>
                <Stat label="used MB" value={last.used.toFixed(1)} />
                <Stat label="total MB" value={last.total.toFixed(1)} />
                <Stat label="limit MB" value={last.limit.toFixed(1)} />
            </Grid>
            <div>
                <div className="text-[10px] text-white/40 mb-1">JS heap used (MB) over last {samples.length} s</div>
                <Sparkline values={samples.map((s) => s.used)} max={last.limit} height={70} colorFn={() => "#60a5fa"} />
            </div>
        </div>
    );
}

function LongTasksTab() {
    const lt = getRecentLongTasks(50);
    const loaf = getRecentLoaf(20);
    return (
        <div className="space-y-3">
            <div>
                <div className="text-[10px] text-white/40 mb-1">Long tasks (&gt;50 ms) — {lt.length}</div>
                {lt.length === 0 ? <Empty>No long tasks recorded.</Empty> : (
                    <div className="space-y-0.5">
                        {lt.slice().reverse().map((e, i) => (
                            <Row key={i} cols={[`${e.duration.toFixed(1)} ms`, `@${(e.t / 1000).toFixed(1)}s`, e.attribution || e.name]} warn={e.duration > 100} />
                        ))}
                    </div>
                )}
            </div>
            {loaf.length > 0 && (
                <div>
                    <div className="text-[10px] text-white/40 mb-1">Long animation frames — {loaf.length}</div>
                    <div className="space-y-1">
                        {loaf.slice().reverse().map((e, i) => (
                            <div key={i} className="bg-white/[0.03] rounded px-2 py-1">
                                <div className="flex gap-3 text-[10px]">
                                    <span className={e.duration > 50 ? "text-amber-400" : "text-white/70"}>{e.duration.toFixed(1)} ms</span>
                                    <span className="text-white/40">block {e.blockingDuration.toFixed(1)} ms</span>
                                </div>
                                {e.scripts.length > 0 && (
                                    <div className="text-[9px] text-white/40 mt-0.5">
                                        {e.scripts.map((s, j) => <div key={j}>· {s.name} — {s.duration.toFixed(1)} ms{s.invoker ? ` (${s.invoker})` : ""}</div>)}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function AudioTab() {
    const a = getAudioSnapshot();
    const s = getRafSnapshot();
    return (
        <div className="space-y-3">
            <Section title="AudioContext">
                {a ? <Json value={a} /> : <Empty>No audio snapshot registered. Call registerAudioSnapshot() from your engine.</Empty>}
            </Section>
            <Section title="RAF Scheduler">
                {s ? <Json value={s} /> : <Empty>No RAF scheduler snapshot registered.</Empty>}
            </Section>
        </div>
    );
}

function RendersTab() {
    const rc = getRenderCounts();
    if (rc.length === 0) return <Empty>No render counts recorded. Use <code>useRenderCount(&quot;Name&quot;)</code> in components.</Empty>;
    return (
        <div className="space-y-0.5">
            <Row cols={["count", "last Δ", "name"]} header />
            {rc.slice(0, 80).map((e) => (
                <Row key={e.name} cols={[String(e.count), `${e.lastDelta.toFixed(0)} ms`, e.name]} warn={e.count > 1000 && e.lastDelta < 16.7} />
            ))}
        </div>
    );
}

function NetworkTab() {
    const r = getResources(80);
    if (r.length === 0) return <Empty>No resources captured.</Empty>;
    return (
        <div className="space-y-0.5">
            <Row cols={["dur", "size", "type", "url"]} header />
            {r.slice().reverse().map((e, i) => (
                <Row key={i}
                    cols={[
                        `${e.duration.toFixed(0)}ms`,
                        `${(e.transferSize / 1024).toFixed(1)}KB`,
                        e.initiator,
                        e.name.length > 80 ? "…" + e.name.slice(-78) : e.name,
                    ]}
                    warn={e.duration > 1000}
                />
            ))}
        </div>
    );
}

function LogsTab() {
    const cl = getCustomLogs(500);
    const cs = getConsole(500);
    const merged = [...cl.map(e => ({ ...e, src: "custom" as const })), ...cs.map(e => ({ ...e, src: "console" as const }))]
        .sort((a, b) => a.t - b.t).slice(-600);

    const [filter, setFilter] = useState("");
    const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

    // Build the filtered view. Filter matches against category, level OR
    // message text — gives the user one box that does what they expect.
    const visible = filter.trim()
        ? merged.filter(e => {
            const f = filter.toLowerCase();
            return e.category.toLowerCase().includes(f)
                || e.level.toLowerCase().includes(f)
                || e.msg.toLowerCase().includes(f);
        })
        : merged;

    // Format for clipboard. Uses wall-clock + relative timestamp so the
    // user can correlate with their own observations ("at 2:14:35 the
    // sound changed"). `data` is JSON-stringified inline on one line so
    // the export pastes cleanly into bug reports / chat.
    const exportText = (entries: typeof merged) => entries
        .map(e => {
            const wall = e.wallTs ? new Date(e.wallTs).toISOString() : "";
            const rel = `+${(e.t / 1000).toFixed(2)}s`;
            const data = (e as { data?: unknown }).data !== undefined
                ? ` ${JSON.stringify((e as { data?: unknown }).data)}`
                : "";
            return `${wall} ${rel.padStart(10)} ${e.level.toUpperCase().padEnd(5)} [${e.category}] ${e.msg}${data}`;
        })
        .join("\n");

    const onCopy = async () => {
        try {
            await navigator.clipboard.writeText(exportText(visible));
            setCopyState("copied");
            setTimeout(() => setCopyState("idle"), 1500);
        } catch {
            // Clipboard API blocked — fall back to a textarea select+copy.
            const ta = document.createElement("textarea");
            ta.value = exportText(visible);
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); setCopyState("copied"); setTimeout(() => setCopyState("idle"), 1500); }
            catch { /* give up */ }
            document.body.removeChild(ta);
        }
    };

    if (merged.length === 0) return <Empty>No log entries.</Empty>;

    return (
        <div className="space-y-1">
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-black/60 backdrop-blur-md p-1 rounded -mx-1">
                <input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter by category, level, or text…"
                    className="flex-1 px-2 py-1 text-[10px] bg-white/[0.04] border border-white/[0.08] rounded outline-none focus:border-white/20 text-white/80 placeholder:text-white/25 font-mono"
                />
                <span className="text-[9px] text-white/40 tabular-nums shrink-0">
                    {visible.length}/{merged.length}
                </span>
                <button
                    type="button"
                    onClick={onCopy}
                    className={`text-[10px] px-2 py-1 rounded border transition-colors ${copyState === "copied"
                            ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                            : "bg-white/[0.05] border-white/[0.1] text-white/70 hover:bg-white/[0.1]"
                        }`}
                    title="Copy filtered logs to clipboard"
                >
                    {copyState === "copied" ? "Copied!" : "Copy"}
                </button>
            </div>
            <div className="space-y-0.5">
                {visible.slice().reverse().map((e, i) => (
                    <div key={i} className="flex gap-2 px-1 py-0.5 hover:bg-white/[0.03] rounded">
                        <span className="text-white/30 text-[9px] w-12 shrink-0">{(e.t / 1000).toFixed(1)}s</span>
                        <span className={`text-[9px] w-10 shrink-0 ${levelColor(e.level)}`}>{e.level}</span>
                        <span className="text-white/40 text-[9px] w-20 shrink-0 truncate" title={e.category}>[{e.category}]</span>
                        <span className="text-white/80 text-[10px] break-all">{e.msg}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ErrorsTab() {
    const errs = getErrors();
    if (errs.length === 0) return <Empty>No errors captured. 🟢</Empty>;
    return (
        <div className="space-y-1">
            {errs.slice().reverse().map((e, i) => (
                <div key={i} className="bg-rose-500/5 border border-rose-500/20 rounded p-2">
                    <div className="flex gap-2 text-[10px]">
                        <span className="text-rose-400 font-semibold uppercase">{e.kind}</span>
                        <span className="text-white/40">@ {(e.t / 1000).toFixed(1)}s</span>
                        {e.source && <span className="text-white/40">{e.source}:{e.line}:{e.col}</span>}
                    </div>
                    <div className="text-rose-200 text-[11px] mt-0.5">{e.message}</div>
                    {e.stack && <pre className="text-[9px] text-white/40 mt-1 whitespace-pre-wrap">{e.stack}</pre>}
                </div>
            ))}
        </div>
    );
}

// ─── Primitives ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-[9px] uppercase tracking-wider text-white/40 mb-1">{title}</div>
            {children}
        </div>
    );
}

function Grid({ cols, children, className }: { cols: number; children: React.ReactNode; className?: string }) {
    return <div className={`grid gap-1 ${className ?? ""}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>{children}</div>;
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
    return (
        <div className={`bg-white/[0.03] rounded px-1.5 py-1 ${warn ? "ring-1 ring-amber-500/40" : ""}`}>
            <div className="text-[8px] uppercase text-white/30">{label}</div>
            <div className={`text-[12px] tabular-nums ${warn ? "text-amber-300" : "text-white"}`}>{value}</div>
        </div>
    );
}

function Row({ cols, header, warn }: { cols: (string | number)[]; header?: boolean; warn?: boolean }) {
    return (
        <div className={`grid gap-2 px-1 py-0.5 rounded ${header ? "text-[8px] uppercase text-white/30 border-b border-white/5" : warn ? "bg-amber-500/5 text-amber-200" : "hover:bg-white/[0.03] text-white/80"}`}
            style={{ gridTemplateColumns: cols.map((_, i) => i === cols.length - 1 ? "1fr" : "auto").join(" ") }}>
            {cols.map((c, i) => <span key={i} className="text-[10px] tabular-nums truncate">{c}</span>)}
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div className="text-white/40 italic p-3 text-[11px]">{children}</div>;
}

function Json({ value }: { value: unknown }) {
    return <pre className="text-[10px] bg-white/[0.03] rounded p-2 overflow-auto whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>;
}

function levelColor(l: string) {
    switch (l) {
        case "error": return "text-rose-400";
        case "warn": return "text-amber-400";
        case "debug": return "text-white/40";
        default: return "text-sky-300";
    }
}

function Sparkline({ values, max, height, colorFn }: {
    values: number[]; max: number; height: number; colorFn?: (v: number) => string;
}) {
    if (values.length === 0) return <div style={{ height }} className="bg-white/[0.03] rounded" />;
    const w = Math.max(values.length, 60);
    const bw = 100 / w;
    return (
        <svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="bg-white/[0.03] rounded">
            {values.map((v, i) => {
                const h = Math.max(0.5, (Math.min(v, max) / max) * height);
                const x = i * bw;
                const fill = colorFn ? colorFn(v) : "#34d399";
                return <rect key={i} x={x} y={height - h} width={bw} height={h} fill={fill} />;
            })}
        </svg>
    );
}
