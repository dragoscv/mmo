"use client";

import { useCallback, useRef, useEffect, useState, memo, useMemo } from "react";
import { useMixer } from "./mixer-context";
import type { MidiEngine, ExternalDeviceProfile, MidiDevice } from "@/lib/midi-engine";
import { cn } from "@/lib/utils";
import {
    Play, Square, CircleDot, Minimize2, Maximize2, X,
    GripHorizontal, Music2, Drum, Waves,
    Radio, Link2, Unlink2, ChevronDown, ChevronUp,
    Zap, Sliders, Sparkles, Layers,
    Hash, LinkIcon,
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
    size: { w: number; h: number };
    onSizeChange: (size: { w: number; h: number }) => void;
}

type SyncMode = "send" | "receive" | "none";
type ActiveTrack = "synth1" | "synth2" | "drums1" | "drums2" | "drums3" | "drums4" | "midi1" | "midi2";
type PanelView = "tracks" | "mixer" | "fx" | "sidechain" | "patterns";

// ─── Constants ───────────────────────────────────────────────────────────

const REVERB_PRESETS = [
    "Small Chamber", "Small Room 1", "Small Room 2", "Large Room",
    "Hall", "Large Hall", "Hall Long", "Large Hall Long",
];

const DELAY_PRESETS = [
    "Slapback Fast", "Slapback Slow", "32nd Triplets", "32nd",
    "16th Triplets", "16th", "16th PingPong", "16th PP Swung",
    "8th Triplets", "8th Dot PP", "8th", "8th PingPong",
    "8th PP Swung", "4th Triplets", "4th Dot PP Swung", "4th Trip PP Wide",
];

const SIDECHAIN_PRESETS = ["OFF", "SC 1", "SC 2", "SC 3", "SC 4", "SC 5", "SC 6", "SC 7"];

const TRACK_NAMES_ALL = ["Synth 1", "Synth 2", "MIDI 1", "MIDI 2", "Drum 1", "Drum 2", "Drum 3", "Drum 4"];
const TRACK_COLORS_ALL = ["#9333ea", "#06b6d4", "#3b82f6", "#ec4899", "#f97316", "#eab308", "#22c55e", "#ef4444"];

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
    position, onPositionChange, size, onSizeChange,
}: CircuitTracksPanelProps) {
    const mixer = useMixer();

    // Drag state
    const panelRef = useRef<HTMLDivElement>(null);
    const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

    // Resize state
    const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

    // Circuit Tracks state
    const [activeTrack, setActiveTrack] = useState<ActiveTrack>("synth1");
    const [isPlaying, setIsPlaying] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [currentStep, setCurrentStep] = useState(0);
    const [syncMode, setSyncMode] = useState<SyncMode>(profile.clock.defaultSyncMode);
    const [bpm, setBpm] = useState(120);
    const [swing, setSwing] = useState(50); // 20-80, default 50
    const [editingBpm, setEditingBpm] = useState(false);
    const [bpmInput, setBpmInput] = useState("");
    const [masterFilter, setMasterFilter] = useState(64); // 0-127, center = no filter
    const [expanded, setExpanded] = useState(false);
    const [deckSync, setDeckSync] = useState(false); // Forward deck BPM to CT via clock in RX mode
    const [panelView, setPanelView] = useState<PanelView>("tracks");

    // Mixer state — per-track volume (0-127) and pan (0-127, 64=center)
    const [mixerVolumes, setMixerVolumes] = useState<number[]>(() => new Array(8).fill(100));
    const [mixerPans, setMixerPans] = useState<number[]>(() => new Array(8).fill(64));
    const [mixerShowPan, setMixerShowPan] = useState(false);

    // FX state
    const [reverbPreset, setReverbPreset] = useState(0); // 0=off, 1-8
    const [delayPreset, setDelayPreset] = useState(0); // 0=off, 1-16
    const [reverbSends, setReverbSends] = useState<number[]>(() => new Array(8).fill(0));
    const [delaySends, setDelaySends] = useState<number[]>(() => new Array(8).fill(0));
    const [fxTab, setFxTab] = useState<"reverb" | "delay">("reverb");

    // Sidechain state — per synth/midi track: preset (0=off, 1-7), key drum (0-3)
    const [sidechainPresets, setSidechainPresets] = useState<number[]>(() => new Array(4).fill(0)); // S1,S2,M1,M2
    const [sidechainKeys, setSidechainKeys] = useState<number[]>(() => new Array(4).fill(0)); // which drum triggers

    // Project & Patch state
    const [currentProject, setCurrentProject] = useState(0); // 0-based, 0-63 projects. PC on Ch16 switches project
    const [synth1Patch, setSynth1Patch] = useState(0); // 0-127 patches, PC on Ch1
    const [synth2Patch, setSynth2Patch] = useState(0); // 0-127 patches, PC on Ch2
    const [patchPage, setPatchPage] = useState(0); // 0-3 for 4 pages of 32 patches

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

    // Active pads (notes currently sounding) — keyed as "channel:note" to distinguish channels
    const [activePads, setActivePads] = useState<Set<string>>(new Set());

    // Sync BPM from mixer
    useEffect(() => {
        if (syncMode === "receive" && mixer.deckA.isPlaying) {
            setBpm(Math.round(mixer.deckA.bpm));
        }
    }, [syncMode, mixer.deckA.bpm, mixer.deckA.isPlaying]);

    // Simulate sequencer step advancement with swing (only when NOT receiving external clock)
    useEffect(() => {
        if (!isPlaying || syncMode === "receive") return; // RX mode uses incoming clock ticks
        const baseStepMs = (60000 / bpm) / 4; // 16th note steps
        let step = currentStep;
        let timeoutId: ReturnType<typeof setTimeout>;

        const scheduleNext = () => {
            // Swing affects even-numbered steps (off-beats)
            const nextStep = (step + 1) % 32;
            const isEvenStep = nextStep % 2 === 1; // 0-indexed, so odd index = even musical step
            const swingFactor = isEvenStep ? (swing / 50) : (2 - swing / 50);
            const nextMs = baseStepMs * swingFactor;

            timeoutId = setTimeout(() => {
                step = nextStep;
                setCurrentStep(step);
                scheduleNext();
            }, Math.max(10, nextMs));
        };

        scheduleNext();
        return () => clearTimeout(timeoutId);
    }, [isPlaying, bpm, swing, syncMode]);

    // Listen for MIDI input from Circuit Tracks
    const clockTickRef = useRef(0); // count incoming clock ticks for step advance (24 PPQN)
    const isPlayingRef = useRef(false);
    useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

    useEffect(() => {
        const handleMidiMessage = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail) return;
            const { channel, type, note, value } = detail;

            // ── Transport: Start / Stop / Continue ──
            if (type === "start") {
                setIsPlaying(true);
                setCurrentStep(0);
                clockTickRef.current = 0;
            }
            if (type === "stop") {
                setIsPlaying(false);
                setIsRecording(false);
                setCurrentStep(0);
            }
            if (type === "continue") {
                setIsPlaying(true);
            }

            // ── Clock: advance sequencer step (only in RX mode AND already playing) ──
            if (type === "clock" && syncMode === "receive" && isPlayingRef.current) {
                clockTickRef.current += 1;
                if (clockTickRef.current >= 6) { // 24 PPQN / 4 = 6 ticks per 16th note step
                    clockTickRef.current = 0;
                    setCurrentStep(prev => (prev + 1) % 32);
                }
            }

            // ── Program Change: project / synth patches ──
            if (type === "programChange") {
                // Ch16 (ch15) = project change
                if (channel === 15) setCurrentProject(note);
                // Ch1 (ch0) = synth 1 patch
                if (channel === 0) setSynth1Patch(note);
                // Ch2 (ch1) = synth 2 patch
                if (channel === 1) setSynth2Patch(note);
            }

            // ── CC on synth channels: macros, filter ──
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
                if (note === 74) {
                    setTrackStates(prev => ({
                        ...prev,
                        [trackName]: { ...prev[trackName], filterFreq: value },
                    }));
                }
                if (note === 71) {
                    setTrackStates(prev => ({
                        ...prev,
                        [trackName]: { ...prev[trackName], filterRes: value },
                    }));
                }
            }

            // ── CC on project channel (ch16=15): master filter ──
            if (type === "cc" && channel === 15 && note === 74) {
                setMasterFilter(value);
            }

            // ── CC on any track: mixer volume (CC12) / pan (CC10) ──
            if (type === "cc" && (note === 12 || note === 10)) {
                const trackIdx = profile.tracks.findIndex(t => t.midiChannel === channel);
                if (trackIdx >= 0) {
                    if (note === 12) setMixerVolumes(prev => prev.map((v, i) => i === trackIdx ? value : v));
                    if (note === 10) setMixerPans(prev => prev.map((v, i) => i === trackIdx ? value : v));
                }
            }

            // ── CC on any track: reverb send (CC91) / delay send (CC93) ──
            if (type === "cc" && (note === 91 || note === 93)) {
                const trackIdx = profile.tracks.findIndex(t => t.midiChannel === channel);
                if (trackIdx >= 0) {
                    if (note === 91) setReverbSends(prev => prev.map((v, i) => i === trackIdx ? value : v));
                    if (note === 93) setDelaySends(prev => prev.map((v, i) => i === trackIdx ? value : v));
                }
            }

            // ── Note triggers (all channels — drums Ch10, synths Ch1/Ch2, MIDI Ch3/Ch4) ──
            if (type === "noteOn") {
                const padKey = `${channel}:${note}`;
                setActivePads(prev => new Set([...prev, padKey]));
                setTimeout(() => {
                    setActivePads(prev => {
                        const next = new Set(prev);
                        next.delete(padKey);
                        return next;
                    });
                }, 200);
            }
            if (type === "noteOff") {
                const padKey = `${channel}:${note}`;
                setActivePads(prev => {
                    const next = new Set(prev);
                    next.delete(padKey);
                    return next;
                });
            }
        };

        window.addEventListener("circuit-tracks-midi", handleMidiMessage);
        return () => window.removeEventListener("circuit-tracks-midi", handleMidiMessage);
    }, [profile.tracks, syncMode]);

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

    // Resize handlers
    const handleResizeStart = useCallback((e: React.PointerEvent) => {
        e.stopPropagation();
        resizeState.current = {
            startX: e.clientX,
            startY: e.clientY,
            origW: size.w,
            origH: size.h || (panelRef.current?.offsetHeight ?? 400),
        };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [size]);

    const handleResizeMove = useCallback((e: React.PointerEvent) => {
        if (!resizeState.current) return;
        const dx = e.clientX - resizeState.current.startX;
        const dy = e.clientY - resizeState.current.startY;
        onSizeChange({
            w: Math.max(320, Math.min(700, resizeState.current.origW + dx)),
            h: Math.max(200, Math.min(900, resizeState.current.origH + dy)),
        });
    }, [onSizeChange]);

    const handleResizeEnd = useCallback(() => {
        resizeState.current = null;
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
        const padKey = `9:${note}`;
        midiEngine.sendNoteOn(device.id, 9, note, 100);
        setActivePads(prev => new Set([...prev, padKey]));
        setTimeout(() => {
            midiEngine.sendNoteOff(device.id, 9, note);
            setActivePads(prev => {
                const next = new Set(prev);
                next.delete(padKey);
                return next;
            });
        }, 150);
    }, [midiEngine, device.id]);

    // Send synth note trigger
    const handleSynthNoteTrigger = useCallback((channel: number, note: number) => {
        const padKey = `${channel}:${note}`;
        midiEngine.sendNoteOn(device.id, channel, note, 100);
        setActivePads(prev => new Set([...prev, padKey]));
        setTimeout(() => {
            midiEngine.sendNoteOff(device.id, channel, note);
            setActivePads(prev => {
                const next = new Set(prev);
                next.delete(padKey);
                return next;
            });
        }, 200);
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

    // BPM adjustment
    const adjustBpm = useCallback((delta: number) => {
        setBpm(prev => Math.max(40, Math.min(240, prev + delta)));
    }, []);

    const commitBpmEdit = useCallback(() => {
        const val = parseInt(bpmInput, 10);
        if (!isNaN(val) && val >= 40 && val <= 240) {
            setBpm(val);
        }
        setEditingBpm(false);
    }, [bpmInput]);

    // Swing adjustment
    const adjustSwing = useCallback((delta: number) => {
        setSwing(prev => Math.max(20, Math.min(80, prev + delta)));
    }, []);

    // ── Mixer handlers ─────────────────────────────────

    const handleMixerVolume = useCallback((trackIdx: number, value: number) => {
        setMixerVolumes(prev => prev.map((v, i) => i === trackIdx ? value : v));
        // CT mixer volume: CC 12 on each track's channel
        const track = profile.tracks[trackIdx];
        if (track) {
            midiEngine.sendCC(device.id, track.midiChannel, 12, value);
        }
    }, [midiEngine, device.id, profile.tracks]);

    const handleMixerPan = useCallback((trackIdx: number, value: number) => {
        setMixerPans(prev => prev.map((v, i) => i === trackIdx ? value : v));
        const track = profile.tracks[trackIdx];
        if (track) {
            midiEngine.sendCC(device.id, track.midiChannel, 10, value);
        }
    }, [midiEngine, device.id, profile.tracks]);

    // ── FX handlers ────────────────────────────────────

    const handleReverbPresetChange = useCallback((preset: number) => {
        setReverbPreset(preset);
        // Reverb preset: CC 58 on project channel (ch16 = 15)
        midiEngine.sendCC(device.id, 15, 58, preset * 16);
    }, [midiEngine, device.id]);

    const handleDelayPresetChange = useCallback((preset: number) => {
        setDelayPreset(preset);
        // Delay preset: CC 59 on project channel
        midiEngine.sendCC(device.id, 15, 59, preset * 8);
    }, [midiEngine, device.id]);

    const handleReverbSend = useCallback((trackIdx: number, value: number) => {
        setReverbSends(prev => prev.map((v, i) => i === trackIdx ? value : v));
        const track = profile.tracks[trackIdx];
        if (track) {
            // Reverb send: CC 91 per track channel
            midiEngine.sendCC(device.id, track.midiChannel, 91, value);
        }
    }, [midiEngine, device.id, profile.tracks]);

    const handleDelaySend = useCallback((trackIdx: number, value: number) => {
        setDelaySends(prev => prev.map((v, i) => i === trackIdx ? value : v));
        const track = profile.tracks[trackIdx];
        if (track) {
            // Delay send: CC 93 per track channel
            midiEngine.sendCC(device.id, track.midiChannel, 93, value);
        }
    }, [midiEngine, device.id, profile.tracks]);

    // ── Sidechain handlers ─────────────────────────────

    const handleSidechainPreset = useCallback((trackIdx: number, preset: number) => {
        setSidechainPresets(prev => prev.map((v, i) => i === trackIdx ? preset : v));
    }, []);

    const handleSidechainKey = useCallback((trackIdx: number, drumIdx: number) => {
        setSidechainKeys(prev => prev.map((v, i) => i === trackIdx ? drumIdx : v));
    }, []);

    // ── Project & Patch handlers ───────────────────────

    const handleProjectChange = useCallback((project: number) => {
        setCurrentProject(project);
        // Program Change on Ch16 (channel 15) switches the entire project/session
        midiEngine.sendProgramChange(device.id, 15, project);
    }, [midiEngine, device.id]);

    const handleSynth1PatchChange = useCallback((patch: number) => {
        setSynth1Patch(patch);
        // Program Change on Ch1 (channel 0) selects synth 1 patch
        midiEngine.sendProgramChange(device.id, 0, patch);
    }, [midiEngine, device.id]);

    const handleSynth2PatchChange = useCallback((patch: number) => {
        setSynth2Patch(patch);
        // Program Change on Ch2 (channel 1) selects synth 2 patch
        midiEngine.sendProgramChange(device.id, 1, patch);
    }, [midiEngine, device.id]);

    // Current track data
    const activeTrackName = useMemo(() => {
        switch (activeTrack) {
            case "synth1": return "Synth 1";
            case "synth2": return "Synth 2";
            case "drums1": return "Drum 1";
            case "drums2": return "Drum 2";
            case "drums3": return "Drum 3";
            case "drums4": return "Drum 4";
            case "midi1": return "MIDI 1";
            case "midi2": return "MIDI 2";
        }
    }, [activeTrack]);

    const activeTrackProfile = useMemo(
        () => profile.tracks.find(t => t.name === activeTrackName),
        [profile.tracks, activeTrackName]
    );

    const activeTrackState = trackStates[activeTrackName];

    // MIDI clock sync effect — send clock to Circuit Tracks
    // Active in TX mode (always) or RX mode when deckSync is on
    // Circuit Tracks derives BPM from clock timing (24 PPQN)
    // Swing is applied by varying pulse intervals within 8th-note pairs
    const shouldSendClock = syncMode === "send" || (syncMode === "receive" && deckSync);

    useEffect(() => {
        if (!shouldSendClock) return;

        const quarterNoteMs = 60000 / bpm;
        const eighthNoteMs = quarterNoteMs / 2;

        // Swing ratio for the two 16th-note halves of each 8th note
        const firstPulseInterval = ((swing / 100) * eighthNoteMs) / 6;
        const secondPulseInterval = (((100 - swing) / 100) * eighthNoteMs) / 6;

        let tickInCycle = 0; // 0-11 within each 8th-note pair
        let timeoutId: ReturnType<typeof setTimeout>;

        const sendTick = () => {
            midiEngine.sendClockToDevice(device.id);
            // Ticks 0-5 = first 16th, ticks 6-11 = second 16th
            const interval = tickInCycle < 6 ? firstPulseInterval : secondPulseInterval;
            tickInCycle = (tickInCycle + 1) % 12;
            timeoutId = setTimeout(sendTick, Math.max(1, interval));
        };

        sendTick();
        return () => clearTimeout(timeoutId);
    }, [shouldSendClock, bpm, swing, midiEngine, device.id]);

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
                width: size.w,
                ...(size.h > 0 ? { height: size.h, overflow: "auto" } : {}),
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
                            title="Record (local only — MIDI has no record message)"
                            className={cn(
                                "w-7 h-7 rounded-md flex items-center justify-center transition-all cursor-pointer border",
                                isRecording
                                    ? "bg-red-500/20 border-red-500/30 text-red-400 animate-pulse"
                                    : "bg-white/5 border-white/10 text-white/30 hover:bg-white/10"
                            )}>
                            <CircleDot className="h-3 w-3" />
                        </button>
                    </div>

                    {/* BPM display + controls */}
                    <div className="flex-1 flex items-center justify-center gap-1.5">
                        <button
                            onClick={() => adjustBpm(-1)}
                            onContextMenu={(e) => { e.preventDefault(); adjustBpm(-10); }}
                            className="w-5 h-5 rounded flex items-center justify-center bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/50 transition-all cursor-pointer text-[10px] font-bold"
                            title="Click: -1 BPM, Right-click: -10 BPM"
                        >
                            −
                        </button>
                        <div className="text-center">
                            {editingBpm ? (
                                <input
                                    type="number"
                                    min={40}
                                    max={240}
                                    value={bpmInput}
                                    onChange={(e) => setBpmInput(e.target.value)}
                                    onBlur={commitBpmEdit}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") commitBpmEdit();
                                        if (e.key === "Escape") setEditingBpm(false);
                                    }}
                                    autoFocus
                                    className="w-10 text-center text-[14px] font-mono font-bold tabular-nums bg-transparent border-b outline-none"
                                    style={{ color: brandColor, borderColor: `${brandColor}60` }}
                                />
                            ) : (
                                <div
                                    className="text-[14px] font-mono font-bold tabular-nums cursor-pointer hover:opacity-80 transition-opacity"
                                    style={{ color: brandColor }}
                                    onClick={() => {
                                        if (syncMode !== "receive") {
                                            setEditingBpm(true);
                                            setBpmInput(String(bpm));
                                        }
                                    }}
                                    title={syncMode === "receive" ? "BPM synced from deck" : "Click to edit BPM"}
                                >
                                    {bpm}
                                </div>
                            )}
                            <div className="text-[6px] text-white/20 uppercase tracking-wider">BPM</div>
                        </div>
                        <button
                            onClick={() => adjustBpm(1)}
                            onContextMenu={(e) => { e.preventDefault(); adjustBpm(10); }}
                            className="w-5 h-5 rounded flex items-center justify-center bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/50 transition-all cursor-pointer text-[10px] font-bold"
                            title="Click: +1 BPM, Right-click: +10 BPM"
                        >
                            +
                        </button>
                        {/* Swing display — applied via swung MIDI clock in TX mode */}
                        <div className="ml-2 pl-2 border-l border-white/[0.08] text-center" title={syncMode === "send" ? "Swing sent via MIDI clock" : "Swing (local only — set to TX CLK to send)"}>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => adjustSwing(-1)}
                                    onContextMenu={(e) => { e.preventDefault(); adjustSwing(-5); }}
                                    className="w-4 h-4 rounded flex items-center justify-center bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/50 transition-all cursor-pointer text-[8px] font-bold"
                                >
                                    −
                                </button>
                                <div className="text-[11px] font-mono font-bold tabular-nums min-w-[18px]" style={{ color: swing !== 50 ? "#f59e0b" : "rgba(255,255,255,0.35)" }}>
                                    {swing}
                                </div>
                                <button
                                    onClick={() => adjustSwing(1)}
                                    onContextMenu={(e) => { e.preventDefault(); adjustSwing(5); }}
                                    className="w-4 h-4 rounded flex items-center justify-center bg-white/5 hover:bg-white/10 text-white/30 hover:text-white/50 transition-all cursor-pointer text-[8px] font-bold"
                                >
                                    +
                                </button>
                            </div>
                            <div className="text-[6px] uppercase tracking-wider" style={{ color: syncMode === "send" && swing !== 50 ? "#f59e0b80" : "rgba(255,255,255,0.2)" }}>
                                Swing{syncMode === "send" && swing !== 50 ? " ⚡" : ""}
                            </div>
                        </div>
                    </div>

                    {/* Sync mode + deck sync button */}
                    <div className="flex items-center gap-1">
                        {syncMode === "receive" && (
                            <button
                                onClick={() => setDeckSync(prev => !prev)}
                                className={cn(
                                    "flex items-center gap-1 px-1.5 py-1 rounded-md text-[8px] font-bold uppercase tracking-wider transition-all cursor-pointer border",
                                    deckSync
                                        ? "bg-green-500/15 border-green-500/30 text-green-400 shadow-[0_0_6px_rgba(34,197,94,0.2)]"
                                        : "bg-white/5 border-white/10 text-white/25 hover:bg-white/10"
                                )}
                                title={deckSync ? "Syncing deck BPM → Circuit Tracks (click to stop)" : "Send deck BPM to Circuit Tracks as MIDI clock"}
                            >
                                <Zap className="h-2.5 w-2.5" />
                                Sync
                            </button>
                        )}
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
                </div>

                {/* ── View Tabs ─────────────────────────────────────── */}
                <div className="px-2 py-1 border-t border-white/[0.06] flex gap-0.5">
                    {([
                        { id: "tracks" as PanelView, label: "Tracks", icon: Layers },
                        { id: "mixer" as PanelView, label: "Mixer", icon: Sliders },
                        { id: "fx" as PanelView, label: "FX", icon: Sparkles },
                        { id: "sidechain" as PanelView, label: "SC", icon: LinkIcon },
                        { id: "patterns" as PanelView, label: "Proj", icon: Hash },
                    ]).map(v => (
                        <button
                            key={v.id}
                            onClick={() => setPanelView(v.id)}
                            className={cn(
                                "flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[7px] font-bold uppercase tracking-wider transition-all cursor-pointer border",
                                panelView === v.id
                                    ? "border-opacity-40"
                                    : "bg-white/[0.02] border-transparent text-white/20 hover:bg-white/[0.05] hover:text-white/30"
                            )}
                            style={panelView === v.id ? {
                                backgroundColor: `${brandColor}15`,
                                borderColor: `${brandColor}35`,
                                color: brandColor,
                            } : undefined}
                        >
                            <v.icon className="h-2.5 w-2.5" />
                            {v.label}
                        </button>
                    ))}
                </div>

                {/* ══════════════════════════════════════════════════════
                    VIEW: TRACKS — Sequencer, track selector, macros/pads
                   ══════════════════════════════════════════════════════ */}
                {panelView === "tracks" && (
                    <>
                        {/* Sequencer Steps */}
                        <div className="px-3 py-1.5 border-t border-white/[0.06]">
                            <SequencerSteps currentStep={currentStep} totalSteps={32} color={trackColor} isPlaying={isPlaying} />
                        </div>

                        {/* Track Selector */}
                        <div className="px-3 py-1.5 border-t border-white/[0.06] flex gap-1">
                            {([
                                { id: "synth1" as const, label: "S1", icon: Waves, color: "#9333ea" },
                                { id: "synth2" as const, label: "S2", icon: Waves, color: "#06b6d4" },
                                { id: "midi1" as const, label: "M1", icon: Music2, color: "#3b82f6" },
                                { id: "midi2" as const, label: "M2", icon: Music2, color: "#ec4899" },
                                { id: "drums1" as const, label: "D1", icon: Drum, color: "#f97316" },
                                { id: "drums2" as const, label: "D2", icon: Drum, color: "#eab308" },
                                { id: "drums3" as const, label: "D3", icon: Drum, color: "#22c55e" },
                                { id: "drums4" as const, label: "D4", icon: Drum, color: "#ef4444" },
                            ]).map(t => {
                                const trackName = t.id === "synth1" ? "Synth 1" : t.id === "synth2" ? "Synth 2" : t.id === "drums1" ? "Drum 1" : t.id === "drums2" ? "Drum 2" : t.id === "drums3" ? "Drum 3" : t.id === "drums4" ? "Drum 4" : t.id === "midi1" ? "MIDI 1" : "MIDI 2";
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

                        {/* Track Content */}
                        <div className="px-3 py-2 border-t border-white/[0.06] min-h-[80px]">
                            {/* Synth tracks: 8 macro knobs + filter + note pads */}
                            {(activeTrack === "synth1" || activeTrack === "synth2") && activeTrackProfile?.macroKnobs && (
                                <div className="space-y-2">
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

                                    {/* Synth Note Pads — 2×8 chromatic grid (C3-D#4 = notes 48-63) */}
                                    <div className="pt-1 border-t border-white/[0.04]">
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-[6px] text-white/20 uppercase tracking-wider">Note Pads</span>
                                            <span className="text-[6px] text-white/10">Ch {activeTrackProfile.midiChannel + 1}</span>
                                        </div>
                                        {[0, 8].map(rowStart => (
                                            <div key={rowStart} className="grid grid-cols-8 gap-1 mb-1">
                                                {Array.from({ length: 8 }).map((_, i) => {
                                                    const noteNum = 48 + rowStart + i; // C3=48 .. D#4=63
                                                    const padKey = `${activeTrackProfile.midiChannel}:${noteNum}`;
                                                    const isActive = activePads.has(padKey);
                                                    const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
                                                    const noteName = noteNames[noteNum % 12];
                                                    const octave = Math.floor(noteNum / 12) - 1;
                                                    return (
                                                        <button
                                                            key={noteNum}
                                                            onPointerDown={() => handleSynthNoteTrigger(activeTrackProfile.midiChannel, noteNum)}
                                                            className={cn(
                                                                "h-6 rounded-sm border transition-all duration-75 cursor-pointer",
                                                                "hover:brightness-125 active:scale-95",
                                                                isActive && "ring-1 ring-white/30"
                                                            )}
                                                            style={{
                                                                backgroundColor: isActive ? trackColor : `${trackColor}20`,
                                                                borderColor: `${trackColor}40`,
                                                                boxShadow: isActive ? `0 0 8px ${trackColor}60` : "none",
                                                            }}
                                                        >
                                                            <span className="text-[5px] text-white/40">{noteName}{octave}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Drum tracks: all 4 drums in one view */}
                            {(activeTrack === "drums1" || activeTrack === "drums2" || activeTrack === "drums3" || activeTrack === "drums4") && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[8px] font-bold uppercase tracking-wider" style={{ color: trackColor }}>{activeTrackName}</span>
                                        <span className="text-[7px] text-white/20">Ch 10 • All Drums</span>
                                    </div>

                                    {/* 4 large drum pads — one per drum track */}
                                    <div className="grid grid-cols-4 gap-2">
                                        {profile.tracks.filter(t => t.type === "drum").map((dt, i) => {
                                            const drumNote = dt.noteRange?.low ?? (60 + i * 2);
                                            const padKey = `9:${drumNote}`;
                                            const isActive = activePads.has(padKey);
                                            const drumLabel = dt.name.replace("Drum ", "D");
                                            return (
                                                <button
                                                    key={dt.name}
                                                    onPointerDown={() => handleDrumTrigger(drumNote)}
                                                    className={cn(
                                                        "h-10 rounded-md border-2 transition-all duration-75 cursor-pointer flex flex-col items-center justify-center gap-0.5",
                                                        "hover:brightness-125 active:scale-95",
                                                        isActive && "ring-1 ring-white/40"
                                                    )}
                                                    style={{
                                                        backgroundColor: isActive ? dt.color : `${dt.color}25`,
                                                        borderColor: isActive ? dt.color : `${dt.color}50`,
                                                        boxShadow: isActive ? `0 0 12px ${dt.color}60, inset 0 0 6px ${dt.color}40` : "none",
                                                    }}
                                                >
                                                    <span className="text-[8px] font-bold" style={{ color: isActive ? "#fff" : `${dt.color}cc` }}>{drumLabel}</span>
                                                    <span className="text-[5px]" style={{ color: isActive ? "#ffffffaa" : `${dt.color}60` }}>{drumNote}</span>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    {/* Drum track selector for macros */}
                                    <div className="flex gap-1 pt-1 border-t border-white/[0.04]">
                                        {profile.tracks.filter(t => t.type === "drum").map(dt => {
                                            const dtId = `drums${profile.tracks.filter(t => t.type === "drum").indexOf(dt) + 1}` as ActiveTrack;
                                            const isActive = activeTrackName === dt.name;
                                            return (
                                                <button
                                                    key={dt.name}
                                                    onClick={() => setActiveTrack(dtId)}
                                                    className={cn(
                                                        "flex-1 py-0.5 rounded text-[6px] font-bold transition-all cursor-pointer",
                                                        isActive ? "text-white" : "text-white/20 hover:text-white/40"
                                                    )}
                                                    style={{
                                                        backgroundColor: isActive ? `${dt.color}25` : "transparent",
                                                        borderBottom: isActive ? `1.5px solid ${dt.color}` : "1.5px solid transparent",
                                                    }}
                                                >
                                                    {dt.name}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* MIDI tracks */}
                            {(activeTrack === "midi1" || activeTrack === "midi2") && activeTrackProfile && (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2 mb-1">
                                        <Radio className="h-3 w-3" style={{ color: trackColor, opacity: 0.5 }} />
                                        <span className="text-[8px] font-bold" style={{ color: trackColor }}>{activeTrackName}</span>
                                        <span className="text-[6px] text-white/15">Ch {activeTrackProfile.midiChannel + 1}</span>
                                    </div>
                                    {/* Note Pads — 2×8 chromatic grid */}
                                    {[0, 8].map(rowStart => (
                                        <div key={rowStart} className="grid grid-cols-8 gap-1">
                                            {Array.from({ length: 8 }).map((_, i) => {
                                                const noteNum = 48 + rowStart + i;
                                                const padKey = `${activeTrackProfile.midiChannel}:${noteNum}`;
                                                const isActive = activePads.has(padKey);
                                                const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
                                                const noteName = noteNames[noteNum % 12];
                                                const octave = Math.floor(noteNum / 12) - 1;
                                                return (
                                                    <button
                                                        key={noteNum}
                                                        onPointerDown={() => handleSynthNoteTrigger(activeTrackProfile.midiChannel, noteNum)}
                                                        className={cn(
                                                            "h-6 rounded-sm border transition-all duration-75 cursor-pointer",
                                                            "hover:brightness-125 active:scale-95",
                                                            isActive && "ring-1 ring-white/30"
                                                        )}
                                                        style={{
                                                            backgroundColor: isActive ? trackColor : `${trackColor}20`,
                                                            borderColor: `${trackColor}40`,
                                                            boxShadow: isActive ? `0 0 8px ${trackColor}60` : "none",
                                                        }}
                                                    >
                                                        <span className="text-[5px] text-white/40">{noteName}{octave}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Master Filter */}
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
                    </>
                )}

                {/* ══════════════════════════════════════════════════════
                    VIEW: MIXER — 8-track volume faders, pan, mute
                   ══════════════════════════════════════════════════════ */}
                {panelView === "mixer" && (
                    <div className="px-3 py-2 border-t border-white/[0.06]">
                        {/* Pan/Vol toggle */}
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[7px] text-white/15 uppercase tracking-wider">Track Mixer</span>
                            <div className="flex items-center gap-0.5 bg-white/[0.04] rounded-md p-0.5">
                                <button
                                    onClick={() => setMixerShowPan(false)}
                                    className={cn(
                                        "text-[6px] font-bold px-1.5 py-0.5 rounded transition-all cursor-pointer",
                                        !mixerShowPan ? "bg-white/10 text-white/60" : "text-white/20 hover:text-white/35"
                                    )}
                                >
                                    VOL
                                </button>
                                <button
                                    onClick={() => setMixerShowPan(true)}
                                    className={cn(
                                        "text-[6px] font-bold px-1.5 py-0.5 rounded transition-all cursor-pointer",
                                        mixerShowPan ? "bg-white/10 text-white/60" : "text-white/20 hover:text-white/35"
                                    )}
                                >
                                    PAN
                                </button>
                            </div>
                        </div>

                        <div className="flex gap-1">
                            {TRACK_NAMES_ALL.map((name, idx) => {
                                const ts = trackStates[name];
                                const color = TRACK_COLORS_ALL[idx];
                                const vol = mixerVolumes[idx];
                                const pan = mixerPans[idx];
                                const label = name.slice(0, 2).replace(" ", "");

                                return (
                                    <div key={name} className="flex-1 flex flex-col items-center gap-1">
                                        {/* Label */}
                                        <span className="text-[6px] font-bold" style={{ color: ts?.muted ? "rgba(255,255,255,0.15)" : color }}>
                                            {label}{name.slice(-1)}
                                        </span>

                                        {!mixerShowPan ? (
                                            /* Volume fader */
                                            <div className="relative w-3 h-16 bg-white/[0.06] rounded-full overflow-hidden">
                                                <div
                                                    className="absolute bottom-0 w-full rounded-full transition-all duration-75"
                                                    style={{
                                                        height: `${(vol / 127) * 100}%`,
                                                        backgroundColor: ts?.muted ? "rgba(255,255,255,0.08)" : color,
                                                        boxShadow: !ts?.muted ? `0 0 4px ${color}40` : undefined,
                                                    }}
                                                />
                                                <input
                                                    type="range" min={0} max={127} value={vol}
                                                    onChange={(e) => handleMixerVolume(idx, parseInt(e.target.value))}
                                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                                    style={{ writingMode: "vertical-lr", direction: "rtl" }}
                                                />
                                            </div>
                                        ) : (
                                            /* Pan knob */
                                            <MiniKnob
                                                value={pan}
                                                label=""
                                                color={color}
                                                onChange={(v) => handleMixerPan(idx, v)}
                                                size={22}
                                            />
                                        )}

                                        {/* Value */}
                                        <span className="text-[6px] tabular-nums text-white/20">
                                            {!mixerShowPan ? vol : (pan < 60 ? `L${64 - pan}` : pan > 68 ? `R${pan - 64}` : "C")}
                                        </span>

                                        {/* Mute button */}
                                        <button
                                            onClick={() => setTrackStates(prev => ({
                                                ...prev,
                                                [name]: { ...prev[name], muted: !prev[name].muted },
                                            }))}
                                            className={cn(
                                                "text-[5px] font-bold w-full py-0.5 rounded cursor-pointer transition-all text-center",
                                                ts?.muted ? "bg-red-500/20 text-red-400" : "bg-white/5 text-white/20 hover:bg-white/10"
                                            )}
                                        >
                                            {ts?.muted ? "M" : "•"}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Master Filter below mixer */}
                        <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/[0.04]">
                            <span className="text-[7px] text-white/20 uppercase tracking-wider shrink-0">Master</span>
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
                    </div>
                )}

                {/* ══════════════════════════════════════════════════════
                    VIEW: FX — Reverb & Delay presets + per-track sends
                   ══════════════════════════════════════════════════════ */}
                {panelView === "fx" && (
                    <div className="px-3 py-2 border-t border-white/[0.06]">
                        {/* FX sub-tabs */}
                        <div className="flex items-center gap-1 mb-2">
                            <button
                                onClick={() => setFxTab("reverb")}
                                className={cn(
                                    "flex-1 py-1 rounded-md text-[7px] font-bold uppercase tracking-wider transition-all cursor-pointer border",
                                    fxTab === "reverb"
                                        ? "bg-purple-500/15 border-purple-500/30 text-purple-400"
                                        : "bg-white/[0.02] border-transparent text-white/20 hover:bg-white/[0.05]"
                                )}
                            >
                                Reverb
                            </button>
                            <button
                                onClick={() => setFxTab("delay")}
                                className={cn(
                                    "flex-1 py-1 rounded-md text-[7px] font-bold uppercase tracking-wider transition-all cursor-pointer border",
                                    fxTab === "delay"
                                        ? "bg-blue-500/15 border-blue-500/30 text-blue-400"
                                        : "bg-white/[0.02] border-transparent text-white/20 hover:bg-white/[0.05]"
                                )}
                            >
                                Delay
                            </button>
                        </div>

                        {fxTab === "reverb" ? (
                            <>
                                {/* Reverb preset selector */}
                                <div className="mb-2">
                                    <div className="text-[6px] text-white/15 uppercase tracking-wider mb-1">Reverb Preset</div>
                                    <div className="grid grid-cols-4 gap-0.5">
                                        {REVERB_PRESETS.map((name, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleReverbPresetChange(i)}
                                                className={cn(
                                                    "py-1 rounded text-[6px] font-medium transition-all cursor-pointer border truncate px-0.5",
                                                    reverbPreset === i
                                                        ? "bg-purple-500/20 border-purple-500/30 text-purple-300"
                                                        : "bg-white/[0.03] border-white/[0.06] text-white/25 hover:bg-white/[0.06]"
                                                )}
                                                title={name}
                                            >
                                                {i + 1}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="text-[7px] text-purple-400/60 mt-0.5 text-center truncate">{REVERB_PRESETS[reverbPreset]}</div>
                                </div>

                                {/* Per-track reverb sends */}
                                <div className="border-t border-white/[0.04] pt-2">
                                    <div className="text-[6px] text-white/15 uppercase tracking-wider mb-1">Reverb Send</div>
                                    <div className="flex gap-1">
                                        {TRACK_NAMES_ALL.map((name, idx) => {
                                            const color = TRACK_COLORS_ALL[idx];
                                            return (
                                                <div key={name} className="flex-1 flex flex-col items-center gap-0.5">
                                                    <MiniKnob
                                                        value={reverbSends[idx]}
                                                        label=""
                                                        color={color}
                                                        onChange={(v) => handleReverbSend(idx, v)}
                                                        size={20}
                                                    />
                                                    <span className="text-[5px] font-bold" style={{ color }}>{name.slice(0, 1)}{name.slice(-1)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <>
                                {/* Delay preset selector */}
                                <div className="mb-2">
                                    <div className="text-[6px] text-white/15 uppercase tracking-wider mb-1">Delay Preset</div>
                                    <div className="grid grid-cols-4 gap-0.5">
                                        {DELAY_PRESETS.map((name, i) => (
                                            <button
                                                key={i}
                                                onClick={() => handleDelayPresetChange(i)}
                                                className={cn(
                                                    "py-1 rounded text-[6px] font-medium transition-all cursor-pointer border truncate px-0.5",
                                                    delayPreset === i
                                                        ? "bg-blue-500/20 border-blue-500/30 text-blue-300"
                                                        : "bg-white/[0.03] border-white/[0.06] text-white/25 hover:bg-white/[0.06]"
                                                )}
                                                title={name}
                                            >
                                                {i + 1}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="text-[7px] text-blue-400/60 mt-0.5 text-center truncate">{DELAY_PRESETS[delayPreset]}</div>
                                </div>

                                {/* Per-track delay sends */}
                                <div className="border-t border-white/[0.04] pt-2">
                                    <div className="text-[6px] text-white/15 uppercase tracking-wider mb-1">Delay Send</div>
                                    <div className="flex gap-1">
                                        {TRACK_NAMES_ALL.map((name, idx) => {
                                            const color = TRACK_COLORS_ALL[idx];
                                            return (
                                                <div key={name} className="flex-1 flex flex-col items-center gap-0.5">
                                                    <MiniKnob
                                                        value={delaySends[idx]}
                                                        label=""
                                                        color={color}
                                                        onChange={(v) => handleDelaySend(idx, v)}
                                                        size={20}
                                                    />
                                                    <span className="text-[5px] font-bold" style={{ color }}>{name.slice(0, 1)}{name.slice(-1)}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {/* ══════════════════════════════════════════════════════
                    VIEW: SIDECHAIN — Per-track sidechain preset & trigger
                   ══════════════════════════════════════════════════════ */}
                {panelView === "sidechain" && (
                    <div className="px-3 py-2 border-t border-white/[0.06]">
                        <div className="text-[7px] text-white/15 uppercase tracking-wider mb-2">Sidechain Compressor</div>
                        <div className="space-y-2">
                            {["Synth 1", "Synth 2", "MIDI 1", "MIDI 2"].map((name, tIdx) => {
                                const color = TRACK_COLORS_ALL[tIdx];
                                const preset = sidechainPresets[tIdx];
                                const key = sidechainKeys[tIdx];
                                return (
                                    <div key={name} className="space-y-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[7px] font-bold w-6" style={{ color }}>{name.slice(0, 1)}{name.slice(-1)}</span>
                                            <div className="flex gap-0.5 flex-1">
                                                {SIDECHAIN_PRESETS.map((pName, pIdx) => (
                                                    <button
                                                        key={pIdx}
                                                        onClick={() => handleSidechainPreset(tIdx, pIdx)}
                                                        className={cn(
                                                            "flex-1 py-0.5 rounded text-[5px] font-bold transition-all cursor-pointer border",
                                                            preset === pIdx
                                                                ? "text-white"
                                                                : "bg-white/[0.02] border-white/[0.04] text-white/15 hover:bg-white/[0.05]"
                                                        )}
                                                        style={preset === pIdx ? {
                                                            backgroundColor: pIdx === 0 ? "rgba(255,255,255,0.05)" : `${color}20`,
                                                            borderColor: pIdx === 0 ? "rgba(255,255,255,0.1)" : `${color}40`,
                                                            color: pIdx === 0 ? "rgba(255,255,255,0.4)" : color,
                                                        } : undefined}
                                                    >
                                                        {pIdx === 0 ? "OFF" : pIdx}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        {/* Key drum selector (only shown if sidechain is active) */}
                                        {preset > 0 && (
                                            <div className="flex items-center gap-1 ml-8">
                                                <span className="text-[5px] text-white/15 uppercase tracking-wider">Key:</span>
                                                {["D1", "D2", "D3", "D4"].map((dName, dIdx) => (
                                                    <button
                                                        key={dIdx}
                                                        onClick={() => handleSidechainKey(tIdx, dIdx)}
                                                        className={cn(
                                                            "px-1.5 py-0.5 rounded text-[5px] font-bold transition-all cursor-pointer border",
                                                            key === dIdx
                                                                ? "bg-orange-500/15 border-orange-500/30 text-orange-400"
                                                                : "bg-white/[0.02] border-white/[0.04] text-white/15 hover:bg-white/[0.05]"
                                                        )}
                                                    >
                                                        {dName}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* ══════════════════════════════════════════════════════
                    VIEW: PROJECTS & PATCHES — Project select + synth patch select
                   ══════════════════════════════════════════════════════ */}
                {panelView === "patterns" && (
                    <div className="px-3 py-2 border-t border-white/[0.06] space-y-2">
                        {/* ── Project Selector (64 projects, 8×4 grid per page) ── */}
                        <div>
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-[7px] text-white/15 uppercase tracking-wider">Project / Session</span>
                                <span className="text-[8px] font-mono font-bold tabular-nums" style={{ color: brandColor }}>
                                    #{(currentProject + 1).toString().padStart(2, "0")}
                                </span>
                            </div>
                            <div className="text-[5px] text-white/10 mb-1">Program Change on Ch16 — switches entire project (incl. BPM, patterns, patches)</div>
                            <div className="grid grid-cols-8 gap-0.5">
                                {Array.from({ length: 64 }).map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => handleProjectChange(i)}
                                        className={cn(
                                            "py-1 rounded text-[6px] font-bold transition-all cursor-pointer border",
                                            currentProject === i
                                                ? "text-white shadow-md"
                                                : "bg-white/[0.03] border-white/[0.06] text-white/15 hover:bg-white/[0.06] hover:text-white/30"
                                        )}
                                        style={currentProject === i ? {
                                            backgroundColor: `${brandColor}25`,
                                            borderColor: `${brandColor}50`,
                                            boxShadow: `0 0 6px ${brandColor}30`,
                                        } : undefined}
                                    >
                                        {i + 1}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* ── Synth Patch Selectors ── */}
                        <div className="border-t border-white/[0.04] pt-2">
                            <div className="flex items-center justify-between mb-1">
                                <span className="text-[7px] text-white/15 uppercase tracking-wider">Synth Patches</span>
                                <div className="flex items-center gap-0.5">
                                    {[0, 1, 2, 3].map(p => (
                                        <button
                                            key={p}
                                            onClick={() => setPatchPage(p)}
                                            className={cn(
                                                "px-1.5 py-0.5 rounded text-[5px] font-bold transition-all cursor-pointer border",
                                                patchPage === p
                                                    ? "bg-white/10 border-white/20 text-white/60"
                                                    : "bg-white/[0.02] border-white/[0.04] text-white/15 hover:bg-white/[0.06]"
                                            )}
                                        >
                                            P{p + 1}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Synth 1 patches */}
                            <div className="mb-1.5">
                                <div className="flex items-center justify-between mb-0.5">
                                    <span className="text-[6px] font-bold" style={{ color: "#9333ea" }}>Synth 1</span>
                                    <span className="text-[6px] text-white/20 tabular-nums font-mono">Patch {synth1Patch + 1}</span>
                                </div>
                                <div className="grid grid-cols-8 gap-0.5">
                                    {Array.from({ length: 32 }).map((_, i) => {
                                        const patchIdx = patchPage * 32 + i;
                                        return (
                                            <button
                                                key={patchIdx}
                                                onClick={() => handleSynth1PatchChange(patchIdx)}
                                                className={cn(
                                                    "py-0.5 rounded text-[5px] font-bold transition-all cursor-pointer border",
                                                    synth1Patch === patchIdx
                                                        ? "text-white"
                                                        : "bg-white/[0.02] border-white/[0.04] text-white/15 hover:bg-white/[0.06]"
                                                )}
                                                style={synth1Patch === patchIdx ? {
                                                    backgroundColor: "#9333ea25",
                                                    borderColor: "#9333ea50",
                                                } : undefined}
                                            >
                                                {patchIdx + 1}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Synth 2 patches */}
                            <div>
                                <div className="flex items-center justify-between mb-0.5">
                                    <span className="text-[6px] font-bold" style={{ color: "#06b6d4" }}>Synth 2</span>
                                    <span className="text-[6px] text-white/20 tabular-nums font-mono">Patch {synth2Patch + 1}</span>
                                </div>
                                <div className="grid grid-cols-8 gap-0.5">
                                    {Array.from({ length: 32 }).map((_, i) => {
                                        const patchIdx = patchPage * 32 + i;
                                        return (
                                            <button
                                                key={patchIdx}
                                                onClick={() => handleSynth2PatchChange(patchIdx)}
                                                className={cn(
                                                    "py-0.5 rounded text-[5px] font-bold transition-all cursor-pointer border",
                                                    synth2Patch === patchIdx
                                                        ? "text-white"
                                                        : "bg-white/[0.02] border-white/[0.04] text-white/15 hover:bg-white/[0.06]"
                                                )}
                                                style={synth2Patch === patchIdx ? {
                                                    backgroundColor: "#06b6d425",
                                                    borderColor: "#06b6d450",
                                                } : undefined}
                                            >
                                                {patchIdx + 1}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {/* ── Info: Patterns & Scenes ── */}
                        <div className="border-t border-white/[0.04] pt-1.5">
                            <div className="text-[5px] text-white/10 leading-relaxed">
                                <span className="text-white/20 font-bold">Patterns</span> (8 per track) and <span className="text-white/20 font-bold">Scenes</span> (16 per project) are selected on-device only.
                                <span className="text-white/20 font-bold"> Sound packs</span> are loaded via Novation Components.
                            </div>
                        </div>

                        {/* Sequencer */}
                        <div className="border-t border-white/[0.04] pt-1.5">
                            <SequencerSteps currentStep={currentStep} totalSteps={32} color={brandColor} isPlaying={isPlaying} />
                        </div>
                    </div>
                )}

                {/* ── Resize Handle ──────────────────────────────────── */}
                <div
                    className="flex items-center justify-center py-1 cursor-se-resize group"
                    onPointerDown={handleResizeStart}
                    onPointerMove={handleResizeMove}
                    onPointerUp={handleResizeEnd}
                >
                    <svg width="12" height="12" viewBox="0 0 12 12" className="text-white/15 group-hover:text-white/30 transition-colors">
                        <path d="M10 2 L2 10" stroke="currentColor" strokeWidth="1" />
                        <path d="M10 6 L6 10" stroke="currentColor" strokeWidth="1" />
                        <path d="M10 10 L10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </div>
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
