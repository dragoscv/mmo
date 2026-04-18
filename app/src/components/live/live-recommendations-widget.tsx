"use client";

/**
 * LiveRecommendationsWidget — real-time human-readable voice coaching based on
 * the currently selected key/scale and live mic input (pitch, intonation,
 * input level, scale-fit). Inspired by the DAW Voice Processor's coach.
 *
 * Two modes:
 *   - Host (default): polls `engine.voice.getMeterData()` every 250ms.
 *   - Remote: receives a `meterSource` callback (or static snapshot) from the
 *     remote widget host bridge.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Mic, MicOff, CheckCircle2, AlertTriangle, Info, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveOptional } from "@/components/live/live-context";
import { useLiveMeters } from "@/components/live/live-meters-store";
import { MUSICAL_SCALES, type PitchInfo } from "@/lib/audio-fx-engine";
import { useLiveSettings, getActiveLiveNotations } from "@/hooks/use-live-settings";
import { useStableValue } from "@/hooks/use-stable-value";
import { formatNoteMulti, type NoteNotation } from "@/lib/note-notation";

// ─── Types ───────────────────────────────────────────────────────────────

export type CoachKind = "success" | "warning" | "info" | "tip";

export interface CoachTip {
    kind: CoachKind;
    text: string;
}

export interface VoiceMeterSnapshot {
    pitch: PitchInfo;
    rms: number;
    peakL: number;
    peakR: number;
}

interface Props {
    className?: string;
    compact?: boolean;
    /** When set, the widget renders this snapshot directly (remote mode). */
    snapshot?: VoiceMeterSnapshot | null;
    /** Override key/scale from props (remote mode). */
    keyIndex?: number;
    scaleIndex?: number;
    /** Whether the voice engine is active (controls empty-state text). */
    voiceActive?: boolean;
}

// ─── Helpers (same logic as DAW voice processor) ─────────────────────────

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function noteName(idx: number, notations?: NoteNotation[], quality?: "major" | "minor"): string {
    const i = ((idx % 12) + 12) % 12;
    const n = notations ?? getActiveLiveNotations();
    return formatNoteMulti(i, n, quality, "/") || NOTE_NAMES[i] || "?";
}

function getScaleNotes(key: number, scaleIdx: number): Set<number> {
    const scale = MUSICAL_SCALES[scaleIdx];
    if (!scale) return new Set(Array.from({ length: 12 }, (_, i) => i));
    return new Set(scale.intervals.map((i) => (key + i) % 12));
}

function getNearestInScaleNotes(notePC: number, scaleNotes: Set<number>): number[] {
    if (scaleNotes.has(notePC)) return [notePC];
    const result: number[] = [];
    for (let offset = 1; offset <= 6; offset++) {
        const up = (notePC + offset) % 12;
        const down = (notePC - offset + 12) % 12;
        if (scaleNotes.has(up)) result.push(up);
        if (scaleNotes.has(down) && down !== up) result.push(down);
        if (result.length > 0) return result;
    }
    return [];
}

export function generateVoiceTips(
    snap: VoiceMeterSnapshot,
    keyIndex: number,
    scaleIndex: number,
): CoachTip[] {
    const tips: CoachTip[] = [];
    const { pitch, rms, peakL, peakR } = snap;
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -60;
    const notations = getActiveLiveNotations();
    const scaleName = MUSICAL_SCALES[scaleIndex]?.name ?? "Chromatic";
    const quality: "major" | "minor" = /major/i.test(scaleName) ? "major" : "minor";
    const fmt = (i: number) => noteName(i, notations, quality);

    if (rmsDb < -40) {
        tips.push({ kind: "warning", text: "Input level is very low — move closer to the mic or raise input gain." });
    } else if (peakL > 0.95 || peakR > 0.95) {
        tips.push({ kind: "warning", text: "Input is clipping! Reduce input gain or back off the mic." });
    }

    if (pitch.confidence < 0.5 || pitch.frequency === 0) {
        if (rmsDb > -35) {
            tips.push({ kind: "info", text: "No clear pitch yet — try sustaining a note." });
        }
        return tips;
    }

    const notePC = ((pitch.noteIndex % 12) + 12) % 12;
    const scaleNotes = getScaleNotes(keyIndex, scaleIndex);
    const kName = fmt(keyIndex);
    const noteLabel = fmt(notePC);

    if (scaleNotes.has(notePC)) {
        tips.push({ kind: "success", text: `${noteLabel} fits ${kName} ${scaleName} — great choice!` });
    } else {
        const nearest = getNearestInScaleNotes(notePC, scaleNotes).map(fmt).join(" or ");
        tips.push({ kind: "warning", text: `${noteLabel} is outside ${kName} ${scaleName}. Try ${nearest}.` });
    }

    if (Math.abs(pitch.cents) <= 8) {
        tips.push({ kind: "success", text: "Excellent intonation — right on pitch." });
    } else if (pitch.cents > 8) {
        tips.push({ kind: "info", text: `~${pitch.cents}¢ sharp — relax slightly to lower pitch.` });
    } else {
        tips.push({ kind: "info", text: `~${Math.abs(pitch.cents)}¢ flat — more breath support helps.` });
    }

    const root = kName;
    const fifth = fmt(keyIndex + 7);
    switch (scaleIndex) {
        case 1: {
            const third = fmt(keyIndex + 4);
            tips.push({ kind: "tip", text: `In ${root} Major, anchor on ${root}, ${third}, and ${fifth}.` });
            break;
        }
        case 2: {
            const third = fmt(keyIndex + 3);
            tips.push({ kind: "tip", text: `In ${root} Minor, build around ${root}, ${third}, and ${fifth}.` });
            break;
        }
        case 3:
            tips.push({ kind: "tip", text: `${root} Pentatonic Major — no wrong notes!` });
            break;
        case 4:
            tips.push({ kind: "tip", text: `${root} Pentatonic Minor — every note works.` });
            break;
        case 5: {
            const blue = fmt(keyIndex + 6);
            tips.push({ kind: "tip", text: `Bend into the blue note (${blue}) for expression.` });
            break;
        }
        case 6: {
            const sixth = fmt(keyIndex + 9);
            tips.push({ kind: "tip", text: `Raised 6th (${sixth}) gives ${root} Dorian its bright minor color.` });
            break;
        }
        case 7: {
            const seventh = fmt(keyIndex + 10);
            tips.push({ kind: "tip", text: `Flat 7th (${seventh}) gives ${root} Mixolydian its bluesy feel.` });
            break;
        }
        case 8: {
            const seventh = fmt(keyIndex + 11);
            tips.push({ kind: "tip", text: `Raised 7th (${seventh}) creates drama in ${root} Harmonic Minor.` });
            break;
        }
    }

    return tips;
}

// ─── Component ───────────────────────────────────────────────────────────

const KIND_STYLES: Record<CoachKind, { ring: string; bg: string; text: string; icon: typeof CheckCircle2 }> = {
    success: { ring: "ring-emerald-400/40", bg: "bg-emerald-500/10", text: "text-emerald-200", icon: CheckCircle2 },
    warning: { ring: "ring-amber-400/40", bg: "bg-amber-500/10", text: "text-amber-200", icon: AlertTriangle },
    info: { ring: "ring-sky-400/40", bg: "bg-sky-500/10", text: "text-sky-200", icon: Info },
    tip: { ring: "ring-violet-400/40", bg: "bg-violet-500/10", text: "text-violet-200", icon: Lightbulb },
};

const IDLE_TIPS: CoachTip[] = [
    { kind: "info", text: "Start the voice processor to receive realtime pitch & scale guidance." },
];

export function LiveRecommendationsWidget({
    className,
    compact = false,
    snapshot,
    keyIndex: keyIndexProp,
    scaleIndex: scaleIndexProp,
    voiceActive: voiceActiveProp,
}: Props) {
    const live = useLiveOptional();
    const settings = useLiveSettings();
    const [tips, setTips] = useState<CoachTip[]>(IDLE_TIPS);
    const [meter, setMeter] = useState<VoiceMeterSnapshot | null>(null);
    // Subscribe to the central meters store. Re-renders at the rate set by the
    // global refresh slider (1-30Hz). No separate setInterval needed.
    const liveMeters = useLiveMeters();

    const keyIndex = keyIndexProp ?? live?.keyIndex ?? 0;
    const scaleIndex = scaleIndexProp ?? live?.scaleIndex ?? 1;
    const isActive = voiceActiveProp ?? live?.voiceActive ?? false;
    const keyRef = useRef(keyIndex);
    const scaleRef = useRef(scaleIndex);
    keyRef.current = keyIndex;
    scaleRef.current = scaleIndex;

    // Host mode: derive tips from the throttled meters store snapshot
    useEffect(() => {
        if (snapshot !== undefined) return; // remote mode
        if (!live?.engine || !isActive) {
            setTips(IDLE_TIPS);
            setMeter(null);
            return;
        }
        const snap: VoiceMeterSnapshot = {
            pitch: {
                note: liveMeters.tunerNote,
                cents: liveMeters.tunerCents,
                frequency: liveMeters.tunerFrequency,
                confidence: liveMeters.tunerConfidence,
                noteIndex: liveMeters.tunerNoteIndex,
            },
            rms: liveMeters.voiceRms,
            peakL: liveMeters.voicePeakL,
            peakR: liveMeters.voicePeakR,
        };
        setMeter(snap);
        setTips(generateVoiceTips(snap, keyRef.current, scaleRef.current));
    }, [live?.engine, isActive, snapshot, liveMeters]);

    // Remote mode: derive tips from the provided snapshot
    useEffect(() => {
        if (snapshot === undefined) return; // host mode
        if (!snapshot || !isActive) {
            setTips(IDLE_TIPS);
            setMeter(null);
            return;
        }
        setMeter(snapshot);
        setTips(generateVoiceTips(snapshot, keyIndex, scaleIndex));
    }, [snapshot, isActive, keyIndex, scaleIndex]);

    const headerSubtitle = useMemo(() => {
        const kName = noteName(keyIndex, settings.noteNotations, /major/i.test(MUSICAL_SCALES[scaleIndex]?.name ?? "") ? "major" : "minor");
        const scale = MUSICAL_SCALES[scaleIndex]?.name ?? "Chromatic";
        if (!isActive) return `${kName} · ${scale} · idle`;
        if (!meter || meter.pitch.confidence < 0.5) return `${kName} · ${scale} · listening…`;
        const noteLabel = meter.pitch.noteIndex >= 0 ? noteName(meter.pitch.noteIndex, settings.noteNotations) : meter.pitch.note;
        const centsTag = settings.showCents ? ` (${meter.pitch.cents > 0 ? "+" : ""}${Math.round(meter.pitch.cents)}¢)` : "";
        return `${kName} · ${scale} · ${noteLabel}${centsTag}`;
    }, [keyIndex, scaleIndex, isActive, meter, settings.noteNotations, settings.showCents]);

    // Stickify the tip list: hash the kinds+texts, hold the hash for the
    // user-configured stickinessMs, then surface the latest snapshot whose
    // hash matches the held value. This prevents the rows from rewriting on
    // every meter tick — they only swap when the stable hash changes.
    const tipsHash = tips.map(t => `${t.kind}|${t.text}`).join("\u0001");
    const stableHash = useStableValue(tipsHash, settings.coachStickinessMs);
    const lastShownRef = useRef<{ hash: string; tips: CoachTip[] }>({ hash: tipsHash, tips });
    if (stableHash === tipsHash) lastShownRef.current = { hash: tipsHash, tips };
    const displayedTips = lastShownRef.current.tips;
    const tipLimit = settings.coachVerbosity === "minimal" ? 1 : settings.coachVerbosity === "verbose" ? Infinity : 3;
    const visibleTips = displayedTips.slice(0, tipLimit);

    return (
        <div className={cn(
            "rounded-xl border border-violet-400/20 bg-gradient-to-br from-violet-500/5 via-card/60 to-fuchsia-500/5 backdrop-blur-sm overflow-hidden",
            className,
        )}>
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/40">
                <div className="flex items-center gap-2 min-w-0">
                    <div className="h-7 w-7 rounded-lg bg-violet-500/15 ring-1 ring-violet-400/30 flex items-center justify-center shrink-0">
                        <Sparkles className="h-3.5 w-3.5 text-violet-300" />
                    </div>
                    <div className="min-w-0">
                        <div className="text-xs font-semibold text-foreground/90">Realtime Coach</div>
                        <div className="text-[10px] text-muted-foreground truncate">{headerSubtitle}</div>
                    </div>
                </div>
                {isActive
                    ? <Mic className="h-3.5 w-3.5 text-rose-300 shrink-0" />
                    : <MicOff className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />}
            </div>

            <div className={cn("p-2 space-y-1.5 overflow-y-auto", compact ? "max-h-[180px]" : "max-h-[320px]")}>
                {/* Stable keys per slot + no layout/exit animation eliminate the
                    flicker from re-creating tip rows whenever the text shifts.
                    Stickiness (above) holds the displayed list for at least
                    `coachStickinessMs` so users can read each tip. */}
                {visibleTips.map((tip, i) => {
                    const style = KIND_STYLES[tip.kind];
                    const Icon = style.icon;
                    return (
                        <div
                            key={i}
                            className={cn(
                                "flex items-start gap-2 rounded-md px-2 py-1.5 ring-1",
                                style.bg, style.ring,
                            )}
                        >
                            <Icon className={cn("h-3.5 w-3.5 mt-0.5 shrink-0", style.text)} />
                            <span className={cn("text-[11px] leading-snug", style.text)}>{tip.text}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
