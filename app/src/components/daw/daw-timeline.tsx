"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { useDAW } from "./daw-context";
import {
    Volume2, VolumeX, Headphones, Circle, Trash2, Plus, Piano, Music,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DAWTrack, Clip } from "@/lib/daw-engine";

const HEADER_WIDTH = 200;
const RULER_HEIGHT = 30;

export function DAWTimeline() {
    const daw = useDAW();
    const containerRef = useRef<HTMLDivElement>(null);
    const [dragClip, setDragClip] = useState<{ clipId: string; startX: number; startPos: number } | null>(null);

    const pxPerBeat = daw.zoom;
    const totalBeats = Math.max(daw.project.duration, 128);

    const snapToBeat = useCallback((beat: number): number => {
        const grid: Record<string, number> = {
            "1/1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "none": 0,
        };
        const snap = grid[daw.snap] ?? 1;
        if (snap === 0) return beat;
        return Math.round(beat / snap) * snap;
    }, [daw.snap]);

    const handleRulerClick = useCallback((e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);
        daw.seek(beat);
    }, [daw, pxPerBeat, snapToBeat]);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            daw.setZoom(daw.zoom + (e.deltaY > 0 ? -5 : 5));
        } else if (e.shiftKey) {
            daw.setScroll(daw.scrollX + e.deltaY / pxPerBeat, daw.scrollY);
        } else {
            daw.setScroll(daw.scrollX, daw.scrollY + e.deltaY);
        }
    }, [daw, pxPerBeat]);

    const handleClipMouseDown = useCallback((e: React.MouseEvent, clip: Clip) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        daw.selectClip(clip.id);
        if (daw.tool === "select") {
            setDragClip({ clipId: clip.id, startX: e.clientX, startPos: clip.position });
        }
    }, [daw]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!dragClip) return;
        const dx = e.clientX - dragClip.startX;
        const dBeats = dx / pxPerBeat;
        const newPos = snapToBeat(Math.max(0, dragClip.startPos + dBeats));
        daw.moveClip(dragClip.clipId, "", newPos);
    }, [dragClip, pxPerBeat, snapToBeat, daw]);

    const handleMouseUp = useCallback(() => {
        setDragClip(null);
    }, []);

    const handleTrackDoubleClick = useCallback((e: React.MouseEvent, track: DAWTrack) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);
        const clipType = track.type === "midi" ? "midi" : "audio";
        const clip = daw.addClip(track.id, clipType as "audio" | "midi", beat, 4, `Clip ${track.clips.length + 1}`);
        if (track.type === "midi") {
            daw.openPianoRoll(track.id, clip.id);
        }
    }, [daw, pxPerBeat, snapToBeat]);

    const handleClipRightClick = useCallback((e: React.MouseEvent, clip: Clip) => {
        e.preventDefault();
        daw.selectClip(clip.id);
    }, [daw]);

    const handleTrackDrop = useCallback(async (e: React.DragEvent, track: DAWTrack) => {
        e.preventDefault();
        if (track.type !== "audio") return;
        const files = Array.from(e.dataTransfer.files);
        const audioFile = files.find(f => f.type.startsWith("audio/"));
        if (!audioFile) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);
        const clip = daw.addClip(track.id, "audio", beat, 4, audioFile.name);
        await daw.loadFileIntoClip(clip.id, audioFile);
    }, [daw, pxPerBeat, snapToBeat]);

    const playheadX = (daw.currentBeat - daw.scrollX) * pxPerBeat;

    return (
        <div
            ref={containerRef}
            className="h-full flex flex-col bg-[var(--daw-bg)] overflow-hidden"
            onWheel={handleWheel}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
        >
            {/* Ruler */}
            <div className="flex flex-shrink-0" style={{ height: RULER_HEIGHT }}>
                <div
                    className="flex-shrink-0 bg-[var(--daw-surface)] border-r border-b border-[var(--daw-border)] flex items-center px-3"
                    style={{ width: HEADER_WIDTH }}
                >
                    <button
                        onClick={() => daw.addTrack("audio")}
                        className="daw-btn h-6 gap-1 px-2 text-[10px] text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
                    >
                        <Plus className="h-3 w-3" /> Add Track
                    </button>
                </div>
                <div
                    className="flex-1 bg-[var(--daw-surface)] border-b border-[var(--daw-border)] relative overflow-hidden cursor-pointer"
                    onClick={handleRulerClick}
                >
                    <RulerCanvas
                        scrollX={daw.scrollX}
                        pxPerBeat={pxPerBeat}
                        totalBeats={totalBeats}
                        timeSignature={daw.project.timeSignature}
                        loopRegion={daw.project.loopRegion}
                    />
                    {playheadX >= 0 && (
                        <div
                            className="absolute top-0 bottom-0 w-px daw-playhead pointer-events-none z-20"
                            style={{ left: playheadX, background: "var(--daw-green)" }}
                        >
                            <div
                                className="w-3 h-3 rounded-b-sm -ml-[5px]"
                                style={{ background: "var(--daw-green)" }}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Tracks */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden" style={{ marginTop: 0 }}>
                {daw.project.tracks.map((track, idx) => (
                    <div key={track.id} className="flex" style={{ height: track.height }}>
                        <TrackHeader track={track} index={idx} />

                        <div
                            className="flex-1 relative border-b border-[var(--daw-border)] overflow-hidden"
                            style={{ background: `linear-gradient(90deg, ${track.color}06 0%, transparent 100%)` }}
                            onDoubleClick={e => handleTrackDoubleClick(e, track)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={e => handleTrackDrop(e, track)}
                        >
                            <GridLines scrollX={daw.scrollX} pxPerBeat={pxPerBeat} height={track.height} timeSignature={daw.project.timeSignature} />

                            {track.clips.map(clip => (
                                <ClipBlock
                                    key={clip.id}
                                    clip={clip}
                                    track={track}
                                    scrollX={daw.scrollX}
                                    pxPerBeat={pxPerBeat}
                                    height={track.height}
                                    selected={daw.selectedClipId === clip.id}
                                    onMouseDown={e => handleClipMouseDown(e, clip)}
                                    onContextMenu={e => handleClipRightClick(e, clip)}
                                    onDoubleClick={() => {
                                        if (clip.type === "midi") daw.openPianoRoll(track.id, clip.id);
                                    }}
                                />
                            ))}

                            {playheadX >= 0 && (
                                <div
                                    className="absolute top-0 bottom-0 w-px pointer-events-none z-10 opacity-50"
                                    style={{ left: playheadX, background: "var(--daw-green)" }}
                                />
                            )}
                        </div>
                    </div>
                ))}

                <div className="h-32" />
            </div>
        </div>
    );
}

// ─── Track Header ────────────────────────────────────────────────────────

function TrackHeader({ track, index }: { track: DAWTrack; index: number }) {
    const daw = useDAW();
    const isSelected = daw.selectedTrackId === track.id;
    const TypeIcon = track.type === "midi" ? Piano : track.type === "return" ? Headphones : Music;

    return (
        <div
            className={cn(
                "flex-shrink-0 border-r border-b border-[var(--daw-border)] flex flex-col justify-center px-2.5 py-1.5 cursor-pointer transition-all duration-150",
                isSelected
                    ? "bg-[var(--daw-surface-2)] shadow-[inset_3px_0_0_var(--daw-accent)]"
                    : "bg-[var(--daw-surface)] hover:bg-[var(--daw-surface-2)]"
            )}
            style={{ width: HEADER_WIDTH }}
            onClick={() => daw.selectTrack(track.id)}
        >
            {/* Track name row */}
            <div className="flex items-center gap-1.5 mb-1.5">
                <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/10"
                    style={{ background: track.color }}
                />
                <TypeIcon className="h-3 w-3 text-[var(--daw-text-dim)] flex-shrink-0" />
                <span className="text-[11px] text-[var(--daw-text)] truncate flex-1 font-medium">{track.name}</span>
                <span className="text-[8px] text-[var(--daw-text-dim)] uppercase tracking-wider opacity-60">{track.type}</span>
            </div>

            {/* Controls row */}
            <div className="flex items-center gap-1">
                <TrackButton
                    label="M"
                    active={track.muted}
                    color="red"
                    onClick={e => { e.stopPropagation(); daw.toggleTrackMute(track.id); }}
                />
                <TrackButton
                    label="S"
                    active={track.soloed}
                    color="amber"
                    onClick={e => { e.stopPropagation(); daw.toggleTrackSolo(track.id); }}
                />
                {track.type === "audio" && (
                    <button
                        onClick={e => { e.stopPropagation(); daw.toggleTrackArm(track.id); }}
                        className={cn(
                            "h-4 w-4 rounded flex items-center justify-center transition-colors",
                            track.armed
                                ? "bg-[oklch(0.63_0.24_25/0.2)] text-[var(--daw-red)]"
                                : "text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
                        )}
                    >
                        <Circle className="h-2 w-2" fill={track.armed ? "currentColor" : "none"} />
                    </button>
                )}

                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={track.volume}
                    onChange={e => { e.stopPropagation(); daw.setTrackVolume(track.id, Number(e.target.value)); }}
                    onClick={e => e.stopPropagation()}
                    className="daw-slider daw-slider-accent flex-1 min-w-0"
                />

                <button
                    onClick={e => { e.stopPropagation(); daw.removeTrack(track.id); }}
                    className="h-4 w-4 flex items-center justify-center text-[var(--daw-text-dim)] hover:text-[var(--daw-red)] transition-colors rounded"
                >
                    <Trash2 className="h-2.5 w-2.5" />
                </button>
            </div>
        </div>
    );
}

function TrackButton({ label, active, color, onClick }: {
    label: string;
    active: boolean;
    color: "red" | "amber";
    onClick: (e: React.MouseEvent) => void;
}) {
    const colors = {
        red: { bg: "oklch(0.63_0.24_25/0.2)", text: "var(--daw-red)" },
        amber: { bg: "oklch(0.78_0.18_84/0.2)", text: "var(--daw-amber)" },
    };
    const c = colors[color];

    return (
        <button
            onClick={onClick}
            className={cn(
                "h-4 min-w-[16px] px-0.5 rounded text-[8px] font-bold transition-all",
                active
                    ? `bg-[${c.bg}] text-[${c.text}]`
                    : "text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
            )}
            style={active ? { background: c.bg, color: c.text } : {}}
        >
            {label}
        </button>
    );
}

// ─── Clip Block ──────────────────────────────────────────────────────────

function ClipBlock({ clip, track, scrollX, pxPerBeat, height, selected, onMouseDown, onContextMenu, onDoubleClick }: {
    clip: Clip;
    track: DAWTrack;
    scrollX: number;
    pxPerBeat: number;
    height: number;
    selected: boolean;
    onMouseDown: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
}) {
    const left = (clip.position - scrollX) * pxPerBeat;
    const width = clip.length * pxPerBeat;

    if (left + width < 0 || left > 2000) return null;

    return (
        <div
            className={cn(
                "absolute top-1 rounded-md overflow-hidden cursor-pointer group transition-shadow duration-150",
                selected
                    ? "ring-1 ring-[var(--daw-accent)] shadow-[0_0_12px_var(--daw-accent-glow)]"
                    : "ring-1 ring-white/[0.06] hover:ring-white/15",
                clip.muted && "opacity-35"
            )}
            style={{
                left: Math.max(0, left),
                width: Math.max(4, width - (left < 0 ? -left : 0)),
                height: height - 10,
                background: `linear-gradient(180deg, ${clip.color}30 0%, ${clip.color}12 100%)`,
                borderLeft: `2px solid ${clip.color}90`,
            }}
            onMouseDown={onMouseDown}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
        >
            {/* Clip header */}
            <div className="h-4 px-1.5 flex items-center bg-black/15">
                <span className="text-[9px] text-white/60 truncate font-medium">{clip.name}</span>
            </div>

            {/* Clip content */}
            <div className="flex-1 relative overflow-hidden">
                {clip.type === "audio" && clip.audio?.waveformPeaks && (
                    <WaveformPreview peaks={clip.audio.waveformPeaks} color={clip.color} />
                )}
                {clip.type === "midi" && clip.midi && (
                    <MidiPreview notes={clip.midi.notes} length={clip.length} color={clip.color} />
                )}
            </div>

            {/* Resize handle */}
            <div className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/10 transition-opacity" />
        </div>
    );
}

// ─── Previews ────────────────────────────────────────────────────────────

function WaveformPreview({ peaks, color }: { peaks: Float32Array; color: string }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = color + "70";
        const step = peaks.length / w;
        for (let i = 0; i < w; i++) {
            const idx = Math.floor(i * step);
            const amp = peaks[idx] * h * 0.4;
            ctx.fillRect(i, h / 2 - amp, 1, amp * 2);
        }
    }, [peaks, color]);

    return <canvas ref={canvasRef} className="w-full h-full" width={200} height={40} />;
}

function MidiPreview({ notes, length, color }: { notes: { pitch: number; start: number; duration: number }[]; length: number; color: string }) {
    if (notes.length === 0) return null;

    const minPitch = Math.min(...notes.map(n => n.pitch));
    const maxPitch = Math.max(...notes.map(n => n.pitch));
    const range = Math.max(1, maxPitch - minPitch);

    return (
        <div className="w-full h-full relative">
            {notes.map((note, i) => (
                <div
                    key={i}
                    className="absolute rounded-sm"
                    style={{
                        left: `${(note.start / length) * 100}%`,
                        width: `${(note.duration / length) * 100}%`,
                        bottom: `${((note.pitch - minPitch) / range) * 80 + 5}%`,
                        height: `${Math.max(2, (1 / range) * 60)}%`,
                        background: color,
                        opacity: 0.7,
                    }}
                />
            ))}
        </div>
    );
}

// ─── Grid Lines ──────────────────────────────────────────────────────────

function GridLines({ scrollX, pxPerBeat, height, timeSignature }: {
    scrollX: number; pxPerBeat: number; height: number; timeSignature: { numerator: number; denominator: number };
}) {
    const lines: { x: number; isBeat: boolean; isBar: boolean }[] = [];
    const beatsPerBar = timeSignature.numerator;
    const startBeat = Math.floor(scrollX);
    const visibleBeats = Math.ceil(2000 / pxPerBeat) + 2;

    for (let b = startBeat; b < startBeat + visibleBeats; b++) {
        const x = (b - scrollX) * pxPerBeat;
        lines.push({ x, isBeat: b % 1 === 0, isBar: b % beatsPerBar === 0 });
    }

    return (
        <>
            {lines.map((l, i) => (
                <div
                    key={i}
                    className={cn(
                        "absolute top-0 bottom-0 pointer-events-none",
                        l.isBar ? "w-px bg-[oklch(1_0_0/8%)]" : l.isBeat ? "w-px bg-[oklch(1_0_0/4%)]" : ""
                    )}
                    style={{ left: l.x }}
                />
            ))}
        </>
    );
}

// ─── Ruler ───────────────────────────────────────────────────────────────

function RulerCanvas({ scrollX, pxPerBeat, totalBeats, timeSignature, loopRegion }: {
    scrollX: number;
    pxPerBeat: number;
    totalBeats: number;
    timeSignature: { numerator: number; denominator: number };
    loopRegion: { start: number; end: number; enabled: boolean };
}) {
    const beatsPerBar = timeSignature.numerator;
    const startBeat = Math.floor(scrollX);
    const visibleBeats = Math.ceil(2000 / pxPerBeat) + 2;

    return (
        <div className="relative h-full">
            {loopRegion.enabled && (
                <div
                    className="absolute top-0 bottom-0 border-x"
                    style={{
                        left: (loopRegion.start - scrollX) * pxPerBeat,
                        width: (loopRegion.end - loopRegion.start) * pxPerBeat,
                        background: "oklch(0.62 0.19 250 / 0.1)",
                        borderColor: "oklch(0.62 0.19 250 / 0.25)",
                    }}
                />
            )}

            {Array.from({ length: visibleBeats }).map((_, i) => {
                const beat = startBeat + i;
                if (beat < 0) return null;
                const x = (beat - scrollX) * pxPerBeat;
                const isBar = beat % beatsPerBar === 0;
                const barNum = Math.floor(beat / beatsPerBar) + 1;

                return (
                    <div key={beat} className="absolute top-0 bottom-0" style={{ left: x }}>
                        <div className={cn("w-px h-full", isBar ? "bg-[oklch(1_0_0/10%)]" : "bg-[oklch(1_0_0/4%)]")} />
                        {isBar && (
                            <span className="absolute top-1.5 left-1.5 text-[9px] text-[var(--daw-text-dim)] font-mono tabular-nums">
                                {barNum}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
