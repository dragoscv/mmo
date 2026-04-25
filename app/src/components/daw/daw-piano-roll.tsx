"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { useDAW } from "./daw-context";
import { cn } from "@/lib/utils";
import type { MidiNote } from "@/lib/daw-engine";
import { useContextMenu, type MenuEntry } from "./daw-context-menu";
import { Trash2, Copy, Magnet, Music } from "lucide-react";
import { formatNoteMulti, formatPitchMulti, ANGLO_NAMES } from "@/lib/note-notation";
import { useDAWSettings } from "@/hooks/use-daw-settings";
import { useRenderCount } from "@/lib/dev-debugger";

const NOTE_NAMES = ANGLO_NAMES;
const MIN_PITCH = 24; // C1
const MAX_PITCH = 108; // C8
const KEY_WIDTH = 48;
const NOTE_HEIGHT = 12;
const VELOCITY_HEIGHT = 60;

function isBlackKey(pitch: number) {
    return [1, 3, 6, 8, 10].includes(pitch % 12);
}

export function DAWPianoRoll() {
    useRenderCount("DAWPianoRoll");
    const daw = useDAW();
    const { noteNotations } = useDAWSettings();
    const gridRef = useRef<HTMLDivElement>(null);
    const [drawing, setDrawing] = useState(false);
    const [drawingNote, setDrawingNote] = useState<{ pitch: number; start: number } | null>(null);

    const noteName = useCallback((pitch: number) =>
        formatPitchMulti(pitch, noteNotations), [noteNotations]);

    const { pianoRollTrackId, pianoRollClipId } = daw;
    const track = daw.project.tracks.find(t => t.id === pianoRollTrackId);
    const clip = track?.clips.find(c => c.id === pianoRollClipId);
    const notes = clip?.midi?.notes ?? [];

    const pxPerBeat = daw.zoom * 2; // Higher zoom for piano roll
    const selectedNoteIds = daw.selectedNotes;

    if (!clip || !track) {
        return (
            <div className="h-full flex items-center justify-center text-white/20 text-sm">
                Double-click a MIDI clip to open the piano roll
            </div>
        );
    }

    const totalPitches = MAX_PITCH - MIN_PITCH;
    const gridHeight = totalPitches * NOTE_HEIGHT;

    const snapBeat = (beat: number) => {
        const grid: Record<string, number> = {
            "1/1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125, "none": 0,
        };
        const snap = grid[daw.snap] ?? 0.25;
        if (snap === 0) return beat;
        return Math.round(beat / snap) * snap;
    };

    const pitchFromY = (y: number) => MAX_PITCH - Math.floor(y / NOTE_HEIGHT) - 1;
    const beatFromX = (x: number) => x / pxPerBeat;
    const yFromPitch = (pitch: number) => (MAX_PITCH - pitch - 1) * NOTE_HEIGHT;

    const handleGridMouseDown = (e: React.PointerEvent) => {
        if (!gridRef.current) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const rect = gridRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left + gridRef.current.scrollLeft;
        const y = e.clientY - rect.top + gridRef.current.scrollTop;
        const pitch = pitchFromY(y);
        const beat = snapBeat(beatFromX(x));

        if (daw.tool === "draw" || daw.tool === "select") {
            // Check if clicking on existing note
            const existing = notes.find(n => n.pitch === pitch && beat >= n.start && beat < n.start + n.duration);
            if (existing) {
                if (daw.tool === "select") {
                    daw.selectNotes([existing.id]);
                }
                return;
            }

            // Draw new note
            if (daw.tool === "draw") {
                setDrawing(true);
                setDrawingNote({ pitch, start: beat });
            }
        } else if (daw.tool === "erase") {
            const toErase = notes.find(n => n.pitch === pitch && beat >= n.start && beat < n.start + n.duration);
            if (toErase) {
                daw.removeNote(clip.id, toErase.id);
            }
        }
    };

    const handleGridMouseUp = (e: React.PointerEvent) => {
        if (drawing && drawingNote) {
            if (!gridRef.current) return;
            const rect = gridRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left + gridRef.current.scrollLeft;
            const endBeat = snapBeat(beatFromX(x));
            const duration = Math.max(0.25, endBeat - drawingNote.start);
            daw.addNote(clip.id, { pitch: drawingNote.pitch, start: drawingNote.start, duration, velocity: 100, channel: 0 });
        }
        setDrawing(false);
        setDrawingNote(null);
    };

    // Preview synth note on key click
    const handleKeyClick = (pitch: number) => {
        const noteId = daw.playSynthNote(pitch, 100);
        setTimeout(() => daw.stopSynthNote(noteId), 300);
    };

    const ctxMenu = useContextMenu();

    const handleGridContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        if (!gridRef.current || !clip) return;
        const rect = gridRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left + gridRef.current.scrollLeft;
        const y = e.clientY - rect.top + gridRef.current.scrollTop;
        const pitch = pitchFromY(y);
        const beat = snapBeat(beatFromX(x));

        // Check if right-clicking on a note
        const clickedNote = notes.find(n => n.pitch === pitch && beat >= n.start && beat < n.start + n.duration);

        if (clickedNote) {
            const items: MenuEntry[] = [
                { type: "label", label: `${noteName(clickedNote.pitch)} — vel ${clickedNote.velocity}` },
                { type: "separator" },
                {
                    type: "sub",
                    label: "Set Velocity",
                    icon: <Music className="h-3.5 w-3.5" />,
                    items: [
                        { label: "Piano (pp) — 32", onClick: () => daw.setNoteVelocity(clip.id, clickedNote.id, 32) },
                        { label: "Mezzo (mf) — 80", onClick: () => daw.setNoteVelocity(clip.id, clickedNote.id, 80) },
                        { label: "Forte (f) — 100", onClick: () => daw.setNoteVelocity(clip.id, clickedNote.id, 100) },
                        { label: "Fortissimo (ff) — 127", onClick: () => daw.setNoteVelocity(clip.id, clickedNote.id, 127) },
                    ],
                },
                { type: "separator" },
                {
                    label: "Delete Note",
                    icon: <Trash2 className="h-3.5 w-3.5" />,
                    destructive: true,
                    onClick: () => daw.removeNote(clip.id, clickedNote.id),
                },
            ];
            ctxMenu.show(e.clientX, e.clientY, items);
        } else {
            const items: MenuEntry[] = [
                { type: "label", label: `${noteName(pitch)} — Beat ${beat.toFixed(1)}` },
                { type: "separator" },
                { label: "Add Note Here", onClick: () => daw.addNote(clip.id, { pitch, start: beat, duration: 1, velocity: 100, channel: 0 }) },
                { type: "separator" },
                { label: "Select All Notes", shortcut: "Ctrl+A", onClick: () => daw.selectNotes(notes.map(n => n.id)) },
            ];
            ctxMenu.show(e.clientX, e.clientY, items);
        }
    }, [daw, clip, notes, ctxMenu]);

    return (
        <div className="h-full flex flex-col bg-[var(--daw-bg)]">
            {/* Clip info bar */}
            <div className="h-6 flex items-center gap-2 px-2 border-b border-[var(--daw-border)] bg-[var(--daw-surface)] flex-shrink-0">
                <div className="w-2 h-2 rounded-full" style={{ background: track.color }} />
                <span className="text-[10px] text-white/60">{track.name}</span>
                <span className="text-[10px] text-white/30">→</span>
                <span className="text-[10px] text-white/60">{clip.name}</span>
                <span className="text-[9px] text-white/20 ml-auto font-mono">{notes.length} notes</span>
            </div>

            {/* Main area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Piano keys */}
                <div className="flex-shrink-0 overflow-y-auto" style={{ width: KEY_WIDTH }}>
                    <div style={{ height: gridHeight }}>
                        {Array.from({ length: totalPitches }).map((_, i) => {
                            const pitch = MAX_PITCH - i - 1;
                            const black = isBlackKey(pitch);
                            const isC = pitch % 12 === 0;
                            return (
                                <div
                                    key={pitch}
                                    className={cn(
                                        "flex items-center justify-end pr-1 border-b cursor-pointer transition-colors",
                                        black
                                            ? "bg-[var(--daw-surface)] border-[var(--daw-border)] hover:bg-[var(--daw-surface-2)]"
                                            : "bg-[#22223a] border-white/5 hover:bg-white/15",
                                        isC && "border-b-white/15"
                                    )}
                                    style={{ height: NOTE_HEIGHT }}
                                    onClick={() => handleKeyClick(pitch)}
                                >
                                    {isC && <span className="text-[8px] text-white/30 font-mono">{noteName(pitch)}</span>}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Note grid */}
                <div
                    ref={gridRef}
                    className="flex-1 overflow-auto relative"
                    style={{ touchAction: drawing ? "none" : "pan-x pan-y" }}
                    onPointerDown={handleGridMouseDown}
                    onPointerUp={handleGridMouseUp}
                    onPointerCancel={handleGridMouseUp}
                    onContextMenu={handleGridContextMenu}
                >
                    <div className="relative" style={{ width: clip.length * pxPerBeat, height: gridHeight, minWidth: "100%" }}>
                        {/* Grid lines */}
                        {Array.from({ length: totalPitches }).map((_, i) => {
                            const pitch = MAX_PITCH - i - 1;
                            const black = isBlackKey(pitch);
                            const isC = pitch % 12 === 0;
                            return (
                                <div
                                    key={pitch}
                                    className={cn(
                                        "absolute w-full border-b",
                                        black ? "bg-white/[0.02]" : "",
                                        isC ? "border-white/10" : "border-white/[0.03]"
                                    )}
                                    style={{ top: i * NOTE_HEIGHT, height: NOTE_HEIGHT }}
                                />
                            );
                        })}

                        {/* Beat grid lines */}
                        {Array.from({ length: Math.ceil(clip.length) + 1 }).map((_, b) => (
                            <div
                                key={b}
                                className={cn(
                                    "absolute top-0 bottom-0 w-px pointer-events-none",
                                    b % daw.project.timeSignature.numerator === 0 ? "bg-white/10" : "bg-white/[0.04]"
                                )}
                                style={{ left: b * pxPerBeat }}
                            />
                        ))}

                        {/* Notes */}
                        {notes.map(note => (
                            <NoteBlock
                                key={note.id}
                                note={note}
                                pxPerBeat={pxPerBeat}
                                yFromPitch={yFromPitch}
                                color={clip.color}
                                selected={selectedNoteIds.has(note.id)}
                                onSelect={() => daw.selectNotes([note.id])}
                                onDelete={() => daw.removeNote(clip.id, note.id)}
                                tool={daw.tool}
                            />
                        ))}

                        {/* Drawing preview */}
                        {drawing && drawingNote && (
                            <div
                                className="absolute rounded-sm border border-white/40 bg-purple-500/30 pointer-events-none"
                                style={{
                                    left: drawingNote.start * pxPerBeat,
                                    top: yFromPitch(drawingNote.pitch),
                                    width: Math.max(0.25, 1) * pxPerBeat,
                                    height: NOTE_HEIGHT - 1,
                                }}
                            />
                        )}

                        {/* Playhead */}
                        {daw.isPlaying && (
                            <div
                                className="absolute top-0 bottom-0 w-px bg-green-400/50 pointer-events-none z-10"
                                style={{ left: (daw.currentBeat - clip.position) * pxPerBeat }}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Velocity editor */}
            <div className="flex-shrink-0 border-t border-white/10" style={{ height: VELOCITY_HEIGHT }}>
                <div className="flex h-full">
                    <div className="flex-shrink-0 flex items-center justify-center border-r border-white/10" style={{ width: KEY_WIDTH }}>
                        <span className="text-[9px] text-white/30 uppercase">Vel</span>
                    </div>
                    <div className="flex-1 relative overflow-hidden">
                        {notes.map(note => {
                            const x = note.start * pxPerBeat;
                            const h = (note.velocity / 127) * (VELOCITY_HEIGHT - 4);
                            return (
                                <div
                                    key={note.id}
                                    className="absolute bottom-0 cursor-pointer hover:opacity-80"
                                    style={{
                                        left: x,
                                        width: Math.max(3, note.duration * pxPerBeat - 1),
                                        height: h,
                                        background: clip.color,
                                        opacity: 0.6,
                                    }}
                                    onClick={() => {
                                        const newVel = Math.round(Math.random() * 127); // In a real DAW, this would be drag
                                        daw.setNoteVelocity(clip.id, note.id, newVel);
                                    }}
                                />
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );
}

function NoteBlock({ note, pxPerBeat, yFromPitch, color, selected, onSelect, onDelete, tool }: {
    note: MidiNote;
    pxPerBeat: number;
    yFromPitch: (p: number) => number;
    color: string;
    selected: boolean;
    onSelect: () => void;
    onDelete: () => void;
    tool: string;
}) {
    return (
        <div
            className={cn(
                "absolute rounded-sm cursor-pointer group transition-shadow",
                selected ? "ring-1 ring-white/60 z-10" : "hover:brightness-125"
            )}
            style={{
                left: note.start * pxPerBeat,
                top: yFromPitch(note.pitch),
                width: Math.max(4, note.duration * pxPerBeat - 1),
                height: NOTE_HEIGHT - 1,
                background: color,
                opacity: note.velocity / 127 * 0.6 + 0.4,
                touchAction: "none",
            }}
            onPointerDown={e => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                e.stopPropagation();
                if (tool === "erase") {
                    onDelete();
                } else {
                    onSelect();
                }
            }}
        >
            {/* Resize handle */}
            <div className="absolute right-0 top-0 bottom-0 w-1 cursor-ew-resize opacity-0 group-hover:opacity-100 bg-white/30" />
        </div>
    );
}
