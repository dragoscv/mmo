"use client";

import { memo, useState } from "react";
import { usePerformanceStats } from "@/hooks/use-performance-stats";
import { useSystemStats } from "@/hooks/use-system-stats";
import { usePersonalization } from "@/hooks/use-personalization";
import { useMixer } from "@/components/mixer-context";
import { PerfConfigModal } from "@/components/perf-config-modal";
import { cn } from "@/lib/utils";
import { Cpu, MemoryStick, Gauge, MonitorSpeaker, Box, RotateCw, Thermometer, Monitor, Settings2 } from "lucide-react";

// ─── Compact stat bar ────────────────────────────────────────────────────

function StatBar({ label, icon: Icon, value, max, unit, color, warn, crit }: {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    value: number;
    max: number;
    unit: string;
    color: string;
    warn?: number; // threshold % for amber
    crit?: number; // threshold % for red
}) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    const warnPct = warn ?? 70;
    const critPct = crit ?? 90;
    const barColor = pct >= critPct ? "bg-rose-500" : pct >= warnPct ? "bg-amber-500" : color;
    const textColor = pct >= critPct ? "text-rose-400" : pct >= warnPct ? "text-amber-400" : "text-white/50";

    return (
        <div className="flex items-center gap-1.5 min-w-0">
            <Icon className="h-2.5 w-2.5 shrink-0 text-white/20" />
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[7px] uppercase tracking-wider text-white/25 truncate">{label}</span>
                    <span className={cn("text-[7px] tabular-nums font-medium", textColor)}>
                        {value < 1000 ? value.toFixed(value < 10 ? 1 : 0) : `${(value / 1024).toFixed(1)}G`}{unit}
                    </span>
                </div>
                <div className="h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all duration-500", barColor)} style={{ width: `${pct}%` }} />
                </div>
            </div>
        </div>
    );
}

// ─── Inline variant (for header bar) ─────────────────────────────────────

function InlineStat({ label, value, unit, pct, warn, crit, minChars }: {
    label: string;
    value: string;
    unit: string;
    pct: number;
    warn?: number;
    crit?: number;
    minChars?: number;
}) {
    const warnPct = warn ?? 70;
    const critPct = crit ?? 90;
    const dotColor = pct >= critPct ? "bg-rose-500" : pct >= warnPct ? "bg-amber-500" : "bg-emerald-500";

    return (
        <div className="flex items-center gap-1">
            <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor)} />
            <span className="text-[8px] text-white/30">{label}</span>
            <span
                className="text-[8px] tabular-nums text-white/50 font-medium text-right"
                style={minChars ? { minWidth: `${minChars}ch` } : undefined}
            >{value}{unit}</span>
        </div>
    );
}

// ─── Compact one-line stat ────────────────────────────────────────────────

function CompactStat({ icon: Icon, label, value, color }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    color?: string;
}) {
    return (
        <div className="flex items-center gap-1.5">
            <Icon className="h-2.5 w-2.5 shrink-0 text-white/20" />
            <div className="flex items-center justify-between flex-1 min-w-0">
                <span className="text-[7px] uppercase tracking-wider text-white/25 truncate">{label}</span>
                <span className={cn("text-[7px] tabular-nums font-medium shrink-0", color || "text-white/50")}>{value}</span>
            </div>
        </div>
    );
}

// ─── Full panel (two columns: System + Browser) ─────────────────────────

export const PerformancePanel = memo(function PerformancePanel({ className }: { className?: string }) {
    const browser = usePerformanceStats();
    const personalization = usePersonalization();
    const cfg = personalization.perfConfig;
    const system = useSystemStats(cfg.gpuIndex, cfg.pollInterval);
    const [configOpen, setConfigOpen] = useState(false);

    const hasSystemStats = cfg.showCpu || cfg.showCpuTemp || cfg.showRam || cfg.showGpu || cfg.showGpuTemp || cfg.showVram;
    const hasBrowserStats = cfg.showFps || cfg.showTabMemory || cfg.showJsHeap || cfg.showDomNodes || cfg.showAudioLatency;
    const hasBothColumns = hasSystemStats && hasBrowserStats;

    return (
        <>
            <div className={cn("rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 w-[220px] lg:w-[260px] xl:w-[300px]", className)}>
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[8px] lg:text-[9px] uppercase tracking-wider text-white/20">Performance</span>
                    <div className="flex items-center gap-1.5">
                        <div className={cn("h-1.5 w-1.5 rounded-full", system.connected ? "bg-emerald-500" : "bg-white/10")} title={system.connected ? "System stats connected" : "Connecting..."} />
                        <button
                            onClick={() => setConfigOpen(true)}
                            className="text-white/15 hover:text-white/40 transition-colors cursor-pointer"
                            title="Configure performance monitor"
                        >
                            <Settings2 className="h-3 w-3" />
                        </button>
                    </div>
                </div>
                <div className={cn("grid gap-x-2.5 gap-y-0", hasBothColumns ? "grid-cols-2" : "grid-cols-1")}>
                    {/* ── Left Column: System ── */}
                    {hasSystemStats && (
                        <div className="flex flex-col gap-1">
                            {hasBothColumns && <span className="text-[6px] uppercase tracking-widest text-white/15 mb-0.5">System</span>}
                            {cfg.showCpu && (
                                <StatBar label="CPU" icon={Cpu} value={system.cpuUsage} max={100} unit="%" color="bg-orange-500" />
                            )}
                            {cfg.showCpuTemp && system.cpuTemp > 0 && (
                                <CompactStat icon={Thermometer} label="CPU Temp" value={`${system.cpuTemp}°C`} color={system.cpuTemp > 85 ? "text-rose-400" : system.cpuTemp > 70 ? "text-amber-400" : "text-white/50"} />
                            )}
                            {cfg.showRam && (
                                <StatBar label="RAM" icon={MemoryStick} value={system.ramUsed} max={system.ramTotal} unit="MB" color="bg-sky-500" />
                            )}
                            {cfg.showGpu && system.gpuModel !== "N/A" && system.gpuModel !== "" && (
                                <StatBar label="GPU" icon={Monitor} value={system.gpuUsage} max={100} unit="%" color="bg-emerald-500" />
                            )}
                            {cfg.showGpuTemp && system.gpuTemp > 0 && (
                                <CompactStat icon={Thermometer} label="GPU Temp" value={`${system.gpuTemp}°C`} color={system.gpuTemp > 85 ? "text-rose-400" : system.gpuTemp > 70 ? "text-amber-400" : "text-white/50"} />
                            )}
                            {cfg.showVram && system.gpuVramTotal > 0 && (
                                <StatBar label="VRAM" icon={Box} value={system.gpuVram} max={system.gpuVramTotal} unit="MB" color="bg-violet-500" />
                            )}
                        </div>
                    )}
                    {/* ── Right Column: Browser ── */}
                    {hasBrowserStats && (
                        <div className="flex flex-col gap-1">
                            {hasBothColumns && <span className="text-[6px] uppercase tracking-widest text-white/15 mb-0.5">Browser</span>}
                            {cfg.showFps && (
                                <StatBar label="FPS" icon={Gauge} value={browser.fps} max={60} unit="" color="bg-emerald-500" />
                            )}
                            {cfg.showTabMemory && (
                                <StatBar label="Tab Memory" icon={MemoryStick} value={browser.jsHeapUsed} max={browser.jsHeapLimit} unit="MB" color="bg-sky-500" />
                            )}
                            {cfg.showJsHeap && (
                                <StatBar label="JS Heap" icon={Box} value={browser.jsHeapTotal} max={browser.jsHeapLimit} unit="MB" color="bg-purple-500" />
                            )}
                            {cfg.showDomNodes && (
                                <StatBar label="DOM Nodes" icon={MonitorSpeaker} value={browser.domNodes} max={5000} unit="" color="bg-indigo-500" warn={60} crit={80} />
                            )}
                            {cfg.showAudioLatency && browser.audioLatency > 0 && (
                                <CompactStat icon={Gauge} label="Audio Lat" value={`${browser.audioLatency.toFixed(1)}ms`} color={browser.audioLatency > 20 ? "text-amber-400" : "text-white/50"} />
                            )}
                        </div>
                    )}
                </div>
            </div>
            <PerfConfigModal open={configOpen} onOpenChange={setConfigOpen} />
        </>
    );
});

// ─── Inline bar (for header) ─────────────────────────────────────────────

export const PerformanceInline = memo(function PerformanceInline({ className }: { className?: string }) {
    const stats = usePerformanceStats();
    const heapPct = stats.jsHeapLimit > 0 ? (stats.jsHeapUsed / stats.jsHeapLimit) * 100 : 0;
    const fpsPct = (stats.fps / 60) * 100;

    return (
        <div className={cn("flex items-center gap-2.5 lg:gap-3", className)}>
            <InlineStat label="FPS" value={String(stats.fps)} unit="" pct={100 - fpsPct} minChars={2} />
            <InlineStat label="Heap" value={stats.jsHeapUsed.toFixed(0)} unit="MB" pct={heapPct} minChars={5} />
            <InlineStat label="DOM" value={String(stats.domNodes)} unit="" pct={(stats.domNodes / 5000) * 100} minChars={4} />
            {stats.audioLatency > 0 && (
                <InlineStat label="Lat" value={stats.audioLatency.toFixed(1)} unit="ms" pct={stats.audioLatency > 20 ? 90 : stats.audioLatency > 10 ? 70 : 30} minChars={6} />
            )}
        </div>
    );
});

// ─── Session Restore Indicator (for header) ──────────────────────────────

export const SessionRestoreIndicator = memo(function SessionRestoreIndicator({ className }: { className?: string }) {
    const mixer = useMixer();
    if (!mixer.isRestoring && mixer.restorationProgress < 100) return null;

    const isDone = mixer.restorationProgress >= 100;

    return (
        <div className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md transition-all duration-500",
            isDone ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-purple-500/10 border border-purple-500/20",
            className,
        )}>
            <RotateCw
                className={cn("h-3 w-3 shrink-0", isDone ? "text-emerald-400" : "text-purple-400")}
                style={isDone ? undefined : { animationName: "spin", animationDuration: "1s", animationTimingFunction: "linear", animationIterationCount: "infinite" }}
            />
            <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn(
                    "text-[9px] font-medium whitespace-nowrap",
                    isDone ? "text-emerald-300" : "text-purple-300",
                )}>
                    {isDone ? "Session restored" : mixer.restorationLabel || "Restoring..."}
                </span>
                {!isDone && (
                    <div className="w-16 h-1 rounded-full bg-white/[0.08] overflow-hidden">
                        <div
                            className="h-full rounded-full bg-purple-500 transition-all duration-300"
                            style={{ width: `${mixer.restorationProgress}%` }}
                        />
                    </div>
                )}
                {!isDone && (
                    <span className="text-[8px] tabular-nums text-purple-300/60">{mixer.restorationProgress}%</span>
                )}
            </div>
        </div>
    );
});
