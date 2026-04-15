"use client";

import { useCallback, useRef, useEffect, useState, memo, useMemo } from "react";
import { useMixer } from "./mixer-context";
import type { MidiEngine, ExternalDeviceProfile, MidiDevice } from "@/lib/midi-engine";
import { cn } from "@/lib/utils";
import {
    Play, Square, CircleDot, Minimize2, Maximize2, X,
    GripHorizontal, Volume2, Music2, Drum, Waves,
    Radio, Link2, Unlink2, ChevronDown, ChevronUp,
    Zap, Clock,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────

interface CircuitTracksPanelProps {
    profile: ExternalDeviceProfile;
    device: MidiDevice;
    midiEngine: MidiEngine;
    isMinimized: boolean;
    onMinimize: () => void;
    onClose: () => void;
    position: { x: number; y: number };
    onPositionChange: (pos: { x: number; y: number }) => void;
}

type SyncMode = "send" | "receive" | "none";
type ActiveTrack = "synth1" | "synth2" | "drums" | "midi1" | "midi2";

interface TrackState {
    macroValues: number[]; // 8 knobs, 0-127
    filterFreq: number; // 0-127
    filterRes: number; // 0-127
    muted: boolean;
    volume: number; // 0-127
}

// ─── Animated Knob ───────────────────────────────────────────────────────

const MiniKnob = memo(function MiniKnob({
    value, label, color, onChange, size = 28,
}: {
    value: number; label: string; color: string; onChange?: (v: number) => void; size?: number;
}) {
    const knobRef = useRef<SVGSVGElement>(null);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startVal = useRef(0);

    const angle = -135 + (value / 127) * 270;
    const pct = value / 127;

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        if (!onChange) return;
        dragging.current = true;
        startY.current = e.clientY;
        startVal.current = value;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [onChange, value]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragging.current || !onChange) return;
        const delta = (startY.current - e.clientY) * 0.8;
        const newVal = Math.round(Math.max(0, Math.min(127, startVal.current + delta)));
        onChange(newVal);
    }, [onChange]);

    const handlePointerUp = useCallback(() => {
        dragging.current = false;
    }, []);

    const r = size / 2 - 2;
    const cx = size / 2;
    const cy = size / 2;

    // Arc path for value indicator
    const startAngle = -135;
    const endAngle = angle;
    const arcR = r - 1.5;
    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;
    const x1 = cx + arcR * Math.cos(startRad);
    const y1 = cy + arcR * Math.sin(startRad);
    const x2 = cx + arcR * Math.cos(endRad);
    const y2 = cy + arcR * Math.sin(endRad);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;

    return (
        <div className="flex flex-col items-center gap-0.5 select-none">
            <svg
                ref={knobRef}
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                className={cn("cursor-pointer transition-transform", dragging.current && "scale-110")}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
            >
                {/* Background ring */}
                <circle cx={cx} cy={cy} r={r - 1.5} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2.5}
                    strokeDasharray={`${Math.PI * arcR * (270 / 180)}`}
                    strokeDashoffset={0}
                    transform={`rotate(-225, ${cx}, ${cy})`}
                    strokeLinecap="round"
                />
                {/* Value arc */}
                {pct > 0.01 && (
                    <path
                        d={`M ${x1} ${y1} A ${arcR} ${arcR} 0 ${largeArc} 1 ${x2} ${y2}`}
                        fill="none"
                        stroke={color}
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        style={{ filter: `drop-shadow(0 0 3px ${color}80)` }}
                    />
                )}
                {/* Pointer dot */}
                <circle
                    cx={cx + (r - 5) * Math.cos((angle * Math.PI) / 180)}
                    cy={cy + (r - 5) * Math.sin((angle * Math.PI) / 180)}
                    r={1.8}
                    fill="white"
                />
                {/* Center */}
                <circle cx={cx} cy={cy} r={3.5} fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
            </svg>
            <span className="text-[6px] text-white/30 truncate max-w-[32px] text-center">{label}</span>
        </div>
    );
});

// ─── Drum Pad ────────────────────────────────────────────────────────────

const DrumPad = memo(function DrumPad({
    note, color, isActive, onTrigger,
}: {
    note: number; color: string; isActive: boolean; onTrigger: (note: number) => void;
}) {
    return (
        <button
            onPointerDown={() => onTrigger(note)}
            className={cn(
                "w-7 h-7 rounded-sm border transition-all duration-75 cursor-pointer",
                "hover:brightness-125 active:scale-95",
                isActive && "ring-1 ring-white/30"
            )}
            style={{
                backgroundColor: isActive ? color : `${color}30`,
                borderColor: `${color}50`,
                boxShadow: isActive ? `0 0 8px ${color}60, inset 0 0 4px ${color}40` : "none",
            }}
        >
            <span className="text-[5px] text-white/40">{note}</span>
        </button>
    );
});

// ─── Sequencer Step Display ──────────────────────────────────────────────

const SequencerSteps = memo(function SequencerSteps({
    currentStep, totalSteps, color, isPlaying,
}: {
    currentStep: number; totalSteps: number; color: string; isPlaying: boolean;
}) {
    return (
        <div className="flex gap-[1px]">
            {Array.from({ length: totalSteps }).map((_, i) => (
                <div
                    key={i}
                    className={cn(
                        "h-1.5 rounded-[1px] transition-all duration-75",
                        i < 16 ? "w-1.5" : "w-1.5"
                    )}
                    style={{
                        backgroundColor: i === currentStep && isPlaying
                            ? color
                            : i === currentStep
                                ? `${color}80`
                                : `${color}15`,
                        boxShadow: i === currentStep && isPlaying ? `0 0 4px ${color}` : "none",
                    }}
                />
            ))}
        </div>
    );
});

// ─── Main Panel ──────────────────────────────────────────────────────────

export const CircuitTracksPanel = memo(function CircuitTracksPanel({
    profile, device, midiEngine, isMinimized, onMinimize, onClose,
    position, onPositionChange,
}: CircuitTracksPanelProps) {
    const mixer = useMixer();

    // Drag state
    const panelRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

    // Circuit Tracks state
    const [activeTrack, setActiveTrack] = useState<ActiveTrack>("synth1");
    const [isPlaying, setIsPlaying] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [currentStep, setCurrentStep] = useState(0);
    const [syncMode, setSyncMode] = useState<SyncMode>(profile.clock.defaultSyncMode);
    const [bpm, setBpm] = useState(120);
    const [masterFilter, setMasterFilter] = useState(64); // 0-127, center = no filter
    const [expanded, setExpanded] = useState(false);

    // Per-track state
    const [trackStates, setTrackStates] = useState<Record<string, TrackState>>(() => {
        const initial: Record<string, TrackState> = {};
        for (const t of profile.tracks) {
            initial[t.name] = {
                macroValues: new Array(8).fill(64),
                filterFreq: 127,
                filterRes: 0,
                muted: false,
                volume: 100,
            };
        }
        return initial;
    });

    // Active drum pads (notes currently sounding)
    const [activePads, setActivePads] = useState<Set<number>>(new Set());

    // Sync BPM from mixer
    useEffect(() => {
        if (syncMode === "receive" && mixer.deckA.isPlaying) {
            setBpm(Math.round(mixer.deckA.bpm));
        }
    }, [syncMode, mixer.deckA.bpm, mixer.deckA.isPlaying]);

    // Simulate sequencer step advancement
    useEffect(() => {
        if (!isPlaying) return;
        const stepMs = (60000 / bpm) / 4; // 16th note steps
        const interval = setInterval(() => {
            setCurrentStep(prev => (prev + 1) % 32);
        }, stepMs);
        return () => clearInterval(interval);
    }, [isPlaying, bpm]);

    // Listen for MIDI input from Circuit Tracks
    useEffect(() => {
        const handleMidiMessage = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail) return;
            const { channel, type, note, value } = detail;

            // Macro knobs on synth channels
            if (type === "cc" && (channel === 0 || channel === 1)) {
                const trackName = channel === 0 ? "Synth 1" : "Synth 2";
                const knobIdx = [80, 81, 82, 83, 84, 85, 86, 87].indexOf(note);
                if (knobIdx >= 0) {
                    setTrackStates(prev => ({
                        ...prev,
                        [trackName]: {
                            ...prev[trackName],
                            macroValues: prev[trackName].macroValues.map((v, i) => i === knobIdx ? value : v),
                        },
                    }));
                }
                // Filter freq
                if (note === 74) {
                    setTrackStates(prev => ({
                        ...prev,
                        [trackName]: { ...prev[trackName], filterFreq: value },
                    }));
                }
                // Filter res
                if (note === 71) {
                    setTrackStates(prev => ({
                        ...prev,
                        [trackName]: { ...prev[trackName], filterRes: value },
                    }));
                }
            }

            // Drum note triggers
            if (type === "noteOn" && channel === 9) {
                setActivePads(prev => new Set([...prev, note]));
                setTimeout(() => {
                    setActivePads(prev => {
                        const next = new Set(prev);
                        next.delete(note);
                        return next;
                    });
                }, 150);
            }
        };

        window.addEventListener("circuit-tracks-midi", handleMidiMessage);
        return () => window.removeEventListener("circuit-tracks-midi", handleMidiMessage);
    }, []);

    // Drag handlers
    const handleDragStart = useCallback((e: React.PointerEvent) => {
        dragState.current = {
            startX: e.clientX,
            startY: e.clientY,
            origX: position.x,
            origY: position.y,
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [position]);

    const handleDragMove = useCallback((e: React.PointerEvent) => {
        if (!dragState.current) return;
        const dx = e.clientX - dragState.current.startX;
        const dy = e.clientY - dragState.current.startY;
        onPositionChange({
            x: Math.max(0, dragState.current.origX + dx),
            y: Math.max(0, dragState.current.origY + dy),
        });
    }, [onPositionChange]);

    const handleDragEnd = useCallback(() => {
        dragState.current = null;
    }, []);

    // Transport actions — send MIDI to device
    const handlePlay = useCallback(() => {
        if (isPlaying) {
            midiEngine.sendStopToDevice(device.id);
            setIsPlaying(false);
            setCurrentStep(0);
        } else {
            midiEngine.sendStartToDevice(device.id);
            setIsPlaying(true);
        }
    }, [isPlaying, midiEngine, device.id]);

    const handleStop = useCallback(() => {
        midiEngine.sendStopToDevice(device.id);
        setIsPlaying(false);
        setCurrentStep(0);
    }, [midiEngine, device.id]);

    const handleRecord = useCallback(() => {
        setIsRecording(prev => !prev);
    }, []);

    // Send macro knob CC
    const handleMacroChange = useCallback((trackName: string, knobIdx: number, value: number) => {
        const track = profile.tracks.find(t => t.name === trackName);
        if (!track?.macroKnobs) return;
        const cc = track.macroKnobs[knobIdx].cc;
        midiEngine.sendCC(device.id, track.midiChannel, cc, value);
        setTrackStates(prev => ({
            ...prev,
            [trackName]: {
                ...prev[trackName],
                macroValues: prev[trackName].macroValues.map((v, i) => i === knobIdx ? value : v),
            },
        }));
    }, [profile.tracks, midiEngine, device.id]);

    // Send drum trigger
    const handleDrumTrigger = useCallback((note: number) => {
        midiEngine.sendNoteOn(device.id, 9, note, 100);
        setActivePads(prev => new Set([...prev, note]));
        setTimeout(() => {
            midiEngine.sendNoteOff(device.id, 9, note);
            setActivePads(prev => {
                const next = new Set(prev);
                next.delete(note);
                return next;
            });
        }, 150);
    }, [midiEngine, device.id]);

    // Master filter
    const handleMasterFilter = useCallback((value: number) => {
        setMasterFilter(value);
        // Send on project channel (Ch16 = channel 15)
        midiEngine.sendCC(device.id, 15, 74, value);
    }, [midiEngine, device.id]);

    // Sync mode toggle
    const cycleSyncMode = useCallback(() => {
        const modes: SyncMode[] = ["send", "receive", "none"];
        setSyncMode(prev => modes[(modes.indexOf(prev) + 1) % modes.length]);
    }, []);

    // Current track data
    const activeTrackName = useMemo(() => {
        switch (activeTrack) {
            case "synth1": return "Synth 1";
            case "synth2": return "Synth 2";
            case "drums": return "Drum 1";
            case "midi1": return "MIDI 1";
            case "midi2": return "MIDI 2";
        }
    }, [activeTrack]);

    const activeTrackProfile = useMemo(
        () => profile.tracks.find(t => t.name === activeTrackName),
        [profile.tracks, activeTrackName]
    );

    const activeTrackState = trackStates[activeTrackName];

    // MIDI clock sync effect
    useEffect(() => {
        if (syncMode !== "send" || !isPlaying) return;
        const pulsesPerBeat = 24; // MIDI standard
        const pulseMs = 60000 / (bpm * pulsesPerBeat);
        const interval = setInterval(() => {
            midiEngine.sendClockToDevice(device.id);
        }, pulseMs);
        return () => clearInterval(interval);
    }, [syncMode, isPlaying, bpm, midiEngine, device.id]);

    if (isMinimized) return null;

    const brandColor = profile.color;
    const trackColor = activeTrackProfile?.color || brandColor;

    return (
        <div
            ref={panelRef}
            className="fixed z-50 select-none"
            style={{
                left: position.x,
                top: position.y,
                width: expanded ? 420 : 340,
            }}
        >
            <div
                className="rounded-xl border overflow-hidden backdrop-blur-xl"
                style={{
                    backgroundColor: "rgba(10,10,10,0.92)",
                    borderColor: `${brandColor}30`,
                    boxShadow: `0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px ${brandColor}15, 0 0 60px ${brandColor}08`,
                }}
            >
                {/* ── Title Bar ─────────────────────────────────────── */}
                <div
                    className="flex items-center gap-2 px-3 py-1.5 cursor-grab active:cursor-grabbing"
                    style={{ background: `linear-gradient(to right, ${brandColor}18, transparent)` }}
                    onPointerDown={handleDragStart}
                    onPointerMove={handleDragMove}
                    onPointerUp={handleDragEnd}
                >
                    <GripHorizontal className="h-3 w-3 text-white/20" />
                    <div className="flex items-center gap-1.5 flex-1">
                        <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: brandColor, boxShadow: `0 0 6px ${brandColor}` }} />
                        <span className="text-[9px] font-bold tracking-wider uppercase" style={{ color: brandColor }}>
                            {profile.name}
                        </span>
                        <span className="text-[7px] text-white/20">{device.name}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <button onClick={() => setExpanded(!expanded)}
                            className="p-0.5 rounded hover:bg-white/10 text-white/25 hover:text-white/50 transition-colors cursor-pointer">
                            {expanded ? <Minimize2 className="h-2.5 w-2.5" /> : <Maximize2 className="h-2.5 w-2.5" />}
                        </button>
                        <button onClick={onMinimize}
                            className="p-0.5 rounded hover:bg-white/10 text-white/25 hover:text-white/50 transition-colors cursor-pointer">
                            <ChevronDown className="h-2.5 w-2.5" />
                        </button>
                        <button onClick={onClose}
                            className="p-0.5 rounded hover:bg-red-500/20 text-white/25 hover:text-red-400 transition-colors cursor-pointer">
                            <X className="h-2.5 w-2.5" />
                        </button>
                    </div>
                </div>

                {/* ── Transport + BPM ───────────────────────────────── */}
                <div className="px-3 py-2 border-t border-white/[0.06] flex items-center gap-2">
                    {/* Transport buttons */}
                    <div className="flex items-center gap-1">
                        <button onClick={handlePlay}
                            className={cn(
                                "w-7 h-7 rounded-md flex items-center justify-center transition-all cursor-pointer border",
                                isPlaying
                                    ? "bg-green-500/20 border-green-500/30 text-green-400 shadow-[0_0_8px_rgba(34,197,94,0.3)]"
                                    : "bg-white/5 border-white/10 text-white/40 hover:bg-white/10"
                            )}>
                            {isPlaying ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3 fill-current" />}
                        </button>
                        <button onClick={handleStop}
                            className="w-7 h-7 rounded-md flex items-center justify-center bg-white/5 border border-white/10 text-white/30 hover:bg-white/10 transition-all cursor-pointer">
                            <Square className="h-3 w-3" />
                        </button>
                        <button onClick={handleRecord}
                            className={cn(
                                "w-7 h-7 rounded-md flex items-center justify-center transition-all cursor-pointer border",
                                isRecording
                                    ? "bg-red-500/20 border-red-500/30 text-red-400 animate-pulse"
                                    : "bg-white/5 border-white/10 text-white/30 hover:bg-white/10"
                            )}>
                            <CircleDot className="h-3 w-3" />
                        </button>
                    </div>

                    {/* BPM display */}
                    <div className="flex-1 flex items-center justify-center gap-2">
                        <div className="text-center">
                            <div className="text-[14px] font-mono font-bold tabular-nums" style={{ color: brandColor }}>
                                {bpm}
                            </div>
                            <div className="text-[6px] text-white/20 uppercase tracking-wider">BPM</div>
                        </div>
                    </div>

                    {/* Sync mode */}
                    <button onClick={cycleSyncMode}
                        className={cn(
                            "flex items-center gap-1 px-2 py-1 rounded-md text-[8px] font-bold uppercase tracking-wider transition-all cursor-pointer border",
                            syncMode === "send" && "bg-orange-500/15 border-orange-500/30 text-orange-400",
                            syncMode === "receive" && "bg-blue-500/15 border-blue-500/30 text-blue-400",
                            syncMode === "none" && "bg-white/5 border-white/10 text-white/25",
                        )}>
                        {syncMode === "send" && <><Radio className="h-2.5 w-2.5" /> TX CLK</>}
                        {syncMode === "receive" && <><Link2 className="h-2.5 w-2.5" /> RX CLK</>}
                        {syncMode === "none" && <><Unlink2 className="h-2.5 w-2.5" /> INT</>}
                    </button>
                </div>

                {/* ── Sequencer Steps ───────────────────────────────── */}
                <div className="px-3 py-1.5 border-t border-white/[0.06]">
                    <SequencerSteps currentStep={currentStep} totalSteps={32} color={trackColor} isPlaying={isPlaying} />
                </div>

                {/* ── Track Selector ─────────────────────────────────── */}
                <div className="px-3 py-1.5 border-t border-white/[0.06] flex gap-1">
                    {([
                        { id: "synth1" as const, label: "S1", icon: Waves, color: "#9333ea" },
                        { id: "synth2" as const, label: "S2", icon: Waves, color: "#06b6d4" },
                        { id: "drums" as const, label: "DR", icon: Drum, color: "#f97316" },
                        { id: "midi1" as const, label: "M1", icon: Music2, color: "#3b82f6" },
                        { id: "midi2" as const, label: "M2", icon: Music2, color: "#ec4899" },
                    ]).map(t => {
                        const trackName = t.id === "synth1" ? "Synth 1" : t.id === "synth2" ? "Synth 2" : t.id === "drums" ? "Drum 1" : t.id === "midi1" ? "MIDI 1" : "MIDI 2";
                        const ts = trackStates[trackName];
                        return (
                            <button
                                key={t.id}
                                onClick={() => setActiveTrack(t.id)}
                                className={cn(
                                    "flex-1 flex flex-col items-center gap-0.5 py-1 rounded-md transition-all cursor-pointer border text-[7px] font-bold",
                                    activeTrack === t.id
                                        ? "border-opacity-40"
                                        : "bg-white/[0.02] border-white/[0.06] text-white/25 hover:bg-white/[0.05]",
                                    ts?.muted && "opacity-40"
                                )}
                                style={activeTrack === t.id ? {
                                    backgroundColor: `${t.color}15`,
                                    borderColor: `${t.color}40`,
                                    color: t.color,
                                } : undefined}
                            >
                                <t.icon className="h-3 w-3" />
                                {t.label}
                            </button>
                        );
                    })}
                </div>

                {/* ── Track Content ──────────────────────────────────── */}
                <div className="px-3 py-2 border-t border-white/[0.06] min-h-[80px]">
                    {/* Synth tracks: 8 macro knobs + filter */}
                    {(activeTrack === "synth1" || activeTrack === "synth2") && activeTrackProfile?.macroKnobs && (
                        <div className="space-y-2">
                            {/* Macro Knobs — 2 rows of 4 */}
                            <div className="grid grid-cols-4 gap-1 justify-items-center">
                                {activeTrackProfile.macroKnobs.slice(0, 4).map((knob, i) => (
                                    <MiniKnob
                                        key={i}
                                        value={activeTrackState.macroValues[i]}
                                        label={knob.label}
                                        color={trackColor}
                                        onChange={(v) => handleMacroChange(activeTrackName, i, v)}
                                    />
                                ))}
                            </div>
                            <div className="grid grid-cols-4 gap-1 justify-items-center">
                                {activeTrackProfile.macroKnobs.slice(4, 8).map((knob, i) => (
                                    <MiniKnob
                                        key={i + 4}
                                        value={activeTrackState.macroValues[i + 4]}
                                        label={knob.label}
                                        color={trackColor}
                                        onChange={(v) => handleMacroChange(activeTrackName, i + 4, v)}
                                    />
                                ))}
                            </div>

                            {/* Filter section */}
                            {expanded && (
                                <div className="flex items-center justify-center gap-3 pt-1 border-t border-white/[0.04]">
                                    <MiniKnob
                                        value={activeTrackState.filterFreq}
                                        label="Cutoff"
                                        color={trackColor}
                                        onChange={(v) => {
                                            midiEngine.sendCC(device.id, activeTrackProfile.midiChannel, 74, v);
                                            setTrackStates(prev => ({
                                                ...prev,
                                                [activeTrackName]: { ...prev[activeTrackName], filterFreq: v },
                                            }));
                                        }}
                                        size={32}
                                    />
                                    <MiniKnob
                                        value={activeTrackState.filterRes}
                                        label="Reso"
                                        color={trackColor}
                                        onChange={(v) => {
                                            midiEngine.sendCC(device.id, activeTrackProfile.midiChannel, 71, v);
                                            setTrackStates(prev => ({
                                                ...prev,
                                                [activeTrackName]: { ...prev[activeTrackName], filterRes: v },
                                            }));
                                        }}
                                        size={32}
                                    />
                                </div>
                            )}
                        </div>
                    )}

                    {/* Drum tracks: pad grid */}
                    {activeTrack === "drums" && (
                        <div className="space-y-2">
                            {/* 4x4 drum pad grid showing all 4 drum tracks */}
                            <div className="grid grid-cols-8 gap-1 justify-items-center">
                                {profile.tracks.filter(t => t.type === "drum").map(drumTrack => {
                                    const range = drumTrack.noteRange!;
                                    return Array.from({ length: range.high - range.low + 1 }).map((_, i) => {
                                        const note = range.low + i;
                                        return (
                                            <DrumPad
                                                key={note}
                                                note={note}
                                                color={drumTrack.color}
                                                isActive={activePads.has(note)}
                                                onTrigger={handleDrumTrigger}
                                            />
                                        );
                                    });
                                }).flat().slice(0, expanded ? 32 : 16)}
                            </div>
                        </div>
                    )}

                    {/* MIDI tracks: simple channel info */}
                    {(activeTrack === "midi1" || activeTrack === "midi2") && (
                        <div className="flex flex-col items-center justify-center py-3 gap-2">
                            <Radio className="h-6 w-6" style={{ color: trackColor, opacity: 0.4 }} />
                            <div className="text-[9px] text-white/30 text-center">
                                <div className="font-bold" style={{ color: trackColor }}>{activeTrackName}</div>
                                <div className="text-white/15">MIDI Channel {(activeTrackProfile?.midiChannel ?? 0) + 1}</div>
                                <div className="text-white/10 mt-1">Sends CC/Note data to external gear</div>
                            </div>
                        </div>
                    )}
                </div>

                {/* ── Master Filter ──────────────────────────────────── */}
                <div className="px-3 py-2 border-t border-white/[0.06] flex items-center gap-3">
                    <span className="text-[7px] text-white/20 uppercase tracking-wider shrink-0">Filter</span>
                    <div className="flex-1 relative h-2 bg-white/[0.06] rounded-full overflow-hidden">
                        <div
                            className="absolute inset-y-0 rounded-full transition-all duration-75"
                            style={{
                                left: masterFilter < 64 ? `${(masterFilter / 64) * 50}%` : "50%",
                                right: masterFilter > 64 ? `${(1 - masterFilter / 127) * 50}%` : "50%",
                                width: masterFilter === 64 ? "2px" : undefined,
                                backgroundColor: brandColor,
                                boxShadow: `0 0 6px ${brandColor}60`,
                            }}
                        />
                        <input
                            type="range" min={0} max={127} value={masterFilter}
                            onChange={(e) => handleMasterFilter(parseInt(e.target.value))}
                            className="absolute inset-0 w-full opacity-0 cursor-pointer"
                        />
                    </div>
                    <span className="text-[8px] tabular-nums text-white/25 w-6 text-right">
                        {masterFilter < 60 ? "LP" : masterFilter > 68 ? "HP" : "—"}
                    </span>
                </div>

                {/* ── Track Mute/Volume (expanded) ──────────────────── */}
                {expanded && (
                    <div className="px-3 py-2 border-t border-white/[0.06]">
                        <div className="text-[7px] text-white/15 uppercase tracking-wider mb-1.5">Track Mixer</div>
                        <div className="flex gap-1.5">
                            {profile.tracks.filter(t => t.type === "synth" || t.type === "drum").slice(0, 6).map(t => {
                                const ts = trackStates[t.name];
                                return (
                                    <div key={t.name} className="flex-1 flex flex-col items-center gap-1">
                                        {/* Volume mini-bar */}
                                        <div className="w-1.5 h-10 bg-white/[0.06] rounded-full overflow-hidden relative">
                                            <div
                                                className="absolute bottom-0 w-full rounded-full transition-all duration-100"
                                                style={{
                                                    height: `${(ts.volume / 127) * 100}%`,
                                                    backgroundColor: ts.muted ? "rgba(255,255,255,0.1)" : t.color,
                                                }}
                                            />
                                        </div>
                                        {/* Mute button */}
                                        <button
                                            onClick={() => setTrackStates(prev => ({
                                                ...prev,
                                                [t.name]: { ...prev[t.name], muted: !prev[t.name].muted },
                                            }))}
                                            className={cn(
                                                "text-[5px] font-bold px-1 py-0.5 rounded cursor-pointer transition-all",
                                                ts.muted ? "bg-red-500/20 text-red-400" : "bg-white/5 text-white/20"
                                            )}
                                        >
                                            {t.name.slice(0, 2)}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* ── Footer with features ──────────────────────────── */}
                {expanded && (
                    <div className="px-3 py-1.5 border-t border-white/[0.06] flex items-center justify-between">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            {profile.features.slice(0, 3).map(f => (
                                <span key={f} className="text-[6px] text-white/15 px-1 py-0.5 rounded bg-white/[0.03] border border-white/[0.04]">{f}</span>
                            ))}
                        </div>
                        <Zap className="h-2.5 w-2.5 text-white/10" />
                    </div>
                )}
            </div>
        </div>
    );
});

// ─── Minimized Badge (shown in bottom bar) ───────────────────────────────

export const CircuitTracksBadge = memo(function CircuitTracksBadge({
    profile, isPlaying, bpm, syncMode, onRestore,
}: {
    profile: ExternalDeviceProfile;
    isPlaying: boolean;
    bpm: number;
    syncMode: SyncMode;
    onRestore: () => void;
}) {
    return (
        <button
            onClick={onRestore}
            className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all cursor-pointer border",
                "hover:brightness-110",
            )}
            style={{
                backgroundColor: `${profile.color}12`,
                borderColor: `${profile.color}25`,
            }}
        >
            <div className="w-1.5 h-1.5 rounded-full"
                style={{
                    backgroundColor: isPlaying ? "#22c55e" : profile.color,
                    boxShadow: isPlaying ? "0 0 4px #22c55e" : `0 0 3px ${profile.color}60`,
                    animation: isPlaying ? "pulse 1s infinite" : undefined,
                }}
            />
            <span className="text-[8px] font-bold uppercase tracking-wider" style={{ color: profile.color }}>
                {profile.name}
            </span>
            <span className="text-[8px] tabular-nums text-white/30">{bpm}</span>
            {syncMode !== "none" && (
                <span className={cn(
                    "text-[6px] px-1 rounded font-bold",
                    syncMode === "send" ? "bg-orange-500/15 text-orange-400" : "bg-blue-500/15 text-blue-400",
                )}>
                    {syncMode === "send" ? "TX" : "RX"}
                </span>
            )}
            <ChevronUp className="h-2.5 w-2.5 text-white/20" />
        </button>
    );
});
