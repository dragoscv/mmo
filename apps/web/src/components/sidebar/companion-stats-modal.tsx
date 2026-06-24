"use client";

/**
 * CompanionStatsModal — comprehensive details view for the connected
 * companion. Triggered from the sidebar status card.
 *
 * What it shows:
 *   - Header: product / version / OS / API URL / capabilities
 *   - Engine: running state, backend, sample rate, frame size, stream
 *     latency, DSP load, underruns, callback count, uptime, active FX
 *     count
 *   - Live meters: in/out peak + RMS (driven by 1Hz polling so the modal
 *     never floods the network even if it's left open all day; the Live
 *     page itself uses the WS at 30Hz for tight metering)
 *   - Devices: every audio device the companion can see, grouped by
 *     backend, with channel counts, default in/out badges, and supported
 *     sample rates
 *
 * Polling: while the dialog is open, /audio/native/info + /metrics are
 * polled at 1Hz. /devices is fetched ONCE on open (devices don't change
 * minute-to-minute and the Windows enumeration is expensive). Closing the
 * dialog cancels the in-flight requests.
 */

import { useEffect, useState } from "react";
import {
    Activity, AlertTriangle, Cpu, Gauge, Headphones, Layers, Mic,
    Power, Radio, RefreshCw, Server,
} from "lucide-react";
import {
    Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
    NativeCompanionClient,
    type AudioBackend,
    type NativeBackendInfo,
    type NativeDeviceInfo,
    type NativeMetrics,
} from "@/lib/native-companion";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtUptime(sec: number): string {
    if (!isFinite(sec) || sec <= 0) return "—";
    if (sec < 60) return `${sec.toFixed(0)}s`;
    if (sec < 3600) {
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}m ${String(s).padStart(2, "0")}s`;
    }
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtKhz(hz: number): string {
    if (!hz) return "—";
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

function platformLabel(p: string): string {
    return p === "win32" ? "Windows" : p === "darwin" ? "macOS" : p === "linux" ? "Linux" : p;
}

function backendLabel(b: AudioBackend | string): string {
    return ({
        asio: "ASIO", wasapi: "WASAPI", coreaudio: "CoreAudio",
        alsa: "ALSA", jack: "JACK", pulse: "PulseAudio", auto: "Auto",
    } as Record<string, string>)[b] ?? b;
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function StatRow({
    icon: Icon, label, value, hint, color,
}: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: React.ReactNode;
    hint?: string;
    color?: string;
}) {
    return (
        <div className="flex items-start gap-2 py-1">
            <Icon className="h-3 w-3 shrink-0 mt-0.5 text-white/30" />
            <div className="flex-1 min-w-0">
                <div className="text-[9px] uppercase tracking-wider text-white/35">{label}</div>
                {hint ? <div className="text-[9px] text-white/30 mt-0.5">{hint}</div> : null}
            </div>
            <div className={cn(
                "text-[11px] tabular-nums font-mono shrink-0 self-center",
                color ?? "text-white/80",
            )}>
                {value}
            </div>
        </div>
    );
}

function SectionHeader({ title }: { title: string }) {
    return (
        <div className="text-[9px] uppercase tracking-widest text-white/30 mt-3 mb-1.5 pb-1 border-b border-white/[0.06]">
            {title}
        </div>
    );
}

function MeterBar({ label, peak, rms }: { label: string; peak: number; rms: number }) {
    // dB conversion just for display — keep raw linear under the hood so
    // the modal feels in step with the inline meter cards.
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -120;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -120;
    const peakPct = Math.max(0, Math.min(100, ((peakDb < -60 ? -60 : peakDb) + 60) / 60 * 100));
    const rmsPct = Math.max(0, Math.min(100, ((rmsDb < -60 ? -60 : rmsDb) + 60) / 60 * 100));
    const hot = peakDb > -3;
    const warn = peakDb > -12;
    const color = hot ? "bg-rose-500" : warn ? "bg-amber-500" : "bg-emerald-500";
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px]">
                <span className="text-white/45">{label}</span>
                <span className={cn(
                    "tabular-nums font-mono",
                    hot ? "text-rose-400" : warn ? "text-amber-400" : "text-emerald-400/80",
                )}>
                    {isFinite(peakDb) ? `${peakDb > 0 ? "+" : ""}${peakDb.toFixed(1)} dB` : "-∞"}
                </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden relative">
                <div
                    className="absolute inset-y-0 left-0 bg-white/15 rounded-full transition-[width] duration-75"
                    style={{ width: `${rmsPct}%` }}
                />
                <div
                    className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-75", color)}
                    style={{ width: `${peakPct}%`, opacity: 0.9 }}
                />
            </div>
        </div>
    );
}

function DeviceCard({ device, isInput, isOutput }: {
    device: NativeDeviceInfo;
    isInput: boolean;
    isOutput: boolean;
}) {
    return (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.02] p-2">
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-white/85 truncate" title={device.name}>
                        {device.name}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {isInput && (
                            <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/25">
                                <Mic className="inline h-2 w-2 mr-0.5" /> Input
                            </span>
                        )}
                        {isOutput && (
                            <span className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                <Headphones className="inline h-2 w-2 mr-0.5" /> Output
                            </span>
                        )}
                        {device.isDefaultInput && (
                            <span className="text-[8px] uppercase tracking-wider text-amber-300/80">★ default in</span>
                        )}
                        {device.isDefaultOutput && (
                            <span className="text-[8px] uppercase tracking-wider text-amber-300/80">★ default out</span>
                        )}
                    </div>
                </div>
                <div className="text-right text-[9px] text-white/40 tabular-nums shrink-0">
                    <div>id {device.id}</div>
                    <div className="mt-0.5">
                        {device.inputChannels}in / {device.outputChannels}out
                    </div>
                </div>
            </div>
            <div className="mt-1.5 pt-1.5 border-t border-white/[0.04] grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px]">
                <div>
                    <span className="text-white/35">Preferred:</span>{" "}
                    <span className="text-white/70 font-mono tabular-nums">
                        {fmtKhz(device.preferredSampleRate)}
                    </span>
                </div>
                <div>
                    <span className="text-white/35">Supported:</span>{" "}
                    <span className="text-white/55 font-mono tabular-nums">
                        {device.sampleRates.length
                            ? device.sampleRates.slice(0, 4).map(r => `${(r / 1000).toFixed(0)}k`).join(", ") +
                            (device.sampleRates.length > 4 ? "…" : "")
                            : "—"}
                    </span>
                </div>
            </div>
        </div>
    );
}

// ─── Main modal ──────────────────────────────────────────────────────────────

interface CompanionStatsModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    apiUrl: string;
    version: string;
    platform: string;
    capabilities: string[];
}

interface DevicesGroup {
    backend: string;
    available: boolean;
    devices: NativeDeviceInfo[];
}

export function CompanionStatsModal({
    open, onOpenChange, apiUrl, version, platform, capabilities,
}: CompanionStatsModalProps) {
    const [client] = useState(() => new NativeCompanionClient({ apiUrl }));
    const [info, setInfo] = useState<{
        running: boolean;
        backends: NativeBackendInfo[];
        metrics: NativeMetrics;
    } | null>(null);
    const [deviceGroups, setDeviceGroups] = useState<DevicesGroup[]>([]);
    const [devicesLoading, setDevicesLoading] = useState(false);
    const [devicesError, setDevicesError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Live polling: /info every second while open. Provides the engine
    // running state, backends list, and live metrics. Stops on close so
    // we don't waste localhost requests when the modal isn't visible.
    useEffect(() => {
        if (!open) return;
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            try {
                const i = await client.info();
                if (!alive) return;
                setInfo({ running: i.running, backends: i.backends, metrics: i.metrics });
                setError(null);
            } catch (err) {
                if (!alive) return;
                setError(err instanceof Error ? err.message : String(err));
            }
            if (alive) timer = setTimeout(tick, 1000);
        };
        void tick();
        return () => {
            alive = false;
            if (timer) clearTimeout(timer);
        };
    }, [open, client]);

    // Devices: fetch once on open. Manual refresh via the button.
    useEffect(() => {
        if (!open) return;
        void loadDevices();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    async function loadDevices(forceRefresh = false) {
        setDevicesLoading(true);
        setDevicesError(null);
        try {
            // Hit the raw URL because the typed client only exposes a single
            // backend at a time; the modal wants the full grouped view that
            // /audio/native/devices returns when called without ?backend.
            const res = await fetch(
                `${apiUrl}/audio/native/devices${forceRefresh ? "?refresh=1" : ""}`,
                { cache: "no-store" },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            // The companion endpoint returns { backend, devices, backends, authorized }
            // where `backends` is the full per-backend grouped list. Older
            // companions (≤0.5.x) only returned `devices` for the auto-picked
            // backend; we fall back to that shape for compatibility.
            const body = await res.json() as {
                backends?: DevicesGroup[];
                backend?: string;
                devices?: NativeDeviceInfo[];
            };
            if (Array.isArray(body.backends) && body.backends.length > 0) {
                setDeviceGroups(body.backends);
            } else if (body.backend && Array.isArray(body.devices)) {
                setDeviceGroups([{ backend: body.backend, available: true, devices: body.devices }]);
            } else {
                setDeviceGroups([]);
            }
        } catch (err) {
            setDevicesError(err instanceof Error ? err.message : String(err));
        } finally {
            setDevicesLoading(false);
        }
    }

    const m = info?.metrics;
    const running = info?.running ?? false;
    const dspAvg = m?.dspBlockAvgMs ?? 0;
    const dspMax = m?.dspBlockMaxMs ?? 0;
    const blockMs = m && m.sampleRate > 0 ? (m.frameSize / m.sampleRate) * 1000 : 0;
    const dspLoadPct = blockMs > 0 ? Math.min(999, (dspAvg / blockMs) * 100) : 0;
    const dspColor = dspLoadPct > 90 ? "text-rose-400"
        : dspLoadPct > 70 ? "text-amber-400"
            : "text-emerald-400/80";
    const latencyColor = m && m.streamLatencyMs > 25 ? "text-rose-400"
        : m && m.streamLatencyMs > 15 ? "text-amber-400"
            : "text-emerald-400/80";
    const uptime = m && m.callbackCount && m.frameSize && m.sampleRate
        ? (m.callbackCount * m.frameSize) / m.sampleRate
        : 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto bg-zinc-950 border-white/[0.08]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-emerald-400" />
                        MuzicAI Companion
                        <span className="text-[10px] font-mono text-white/40">v{version}</span>
                    </DialogTitle>
                    <DialogDescription className="text-[11px]">
                        {platformLabel(platform)} · <span className="font-mono">{apiUrl}</span>
                        {capabilities.length > 0 && (
                            <span className="ml-2 text-white/35">
                                · {capabilities.join(", ")}
                            </span>
                        )}
                    </DialogDescription>
                </DialogHeader>

                {error && (
                    <div className="rounded-md bg-rose-500/10 border border-rose-500/20 p-2 text-[11px] text-rose-300 flex items-start gap-2">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <div>
                            <div className="font-medium">Companion unreachable</div>
                            <div className="text-[10px] text-rose-300/70 mt-0.5 font-mono">{error}</div>
                        </div>
                    </div>
                )}

                {/* ── Engine status ───────────────────────────────────────── */}
                <div>
                    <SectionHeader title="Audio Engine" />
                    <div className="grid grid-cols-2 gap-x-4">
                        <StatRow
                            icon={Power}
                            label="Status"
                            value={running ? "RUNNING" : "STOPPED"}
                            color={running ? "text-emerald-400" : "text-white/40"}
                        />
                        <StatRow
                            icon={Radio}
                            label="Backend"
                            value={m?.backend ? backendLabel(m.backend) : "—"}
                        />
                        <StatRow
                            icon={Gauge}
                            label="Sample Rate"
                            value={fmtKhz(m?.sampleRate ?? 0)}
                        />
                        <StatRow
                            icon={Layers}
                            label="Buffer"
                            value={m?.frameSize ? `${m.frameSize} smp` : "—"}
                            hint={blockMs > 0 ? `${blockMs.toFixed(2)} ms / block` : undefined}
                        />
                        <StatRow
                            icon={Activity}
                            label="Stream Latency"
                            value={m ? `${m.streamLatencyMs.toFixed(2)} ms` : "—"}
                            color={latencyColor}
                            hint={m?.streamLatencyFrames ? `${m.streamLatencyFrames} frames` : undefined}
                        />
                        <StatRow
                            icon={Cpu}
                            label="DSP Load"
                            value={running ? `${dspLoadPct.toFixed(0)}%` : "—"}
                            color={running ? dspColor : "text-white/40"}
                            hint={running ? `avg ${dspAvg.toFixed(2)} / max ${dspMax.toFixed(2)} ms` : undefined}
                        />
                        <StatRow
                            icon={AlertTriangle}
                            label="Underruns"
                            value={m?.underruns ?? 0}
                            color={m && m.underruns > 0 ? "text-rose-400" : "text-emerald-400/60"}
                        />
                        <StatRow
                            icon={Activity}
                            label="Uptime"
                            value={fmtUptime(uptime)}
                            hint={m?.callbackCount ? `${m.callbackCount.toLocaleString()} callbacks` : undefined}
                        />
                    </div>
                </div>

                {/* ── Live levels (only meaningful while running) ────────── */}
                {running && m && (m.inPeak !== undefined || m.outPeak !== undefined) && (
                    <div>
                        <SectionHeader title="Live Levels" />
                        <div className="grid grid-cols-2 gap-3">
                            <MeterBar label="Input" peak={m.inPeak ?? 0} rms={m.inRms ?? 0} />
                            <MeterBar label="Output" peak={m.outPeak ?? 0} rms={m.outRms ?? 0} />
                        </div>
                    </div>
                )}

                {/* ── Backends ───────────────────────────────────────────── */}
                <div>
                    <SectionHeader title="Available Backends" />
                    <div className="flex flex-wrap gap-1.5">
                        {info?.backends.map((b) => (
                            <span
                                key={b.backend}
                                className={cn(
                                    "text-[10px] px-2 py-0.5 rounded border tabular-nums",
                                    b.available
                                        ? "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"
                                        : "bg-white/[0.03] border-white/[0.06] text-white/30 line-through",
                                )}
                                title={b.apiName}
                            >
                                {backendLabel(b.backend)}
                            </span>
                        ))}
                        {!info && <span className="text-[10px] text-white/30">Loading…</span>}
                    </div>
                </div>

                {/* ── Devices ────────────────────────────────────────────── */}
                <div>
                    <div className="flex items-center justify-between mt-3 mb-1.5 pb-1 border-b border-white/[0.06]">
                        <span className="text-[9px] uppercase tracking-widest text-white/30">
                            Audio Devices
                        </span>
                        <button
                            onClick={() => loadDevices(true)}
                            disabled={devicesLoading}
                            className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-white/45 hover:text-white/70 disabled:opacity-40"
                            title="Re-enumerate devices"
                        >
                            <RefreshCw className={cn("h-2.5 w-2.5", devicesLoading && "animate-spin")} />
                            Refresh
                        </button>
                    </div>
                    {devicesError ? (
                        <div className="text-[10px] text-rose-300 font-mono">{devicesError}</div>
                    ) : devicesLoading && deviceGroups.length === 0 ? (
                        <div className="text-[10px] text-white/30">Enumerating…</div>
                    ) : (
                        <div className="space-y-2">
                            {deviceGroups
                                .filter(g => g.devices.length > 0)
                                .map((g) => (
                                    <div key={g.backend}>
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-[10px] uppercase tracking-wider text-white/55">
                                                {backendLabel(g.backend)}
                                            </span>
                                            <span className="text-[9px] text-white/30 tabular-nums">
                                                {g.devices.length} device{g.devices.length === 1 ? "" : "s"}
                                            </span>
                                        </div>
                                        <div className="space-y-1.5">
                                            {g.devices.map((d) => (
                                                <DeviceCard
                                                    key={`${g.backend}-${d.id}`}
                                                    device={d}
                                                    isInput={d.inputChannels > 0}
                                                    isOutput={d.outputChannels > 0}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            {deviceGroups.length > 0 && deviceGroups.every(g => g.devices.length === 0) && (
                                <div className="text-[10px] text-white/30">No devices detected.</div>
                            )}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
