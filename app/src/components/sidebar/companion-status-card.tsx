"use client";

/**
 * CompanionStatusCard — replaces the static "Companion connected" pill
 * in the sidebar with a live, clickable summary that opens
 * CompanionStatsModal.
 *
 * Why a separate component (not inlined in companion-download-button):
 *   - The download button only mounts once per nav, so it can probe and
 *     stop. THIS card needs to keep its data fresh for as long as the
 *     sidebar is rendered. Keeping the polling here means the download
 *     path stays cheap.
 *   - Polls /audio/native/info at 2 Hz. Cheap (a single localhost JSON
 *     request) and gives the user a near-live view of latency, DSP load
 *     and underruns without opening the modal.
 *
 * Render variants:
 *   - Collapsed sidebar: 28×28 status dot. Green when running, white
 *     when idle, amber on underruns.
 *   - Expanded sidebar: two-line card with backend / latency / load /
 *     uptime, plus an XRUN badge when there have been any.
 *
 * Click: opens the stats modal (works in both layouts).
 */

import { useEffect, useState } from "react";
import { Server, Activity, AlertTriangle } from "lucide-react";
import { NativeCompanionClient, type NativeMetrics, type AudioBackend } from "@/lib/native-companion";
import { cn } from "@/lib/utils";
import { CompanionStatsModal } from "./companion-stats-modal";

interface Props {
    apiUrl: string;
    version: string;
    platform: string;
    capabilities: string[];
    collapsed?: boolean;
}

function backendLabel(b: AudioBackend | string | undefined): string {
    if (!b) return "—";
    return ({
        asio: "ASIO", wasapi: "WASAPI", coreaudio: "CoreAudio",
        alsa: "ALSA", jack: "JACK", pulse: "Pulse", auto: "Auto",
    } as Record<string, string>)[b] ?? b;
}

function fmtUptime(sec: number): string {
    if (!isFinite(sec) || sec <= 0) return "idle";
    if (sec < 60) return `${sec.toFixed(0)}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

export function CompanionStatusCard({
    apiUrl, version, platform, capabilities, collapsed = false,
}: Props) {
    const [client] = useState(() => new NativeCompanionClient({ apiUrl }));
    const [running, setRunning] = useState(false);
    const [metrics, setMetrics] = useState<NativeMetrics | null>(null);
    const [open, setOpen] = useState(false);

    // 2 Hz poll — cheap localhost call, gives near-live numbers in the
    // sidebar without an open modal. Auto-pauses while the modal is open
    // (the modal does its own 1 Hz poll and we don't need both).
    useEffect(() => {
        if (open) return;
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            try {
                const i = await client.info();
                if (!alive) return;
                setRunning(i.running);
                setMetrics(i.metrics);
            } catch {
                // Companion may have just exited — keep last known state
                // but flag it as not running so the dot turns white.
                if (alive) setRunning(false);
            }
            if (alive) timer = setTimeout(tick, 500);
        };
        void tick();
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [client, open]);

    const latencyMs = metrics?.streamLatencyMs ?? 0;
    const blockMs = metrics && metrics.sampleRate > 0
        ? (metrics.frameSize / metrics.sampleRate) * 1000
        : 0;
    const dspLoadPct = blockMs > 0 ? Math.min(999, ((metrics?.dspBlockAvgMs ?? 0) / blockMs) * 100) : 0;
    const uptime = metrics && metrics.callbackCount && metrics.frameSize && metrics.sampleRate
        ? (metrics.callbackCount * metrics.frameSize) / metrics.sampleRate
        : 0;
    const xruns = metrics?.underruns ?? 0;

    // Status dot color: red when xruns, green when running, white when idle.
    const dotClass = xruns > 0
        ? "bg-amber-500"
        : running
            ? "bg-emerald-500"
            : "bg-white/30";

    // ── COLLAPSED layout: status dot only ─────────────────────────────────
    if (collapsed) {
        return (
            <>
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-emerald-500 hover:bg-muted transition-colors relative"
                    title={`Companion v${version}${running ? ` · ${backendLabel(metrics?.backend)} · ${latencyMs.toFixed(1)} ms` : " · idle"}`}
                >
                    <Server className="h-4 w-4" />
                    <span className={cn(
                        "absolute top-1 right-1 h-1.5 w-1.5 rounded-full",
                        dotClass,
                        running && "animate-pulse",
                    )} />
                </button>
                <CompanionStatsModal
                    open={open}
                    onOpenChange={setOpen}
                    apiUrl={apiUrl}
                    version={version}
                    platform={platform}
                    capabilities={capabilities}
                />
            </>
        );
    }

    // ── EXPANDED layout: 2-line stats card ────────────────────────────────
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={cn(
                    "w-full text-left rounded-md border px-2 py-1.5 transition-colors",
                    running
                        ? "border-emerald-500/25 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.10]"
                        : "border-sidebar-border bg-sidebar hover:bg-muted",
                )}
                title="Open companion details"
            >
                {/* Top row: name + version + status dot */}
                <div className="flex items-center gap-1.5">
                    <Server className={cn("h-3 w-3", running ? "text-emerald-400" : "text-muted-foreground")} />
                    <span className={cn(
                        "text-[11px] font-medium flex-1",
                        running ? "text-emerald-300" : "text-foreground/80",
                    )}>
                        Companion
                    </span>
                    <span className="text-[9px] font-mono text-muted-foreground/70">v{version}</span>
                    <span className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        dotClass,
                        running && "animate-pulse",
                    )} />
                </div>

                {/* Bottom row: live stats. When idle, just shows "ready". */}
                {running ? (
                    <div className="flex items-center gap-2 mt-1 text-[9px] tabular-nums font-mono text-emerald-400/70">
                        <span title="Audio backend">{backendLabel(metrics?.backend)}</span>
                        <span className="text-emerald-400/30">·</span>
                        <span title="Stream latency" className={cn(
                            latencyMs > 25 ? "text-rose-400"
                                : latencyMs > 15 ? "text-amber-400"
                                    : "text-emerald-400/80",
                        )}>
                            {latencyMs.toFixed(1)}ms
                        </span>
                        <span className="text-emerald-400/30">·</span>
                        <span title="DSP load" className={cn(
                            dspLoadPct > 90 ? "text-rose-400"
                                : dspLoadPct > 70 ? "text-amber-400"
                                    : "text-emerald-400/70",
                        )}>
                            <Activity className="inline h-2 w-2 mr-0.5 -mt-px" />
                            {dspLoadPct.toFixed(0)}%
                        </span>
                        <span className="text-emerald-400/30">·</span>
                        <span title="Uptime">{fmtUptime(uptime)}</span>
                        {xruns > 0 && (
                            <span
                                title={`${xruns} buffer underrun${xruns === 1 ? "" : "s"}`}
                                className="ml-auto px-1 py-px rounded bg-amber-500/15 text-amber-300 text-[8px] uppercase tracking-wider flex items-center gap-0.5"
                            >
                                <AlertTriangle className="h-2 w-2" />
                                {xruns} XRUN
                            </span>
                        )}
                    </div>
                ) : (
                    <div className="mt-1 text-[9px] text-muted-foreground/60">
                        Ready · click for details
                    </div>
                )}
            </button>
            <CompanionStatsModal
                open={open}
                onOpenChange={setOpen}
                apiUrl={apiUrl}
                version={version}
                platform={platform}
                capabilities={capabilities}
            />
        </>
    );
}
