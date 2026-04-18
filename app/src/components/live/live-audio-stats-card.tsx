"use client";

/**
 * LiveAudioStatsCard — Realtime stats for the Live audio engine.
 *
 * Renders alongside the standard PerformancePanel inside the "Performance"
 * widget. Self-subscribing: pulls AudioContext static info on a 1Hz interval,
 * and live meter values from `useLiveMetersField` (which already taps the
 * external store at the user-configured refresh rate).
 *
 * No rerender storms: the only React state touched per-frame is two tiny
 * fields fed by the same store the rest of the meters use.
 */

import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
    Activity, Gauge, Waves, Mic, Disc3, Square, Circle, Music,
    Cpu, Headphones, Radio, Layers,
} from "lucide-react";
import { useLive } from "./live-context";
import { useLiveMetersField } from "./live-meters-store";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDb(linear: number): number {
    return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}
function fmtDb(linear: number): string {
    const db = toDb(linear);
    if (!isFinite(db)) return "-∞";
    return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}
function fmtMs(s: number): string {
    return `${(s * 1000).toFixed(2)}ms`;
}
function fmtKhz(hz: number): string {
    return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`;
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function Row({ icon: Icon, label, value, color, mono }: {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    color?: string;
    mono?: boolean;
}) {
    return (
        <div className="flex items-center gap-1.5">
            <Icon className="h-2.5 w-2.5 shrink-0 text-white/20" />
            <div className="flex items-center justify-between flex-1 min-w-0">
                <span className="text-[7px] uppercase tracking-wider text-white/25 truncate">{label}</span>
                <span className={cn(
                    "text-[7px] tabular-nums font-medium shrink-0",
                    mono && "font-mono",
                    color || "text-white/55",
                )}>{value}</span>
            </div>
        </div>
    );
}

function MeterBar({ label, peak, color }: { label: string; peak: number; color: string }) {
    const db = toDb(peak);
    const pct = Math.max(0, Math.min(100, ((isFinite(db) ? db : -60) + 60) / 60 * 100));
    const isHot = db > -3;
    const isWarn = db > -12;
    const barColor = isHot ? "bg-rose-500" : isWarn ? "bg-amber-500" : color;
    return (
        <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[7px] uppercase tracking-wider text-white/25 w-3 shrink-0">{label}</span>
            <div className="flex-1 min-w-0">
                <div className="h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
                    <div className={cn("h-full rounded-full transition-[width] duration-75", barColor)} style={{ width: `${pct}%` }} />
                </div>
            </div>
            <span className={cn(
                "text-[7px] tabular-nums font-mono shrink-0 w-10 text-right",
                isHot ? "text-rose-400" : isWarn ? "text-amber-400" : "text-white/45",
            )}>{fmtDb(peak)}</span>
        </div>
    );
}

// ─── Live-subscribing leaf components ────────────────────────────────────────
// Each subscribes to ONE field of the meters store so they re-render at the
// user-configured Hz without dragging the rest of the card along.

const MasterMetersBars = memo(function MasterMetersBars() {
    const peakL = useLiveMetersField(s => s.masterPeakL);
    const peakR = useLiveMetersField(s => s.masterPeakR);
    return (
        <div className="space-y-1">
            <MeterBar label="L" peak={peakL} color="bg-emerald-500" />
            <MeterBar label="R" peak={peakR} color="bg-emerald-500" />
        </div>
    );
});

const VoiceMetersBars = memo(function VoiceMetersBars() {
    const peakL = useLiveMetersField(s => s.voicePeakL);
    const peakR = useLiveMetersField(s => s.voicePeakR);
    return (
        <div className="space-y-1">
            <MeterBar label="L" peak={peakL} color="bg-rose-500" />
            <MeterBar label="R" peak={peakR} color="bg-rose-500" />
        </div>
    );
});

const RmsRow = memo(function RmsRow() {
    const rms = useLiveMetersField(s => s.voiceRms);
    return <Row icon={Waves} label="Voice RMS" value={fmtDb(rms) + " dB"} mono />;
});

const LimitingRow = memo(function LimitingRow() {
    const limiting = useLiveMetersField(s => s.isLimiting);
    return (
        <Row icon={Activity} label="Limiter"
            value={limiting ? "ACTIVE" : "idle"}
            color={limiting ? "text-rose-400 animate-pulse" : "text-emerald-400/70"} />
    );
});

const PitchRow = memo(function PitchRow() {
    const note = useLiveMetersField(s => s.tunerNote);
    const cents = useLiveMetersField(s => s.tunerCents);
    const conf = useLiveMetersField(s => s.tunerConfidence);
    const freq = useLiveMetersField(s => s.tunerFrequency);
    if (!freq || conf < 0.3) {
        return <Row icon={Mic} label="Pitch" value="—" />;
    }
    const inTune = Math.abs(cents) <= 8;
    return (
        <Row icon={Mic} label="Pitch"
            value={`${note} ${cents > 0 ? "+" : ""}${cents}¢`}
            color={inTune ? "text-emerald-400" : "text-amber-400"}
            mono />
    );
});

// ─── Main card ───────────────────────────────────────────────────────────────

export const LiveAudioStatsCard = memo(function LiveAudioStatsCard({ className }: { className?: string }) {
    const live = useLive();
    const engine = live.engine;
    const [tick, setTick] = useState(0);

    // Slow poll for things that don't change frame-to-frame: ctx state,
    // sample rate, latency, currentTime, fx counts. 1Hz is plenty.
    useEffect(() => {
        const id = window.setInterval(() => setTick(t => t + 1), 1000);
        return () => window.clearInterval(id);
    }, []);
    void tick;

    if (!engine) {
        return (
            <div className={cn("rounded-lg bg-white/[0.03] border border-white/[0.06] p-2 w-[220px] lg:w-[260px] xl:w-[300px]", className)}>
                <div className="text-[8px] text-white/30 text-center py-3">Audio engine not ready</div>
            </div>
        );
    }

    const ctx = engine.ctx;
    const ctxState = ctx.state;
    const sampleRate = ctx.sampleRate;
    const baseLatency = ctx.baseLatency ?? 0;
    const outputLatency = (ctx as unknown as { outputLatency?: number }).outputLatency ?? 0;
    const renderQuantumMs = (128 / sampleRate) * 1000;
    const totalLatencyMs = (baseLatency + outputLatency) * 1000 + renderQuantumMs;
    const bufferSamples = Math.round(baseLatency * sampleRate);
    const currentTime = ctx.currentTime;
    const uptimeMin = Math.floor(currentTime / 60);
    const uptimeSec = Math.floor(currentTime % 60);

    const voiceFxCount = live.voiceChain.length;
    const voiceFxEnabled = live.voiceChain.filter(i => i.enabled).length;
    const activeLoopers = engine.state.loopers.filter(l => l.state === "playing" || l.state === "overdubbing").length;
    const armedLoopers = engine.state.loopers.filter(l => l.state === "recording").length;
    const loadedLoopers = engine.state.loopers.filter(l => l.state !== "empty").length;
    const playingPads = engine.state.pads.filter(p => p.isPlaying).length;
    const loadedPads = engine.state.pads.filter(p => p.buffer !== null).length;

    const ctxStateColor =
        ctxState === "running" ? "text-emerald-400"
            : ctxState === "suspended" ? "text-amber-400"
                : "text-rose-400";

    const latencyColor =
        totalLatencyMs > 30 ? "text-rose-400"
            : totalLatencyMs > 15 ? "text-amber-400"
                : "text-emerald-400/80";

    return (
        <div className={cn(
            "rounded-lg bg-white/[0.03] border border-white/[0.06] p-1.5 lg:p-2 w-[220px] lg:w-[260px] xl:w-[300px]",
            className,
        )}>
            <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1">
                    <Radio className="h-2.5 w-2.5 text-rose-400/60" />
                    <span className="text-[8px] lg:text-[9px] uppercase tracking-wider text-white/35">Audio Engine</span>
                </div>
                <div className={cn("h-1.5 w-1.5 rounded-full",
                    ctxState === "running" ? "bg-emerald-500" : ctxState === "suspended" ? "bg-amber-500" : "bg-rose-500",
                )} title={`AudioContext: ${ctxState}`} />
            </div>

            <div className="grid grid-cols-2 gap-x-2.5 gap-y-0">
                {/* ── Left Column: Engine ── */}
                <div className="flex flex-col gap-1">
                    <span className="text-[6px] uppercase tracking-widest text-white/15 mb-0.5">Engine</span>
                    <Row icon={Cpu} label="State" value={ctxState} color={ctxStateColor} />
                    <Row icon={Gauge} label="Sample Rate" value={fmtKhz(sampleRate)} mono />
                    <Row icon={Activity} label="Latency"
                        value={`${totalLatencyMs.toFixed(1)}ms`}
                        color={latencyColor} mono />
                    <Row icon={Layers} label="Buffer" value={`${bufferSamples} smp`} mono />
                    <Row icon={Gauge} label="Quantum" value={`${renderQuantumMs.toFixed(2)}ms`} mono />
                    <Row icon={Headphones} label="Out Lat" value={fmtMs(outputLatency)} mono />
                    <Row icon={Activity} label="Uptime"
                        value={`${uptimeMin}m ${String(uptimeSec).padStart(2, "0")}s`}
                        mono />
                </div>

                {/* ── Right Column: Signal ── */}
                <div className="flex flex-col gap-1">
                    <span className="text-[6px] uppercase tracking-widest text-white/15 mb-0.5">Signal</span>
                    <span className="text-[6px] text-white/20 leading-none">Master</span>
                    <MasterMetersBars />
                    <LimitingRow />
                    <span className="text-[6px] text-white/20 leading-none mt-0.5">Voice</span>
                    <VoiceMetersBars />
                    <RmsRow />
                    <PitchRow />
                </div>
            </div>

            {/* Bottom row: chain + sources */}
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-0 mt-1.5 pt-1.5 border-t border-white/[0.04]">
                <div className="flex flex-col gap-1">
                    <Row icon={Mic} label="Voice"
                        value={live.voiceActive ? "LIVE" : "off"}
                        color={live.voiceActive ? "text-rose-400" : "text-white/40"} />
                    <Row icon={Activity} label="FX Chain"
                        value={`${voiceFxEnabled}/${voiceFxCount}`}
                        color={voiceFxEnabled > 0 ? "text-emerald-400/80" : "text-white/40"} />
                    <Row icon={Music} label="Backing"
                        value={!live.backingLoaded ? "—" : live.backingIsPlaying ? "PLAY" : "stop"}
                        color={live.backingIsPlaying ? "text-blue-400" : "text-white/40"} />
                </div>
                <div className="flex flex-col gap-1">
                    <Row icon={Circle} label="Recording"
                        value={live.isRecording ? "REC" : "idle"}
                        color={live.isRecording ? "text-rose-400 animate-pulse" : "text-white/40"} />
                    <Row icon={Disc3} label="Loopers"
                        value={`${activeLoopers}▶ ${armedLoopers}● ${loadedLoopers}/4`}
                        color={armedLoopers > 0 ? "text-rose-400" : activeLoopers > 0 ? "text-emerald-400/80" : "text-white/40"}
                        mono />
                    <Row icon={Square} label="Pads"
                        value={`${playingPads}▶ ${loadedPads}/8`}
                        color={playingPads > 0 ? "text-purple-400" : "text-white/40"}
                        mono />
                </div>
            </div>
        </div>
    );
});
