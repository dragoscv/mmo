"use client";

/**
 * RemotePerformanceWidget — Compact performance/network monitor for the
 * remote controller. Reusable across all host pages (DAW, Mixer, Editor,
 * Live). Shows browser FPS, heap, DOM nodes, and — when the controller is
 * connected — signaling RTT.
 *
 * Designed to be small enough for watch-sized screens (<300px wide).
 * Two layouts:
 *   - compact (default): single row of pills
 *   - full: two-column grid with bars (used on phone-sized screens)
 */

import { memo } from "react";
import { usePerformanceStats } from "@/hooks/use-performance-stats";
import { useRemoteOptional } from "./remote-context";
import { cn } from "@/lib/utils";
import { Gauge, MemoryStick, Network, Activity } from "lucide-react";

interface Props {
    className?: string;
    variant?: "compact" | "full";
}

function pctColor(pct: number, invert = false) {
    const p = invert ? 100 - pct : pct;
    if (p >= 85) return "text-rose-400";
    if (p >= 65) return "text-amber-400";
    return "text-emerald-400";
}

function dotColor(pct: number, invert = false) {
    const p = invert ? 100 - pct : pct;
    if (p >= 85) return "bg-rose-500";
    if (p >= 65) return "bg-amber-500";
    return "bg-emerald-500";
}

export const RemotePerformanceWidget = memo(function RemotePerformanceWidget({ className, variant = "compact" }: Props) {
    const stats = usePerformanceStats();
    const remote = useRemoteOptional();

    const heapPct = stats.jsHeapLimit > 0 ? (stats.jsHeapUsed / stats.jsHeapLimit) * 100 : 0;
    const fpsPct = (stats.fps / 60) * 100;
    const domPct = (stats.domNodes / 5000) * 100;
    const rtt = remote?.latency ?? 0;
    const rttPct = rtt > 300 ? 90 : rtt > 150 ? 70 : rtt > 50 ? 40 : 10;

    if (variant === "compact") {
        return (
            <div className={cn(
                "flex items-center gap-1.5 @[180px]:gap-2 text-[8px] @[180px]:text-[9px] tabular-nums",
                className,
            )}>
                <span className="flex items-center gap-0.5">
                    <span className={cn("w-1 h-1 rounded-full", dotColor(fpsPct, true))} />
                    <span className="text-white/30 uppercase tracking-wider hidden @[160px]:inline">FPS</span>
                    <span className={cn("font-bold", pctColor(fpsPct, true))}>{stats.fps}</span>
                </span>
                <span className="flex items-center gap-0.5">
                    <span className={cn("w-1 h-1 rounded-full", dotColor(heapPct))} />
                    <span className="text-white/30 uppercase tracking-wider hidden @[160px]:inline">MEM</span>
                    <span className={cn("font-bold", pctColor(heapPct))}>{stats.jsHeapUsed.toFixed(0)}<span className="text-white/30 text-[7px]">m</span></span>
                </span>
                {rtt > 0 && (
                    <span className="flex items-center gap-0.5">
                        <span className={cn("w-1 h-1 rounded-full", dotColor(rttPct))} />
                        <span className="text-white/30 uppercase tracking-wider hidden @[200px]:inline">RTT</span>
                        <span className={cn("font-bold", pctColor(rttPct))}>{rtt}<span className="text-white/30 text-[7px]">ms</span></span>
                    </span>
                )}
            </div>
        );
    }

    return (
        <div className={cn(
            "rounded-xl border border-white/[0.06] bg-white/[0.02] p-2 @container",
            className,
        )}>
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[8px] uppercase tracking-widest text-white/30 font-bold">Performance</span>
                <Activity className="w-2.5 h-2.5 text-white/20" />
            </div>
            <div className="grid grid-cols-2 @[220px]:grid-cols-4 gap-1.5 text-[9px]">
                <Pill icon={Gauge} label="FPS" value={stats.fps} pct={fpsPct} invert />
                <Pill icon={MemoryStick} label="Heap" value={`${stats.jsHeapUsed.toFixed(0)}M`} pct={heapPct} />
                <Pill label="DOM" value={stats.domNodes > 999 ? `${(stats.domNodes / 1000).toFixed(1)}k` : String(stats.domNodes)} pct={domPct} />
                {rtt > 0 && <Pill icon={Network} label="RTT" value={`${rtt}ms`} pct={rttPct} />}
            </div>
        </div>
    );
});

function Pill({ icon: Icon, label, value, pct, invert }: {
    icon?: React.ComponentType<{ className?: string }>;
    label: string;
    value: string | number;
    pct: number;
    invert?: boolean;
}) {
    return (
        <div className="flex flex-col gap-0.5 px-1.5 py-1 rounded-md bg-white/[0.03] border border-white/[0.04]">
            <div className="flex items-center gap-1">
                {Icon && <Icon className="w-2.5 h-2.5 text-white/25" />}
                <span className="text-[7px] text-white/30 uppercase tracking-wider truncate">{label}</span>
            </div>
            <div className="flex items-center gap-1">
                <span className={cn("w-1 h-1 rounded-full shrink-0", dotColor(pct, invert))} />
                <span className={cn("text-[10px] font-bold tabular-nums", pctColor(pct, invert))}>{value}</span>
            </div>
        </div>
    );
}
