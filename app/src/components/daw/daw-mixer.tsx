"use client";

import { useCallback } from "react";
import { useDAW } from "./daw-context";
import {
    Plus, Copy, VolumeX, Headphones, Snowflake, Palette, Trash2,
    RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DAWTrack } from "@/lib/daw-engine";
import { useContextMenu, colorMenuItems, type MenuEntry } from "./daw-context-menu";
import { InlineEditName, useScrollAdjust } from "./daw-ui-utils";

export function DAWMixer() {
    const daw = useDAW();

    return (
        <div className="h-full flex bg-[var(--daw-bg)] overflow-x-auto overflow-y-hidden">
            {/* Channel strips */}
            {daw.project.tracks.map((track, i) => (
                <ChannelStrip key={track.id} track={track} index={i} />
            ))}

            {/* Add track */}
            <div className="w-12 flex-shrink-0 border-l border-[var(--daw-border)] flex flex-col items-center justify-center gap-1.5">
                <button
                    onClick={() => daw.addTrack("audio")}
                    className="daw-btn w-8 h-8 rounded-lg text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)] border border-[var(--daw-border)]"
                    title="Add Audio Track"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
                <button
                    onClick={() => daw.addTrack("midi")}
                    className="daw-btn w-8 h-8 rounded-lg text-[var(--daw-accent)] opacity-40 hover:opacity-70 border border-[var(--daw-border)]"
                    title="Add MIDI Track"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>
            </div>

            <div className="w-px bg-[var(--daw-border-strong)] mx-0.5" />

            {/* Master */}
            <MasterStrip />
        </div>
    );
}

function ChannelStrip({ track, index }: { track: DAWTrack; index: number }) {
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const isSelected = daw.selectedTrackId === track.id;
    const peakL = track.peakL;
    const peakR = track.peakR;

    const faderRef = useScrollAdjust({
        value: track.volume,
        min: 0,
        max: 1.5,
        step: 0.02,
        fineStep: 0.005,
        onChange: v => daw.setTrackVolume(track.id, v),
    });

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        daw.selectTrack(track.id);

        const items: MenuEntry[] = [
            { type: "label", label: track.name },
            { type: "separator" },
            {
                label: "Duplicate Track",
                icon: <Copy className="h-3.5 w-3.5" />,
                onClick: () => daw.duplicateTrack(track.id),
            },
            {
                label: track.muted ? "Unmute" : "Mute",
                icon: <VolumeX className="h-3.5 w-3.5" />,
                checked: track.muted,
                onClick: () => daw.toggleTrackMute(track.id),
            },
            {
                label: track.soloed ? "Unsolo" : "Solo",
                icon: <Headphones className="h-3.5 w-3.5" />,
                checked: track.soloed,
                onClick: () => daw.toggleTrackSolo(track.id),
            },
            {
                label: "Freeze Track",
                icon: <Snowflake className="h-3.5 w-3.5" />,
                onClick: () => daw.freezeTrack(track.id),
            },
            {
                label: "Reset Volume",
                icon: <RotateCcw className="h-3.5 w-3.5" />,
                onClick: () => daw.setTrackVolume(track.id, 0.8),
            },
            {
                label: "Reset Pan",
                icon: <RotateCcw className="h-3.5 w-3.5" />,
                onClick: () => daw.setTrackPan(track.id, 0),
            },
            { type: "separator" },
            {
                type: "sub",
                label: "Set Color",
                icon: <Palette className="h-3.5 w-3.5" />,
                items: colorMenuItems(track.color, c => daw.setTrackColor(track.id, c)),
            },
            { type: "separator" },
            {
                label: "Delete Track",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                destructive: true,
                onClick: () => daw.removeTrack(track.id),
            },
        ];

        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, track, ctxMenu]);

    return (
        <div
            className={cn(
                "w-[76px] flex-shrink-0 flex flex-col border-r border-[var(--daw-border)] transition-all duration-150 cursor-pointer",
                isSelected
                    ? "bg-[var(--daw-surface-2)]"
                    : "bg-[var(--daw-surface)] hover:bg-[oklch(1_0_0/2%)]",
                `daw-animate-in`
            )}
            style={{ animationDelay: `${index * 20}ms` }}
            onClick={() => daw.selectTrack(track.id)}
            onContextMenu={handleContextMenu}
        >
            {/* Track name */}
            <div className="h-7 px-1.5 flex items-center gap-1.5 border-b border-[var(--daw-border)]">
                <div
                    className="w-2 h-2 rounded-full flex-shrink-0 ring-1 ring-white/5"
                    style={{ background: track.color }}
                />
                <InlineEditName
                    value={track.name}
                    onCommit={name => daw.renameTrack(track.id, name)}
                    className="text-[10px] text-[var(--daw-text-muted)] truncate font-medium"
                />
            </div>

            {/* Inserts indicator */}
            <div className="h-5 px-1.5 flex items-center gap-0.5 border-b border-[var(--daw-border)]">
                {track.inserts.length > 0 ? (
                    track.inserts.slice(0, 4).map((ins, i) => (
                        <div
                            key={i}
                            className={cn(
                                "w-2 h-2 rounded-full transition-colors",
                                ins.enabled ? "bg-[var(--daw-cyan)] opacity-60" : "bg-[var(--daw-text-dim)] opacity-20"
                            )}
                            title={ins.type}
                        />
                    ))
                ) : (
                    <span className="text-[8px] text-[var(--daw-text-dim)] opacity-40">no fx</span>
                )}
            </div>

            {/* Sends */}
            <div className="h-5 px-1.5 flex items-center gap-1 border-b border-[var(--daw-border)]">
                {track.sends.length > 0 ? (
                    track.sends.map((s, i) => (
                        <div key={i} className="text-[8px] text-[var(--daw-green)] opacity-50 font-mono tabular-nums">
                            {Math.round(s.amount * 100)}
                        </div>
                    ))
                ) : (
                    <span className="text-[8px] text-[var(--daw-text-dim)] opacity-40">sends</span>
                )}
            </div>

            {/* Pan knob */}
            <div className="h-8 flex items-center justify-center">
                <PanKnob value={track.pan} onChange={v => daw.setTrackPan(track.id, v)} />
            </div>

            {/* Fader + meters */}
            <div className="flex-1 flex items-stretch px-1.5 pb-1.5 gap-1">
                <div className="flex gap-px">
                    <MeterBar value={peakL} />
                    <MeterBar value={peakR} />
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <input
                        ref={faderRef}
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.005}
                        value={track.volume}
                        onChange={e => { e.stopPropagation(); daw.setTrackVolume(track.id, Number(e.target.value)); }}
                        onClick={e => e.stopPropagation()}
                        className="daw-fader h-full"
                    />
                </div>
                <div className="flex flex-col justify-end">
                    <span className="text-[7px] text-[var(--daw-text-dim)] font-mono leading-none tabular-nums">
                        {track.volume > 0 ? `${(20 * Math.log10(track.volume)).toFixed(1)}` : "-∞"}
                    </span>
                </div>
            </div>

            {/* Bottom M/S/Arm */}
            <div className="h-7 flex items-center justify-center gap-1 border-t border-[var(--daw-border)]">
                <MixerButton label="M" active={track.muted} color="red" onClick={e => { e.stopPropagation(); daw.toggleTrackMute(track.id); }} />
                <MixerButton label="S" active={track.soloed} color="amber" onClick={e => { e.stopPropagation(); daw.toggleTrackSolo(track.id); }} />
                {track.type === "audio" && (
                    <button
                        onClick={e => { e.stopPropagation(); daw.toggleTrackArm(track.id); }}
                        className={cn(
                            "h-5 w-5 rounded flex items-center justify-center transition-colors",
                            track.armed
                                ? "bg-[oklch(0.63_0.24_25/0.25)] text-[var(--daw-red)]"
                                : "bg-[var(--daw-surface)] text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
                        )}
                    >
                        <div className={cn("w-2 h-2 rounded-full", track.armed ? "bg-[var(--daw-red)]" : "bg-[var(--daw-text-dim)] opacity-30")} />
                    </button>
                )}
            </div>
        </div>
    );
}

function MasterStrip() {
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const mt = daw.project.masterTrack;

    const masterFaderRef = useScrollAdjust({
        value: mt.volume,
        min: 0,
        max: 1.5,
        step: 0.02,
        fineStep: 0.005,
        onChange: v => daw.setMasterVolume(v),
    });

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const items: MenuEntry[] = [
            { type: "label", label: "Master Channel" },
            { type: "separator" },
            {
                label: "Reset Volume to 0 dB",
                icon: <RotateCcw className="h-3.5 w-3.5" />,
                onClick: () => daw.setMasterVolume(1.0),
            },
        ];
        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, ctxMenu]);

    return (
        <div className="w-[84px] flex-shrink-0 flex flex-col bg-[var(--daw-surface)]" onContextMenu={handleContextMenu}>
            <div className="h-7 px-1.5 flex items-center gap-1.5 border-b border-[var(--daw-border-strong)]">
                <div className="w-2 h-2 rounded-full bg-[var(--daw-accent)]" />
                <span className="text-[10px] text-[var(--daw-text)] font-semibold tracking-wide">MASTER</span>
            </div>

            <div className="h-5 px-1.5 flex items-center border-b border-[var(--daw-border)]">
                <span className="text-[8px] text-[var(--daw-text-dim)] opacity-50 font-mono tabular-nums">{mt.inserts.length} fx</span>
            </div>

            <div className="h-5 border-b border-[var(--daw-border)]" />
            <div className="h-8" />

            <div className="flex-1 flex items-stretch px-1.5 pb-1.5 gap-1">
                <div className="flex gap-px">
                    <MeterBar value={daw.masterPeakL} master />
                    <MeterBar value={daw.masterPeakR} master />
                </div>
                <div className="flex-1 flex items-center justify-center">
                    <input
                        ref={masterFaderRef}
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.005}
                        value={mt.volume}
                        onChange={e => daw.setMasterVolume(Number(e.target.value))}
                        className="daw-fader h-full"
                    />
                </div>
                <div className="flex flex-col justify-end">
                    <span className="text-[7px] text-[var(--daw-text-dim)] font-mono leading-none tabular-nums">
                        {mt.volume > 0 ? `${(20 * Math.log10(mt.volume)).toFixed(1)}` : "-∞"}
                    </span>
                </div>
            </div>

            <div className="h-7 border-t border-[var(--daw-border-strong)]" />
        </div>
    );
}

function MixerButton({ label, active, color, onClick }: {
    label: string;
    active: boolean;
    color: "red" | "amber";
    onClick: (e: React.MouseEvent) => void;
}) {
    const colors = {
        red: { bg: "oklch(0.63 0.24 25 / 0.25)", text: "var(--daw-red)" },
        amber: { bg: "oklch(0.78 0.18 84 / 0.25)", text: "var(--daw-amber)" },
    };
    const c = colors[color];

    return (
        <button
            onClick={onClick}
            className={cn(
                "h-5 w-5 rounded text-[8px] font-bold flex items-center justify-center transition-all",
                active ? "" : "bg-[var(--daw-surface)] text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
            )}
            style={active ? { background: c.bg, color: c.text } : {}}
        >
            {label}
        </button>
    );
}

function PanKnob({ value, onChange }: { value: number; onChange: (v: number) => void }) {
    const display = value === 0 ? "C" : value < 0 ? `L${Math.abs(Math.round(value * 100))}` : `R${Math.round(value * 100)}`;

    const panRef = useScrollAdjust({
        value,
        min: -1,
        max: 1,
        step: 0.05,
        fineStep: 0.01,
        onChange,
    });

    return (
        <div className="flex flex-col items-center gap-1">
            <input
                ref={panRef}
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                onClick={e => e.stopPropagation()}
                onDoubleClick={() => onChange(0)}
                className="daw-slider w-12"
            />
            <span className="text-[7px] text-[var(--daw-text-dim)] font-mono tabular-nums">{display}</span>
        </div>
    );
}

function MeterBar({ value, master }: { value: number; master?: boolean }) {
    const db = value > 0 ? 20 * Math.log10(value) : -60;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    const isClipping = db > -1;

    return (
        <div className={cn("daw-meter relative", master ? "w-2" : "w-1.5", "h-full")}>
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
