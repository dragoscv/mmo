"use client";

import { useDAW } from "./daw-context";
import {
    Play, Pause, Square, Circle, SkipBack,
    Repeat,
} from "lucide-react";
import { cn } from "@/lib/utils";

export function DAWTransport() {
    const daw = useDAW();

    const beats = daw.currentBeat;
    const bar = Math.floor(beats / daw.project.timeSignature.numerator) + 1;
    const beat = Math.floor(beats % daw.project.timeSignature.numerator) + 1;
    const tick = Math.floor((beats % 1) * 960);

    return (
        <div className="h-12 bg-[var(--daw-bg)] border-b border-[var(--daw-border)] flex items-center px-3 gap-3 daw-animate-in daw-stagger-1">
            {/* Position display */}
            <div className="flex items-center bg-[var(--daw-surface)] rounded-lg px-3 py-1.5 gap-0.5 font-mono min-w-[150px] border border-[var(--daw-border)]">
                <span className="text-[9px] text-[var(--daw-text-dim)] mr-1.5 uppercase tracking-widest">Pos</span>
                <span className="text-lg font-bold text-[var(--daw-green)] tabular-nums leading-none">{bar}</span>
                <span className="text-[var(--daw-text-dim)] mx-0.5 text-sm">·</span>
                <span className="text-lg font-bold text-[var(--daw-green)] tabular-nums leading-none">{beat}</span>
                <span className="text-[var(--daw-text-dim)] mx-0.5 text-sm">·</span>
                <span className="text-sm text-[var(--daw-green)] opacity-60 tabular-nums w-8 leading-none">{String(tick).padStart(3, "0")}</span>
            </div>

            {/* Transport controls */}
            <div className="flex items-center gap-1 bg-[var(--daw-surface)] rounded-lg p-1 border border-[var(--daw-border)]">
                <TransportBtn icon={SkipBack} label="Rewind" onClick={daw.stop} />
                <TransportBtn
                    icon={daw.isPlaying ? Pause : Play}
                    label={daw.isPlaying ? "Pause" : "Play"}
                    onClick={daw.togglePlay}
                    active={daw.isPlaying}
                    accent="green"
                    primary
                />
                <TransportBtn icon={Square} label="Stop" onClick={daw.stop} />
                <TransportBtn
                    icon={Circle}
                    label="Record"
                    onClick={daw.record}
                    active={daw.isRecording}
                    accent="red"
                />
            </div>

            <div className="w-px h-6 bg-[var(--daw-border)]" />

            {/* Tempo */}
            <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-[var(--daw-text-dim)] uppercase tracking-widest">BPM</span>
                <input
                    type="number"
                    min={20}
                    max={999}
                    step={0.1}
                    value={daw.project.tempo}
                    onChange={e => daw.setTempo(parseFloat(e.target.value) || 120)}
                    className="daw-input w-16 h-7 text-sm text-amber-400"
                />
            </div>

            {/* Time signature */}
            <div className="flex items-center gap-1">
                <select
                    value={daw.project.timeSignature.numerator}
                    onChange={e => daw.setTimeSignature(Number(e.target.value), daw.project.timeSignature.denominator)}
                    className="daw-select h-7"
                >
                    {[2, 3, 4, 5, 6, 7, 8].map(n => (
                        <option key={n} value={n}>{n}</option>
                    ))}
                </select>
                <span className="text-[var(--daw-text-dim)] text-sm">/</span>
                <select
                    value={daw.project.timeSignature.denominator}
                    onChange={e => daw.setTimeSignature(daw.project.timeSignature.numerator, Number(e.target.value))}
                    className="daw-select h-7"
                >
                    {[2, 4, 8, 16].map(n => (
                        <option key={n} value={n}>{n}</option>
                    ))}
                </select>
            </div>

            <div className="w-px h-6 bg-[var(--daw-border)]" />

            {/* Metronome */}
            <button
                onClick={daw.toggleMetronome}
                className={cn(
                    "daw-btn h-7 px-2.5 gap-1.5 text-[11px]",
                    daw.metronomeOn ? "daw-btn-active" : "text-[var(--daw-text-dim)]"
                )}
            >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L8 22h8L12 2z" />
                    <path d="M12 10l4-4" />
                </svg>
                Metro
            </button>

            {/* Loop */}
            <button
                onClick={daw.toggleLoop}
                className={cn(
                    "daw-btn h-7 px-2.5 gap-1.5 text-[11px]",
                    daw.project.loopRegion.enabled
                        ? "!bg-[oklch(0.62_0.19_250/0.15)] !text-[var(--daw-blue)] shadow-[inset_0_0_0_1px_oklch(0.62_0.19_250/0.25)]"
                        : "text-[var(--daw-text-dim)]"
                )}
            >
                <Repeat className="h-3.5 w-3.5" />
                Loop
            </button>

            <div className="flex-1" />

            {/* Master level meters + volume */}
            <div className="flex items-center gap-2 bg-[var(--daw-surface)] rounded-lg px-3 py-1.5 border border-[var(--daw-border)]">
                <span className="text-[9px] text-[var(--daw-text-dim)] uppercase tracking-widest">Master</span>
                <div className="flex gap-0.5">
                    <MeterBar value={daw.masterPeakL} />
                    <MeterBar value={daw.masterPeakR} />
                </div>
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={daw.project.masterTrack.volume}
                    onChange={e => daw.setMasterVolume(Number(e.target.value))}
                    className="daw-slider daw-slider-accent w-16"
                />
                <span className="text-[10px] text-[var(--daw-text-dim)] w-8 text-right font-mono tabular-nums">
                    {(daw.project.masterTrack.volume * 100).toFixed(0)}%
                </span>
            </div>
        </div>
    );
}

function TransportBtn({ icon: Icon, label, onClick, active, accent, primary }: {
    icon: typeof Play;
    label: string;
    onClick: () => void;
    active?: boolean;
    accent?: "green" | "red";
    primary?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            title={label}
            className={cn(
                "daw-btn",
                primary ? "h-8 w-8" : "h-7 w-7",
                active && accent === "green" && "!bg-[oklch(0.72_0.17_142/0.15)] !text-[var(--daw-green)] shadow-[0_0_10px_oklch(0.72_0.17_142/0.2)]",
                active && accent === "red" && "!bg-[oklch(0.63_0.24_25/0.15)] !text-[var(--daw-red)] shadow-[0_0_10px_oklch(0.63_0.24_25/0.2)] animate-pulse",
                !active && "text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]",
            )}
        >
            <Icon className={cn(primary ? "h-4 w-4" : "h-3.5 w-3.5")} />
        </button>
    );
}

function MeterBar({ value }: { value: number }) {
    const db = value > 0 ? 20 * Math.log10(value) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const isClipping = db > -1;

    return (
        <div className="daw-meter w-1.5 h-7 relative">
            <div
                className={cn(
                    "daw-meter-fill absolute bottom-0 w-full",
                    isClipping ? "bg-[var(--daw-red)]" : pct > 75 ? "bg-[var(--daw-amber)]" : "bg-[var(--daw-green)]"
                )}
                style={{ height: `${pct}%` }}
            />
        </div>
    );
}
