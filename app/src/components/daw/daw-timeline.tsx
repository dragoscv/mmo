"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { useDAW } from "./daw-context";
import {
    Volume2, VolumeX, Headphones, Circle, Trash2, Plus, Piano, Music,
    Copy, Scissors, Palette, EyeOff, Snowflake, ArrowUp, ArrowDown,
    Volume1, AudioWaveform,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DAWTrack, Clip } from "@/lib/daw-engine";
import { useContextMenu, colorMenuItems, type MenuEntry } from "./daw-context-menu";
import { InlineEditName, useScrollAdjust } from "./daw-ui-utils";

const HEADER_WIDTH = 200;
const RULER_HEIGHT = 30;
const MIN_CLIP_LENGTH = 0.25;

// ═══════════════════════════════════════════════════════════════════════════
// Drag state types
// ═══════════════════════════════════════════════════════════════════════════

type DragMode =
    | { type: "move"; clipId: string; trackId: string; startX: number; startY: number; startPos: number; startTrackIdx: number }
    | { type: "resize-right"; clipId: string; trackId: string; startX: number; startLen: number }
    | { type: "resize-left"; clipId: string; trackId: string; startX: number; startPos: number; startLen: number }
    | { type: "draw"; trackId: string; startBeat: number; currentBeat: number }
    | { type: "fade-in"; clipId: string; trackId: string; startX: number; startFade: number; maxFade: number }
    | { type: "fade-out"; clipId: string; trackId: string; startX: number; startFade: number; maxFade: number }
    | null;

export function DAWTimeline() {
    const daw = useDAW();
    const ctxMenu = useContextMenu();
    const containerRef = useRef<HTMLDivElement>(null);
    const trackAreaRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<DragMode>(null);

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

    // ─── Utility: get track index from Y position ───────────────────
    const getTrackAtY = useCallback((clientY: number): { track: DAWTrack; index: number } | null => {
        const area = trackAreaRef.current;
        if (!area) return null;
        const areaRect = area.getBoundingClientRect();
        let y = clientY - areaRect.top + area.scrollTop;
        for (let i = 0; i < daw.project.tracks.length; i++) {
            const t = daw.project.tracks[i];
            if (y < t.height) return { track: t, index: i };
            y -= t.height;
        }
        return null;
    }, [daw.project.tracks]);

    // ─── Ruler handlers ─────────────────────────────────────────────
    const handleRulerClick = useCallback((e: React.MouseEvent) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);
        daw.seek(beat);
    }, [daw, pxPerBeat, snapToBeat]);

    const handleRulerContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);

        const items: MenuEntry[] = [
            { type: "label", label: `Beat ${beat.toFixed(1)}` },
            { type: "separator" },
            { label: "Set Playhead Here", onClick: () => daw.seek(beat) },
            { label: daw.project.loopRegion.enabled ? "Disable Loop" : "Enable Loop", onClick: () => daw.toggleLoop() },
            { type: "separator" },
            { label: "Add Audio Track", icon: <Music className="h-3.5 w-3.5" />, shortcut: "Ctrl+Shift+T", onClick: () => daw.addTrack("audio") },
            { label: "Add MIDI Track", icon: <Piano className="h-3.5 w-3.5" />, shortcut: "Ctrl+Shift+I", onClick: () => daw.addTrack("midi") },
        ];

        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, pxPerBeat, snapToBeat, ctxMenu]);

    // ─── Wheel (zoom + scroll) ──────────────────────────────────────
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

    // ─── Clip mousedown (select, start move, or tool action) ────────
    const handleClipMouseDown = useCallback((e: React.MouseEvent, clip: Clip, track: DAWTrack) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        daw.selectClip(clip.id);

        if (daw.tool === "select") {
            const trackIdx = daw.project.tracks.findIndex(t => t.id === track.id);
            setDrag({
                type: "move",
                clipId: clip.id,
                trackId: track.id,
                startX: e.clientX,
                startY: e.clientY,
                startPos: clip.position,
                startTrackIdx: trackIdx,
            });
        } else if (daw.tool === "erase") {
            daw.removeClip(clip.id);
        } else if (daw.tool === "slice") {
            const rect = e.currentTarget.parentElement?.getBoundingClientRect();
            if (rect) {
                const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
                const beat = snapToBeat(x / pxPerBeat);
                daw.splitClip(clip.id, beat);
            }
        } else if (daw.tool === "mute") {
            daw.muteClip(clip.id);
        }
    }, [daw, pxPerBeat, snapToBeat]);

    // ─── Resize handles ─────────────────────────────────────────────
    const handleResizeRightStart = useCallback((e: React.MouseEvent, clip: Clip) => {
        e.stopPropagation();
        e.preventDefault();
        setDrag({
            type: "resize-right",
            clipId: clip.id,
            trackId: clip.trackId,
            startX: e.clientX,
            startLen: clip.length,
        });
    }, []);

    const handleResizeLeftStart = useCallback((e: React.MouseEvent, clip: Clip) => {
        e.stopPropagation();
        e.preventDefault();
        setDrag({
            type: "resize-left",
            clipId: clip.id,
            trackId: clip.trackId,
            startX: e.clientX,
            startPos: clip.position,
            startLen: clip.length,
        });
    }, []);

    // ─── Fade handles ───────────────────────────────────────────────
    const handleFadeInStart = useCallback((e: React.MouseEvent, clip: Clip) => {
        e.stopPropagation();
        e.preventDefault();
        setDrag({
            type: "fade-in",
            clipId: clip.id,
            trackId: clip.trackId,
            startX: e.clientX,
            startFade: clip.audio?.fadeIn ?? 0,
            maxFade: clip.length * 0.5,
        });
    }, []);

    const handleFadeOutStart = useCallback((e: React.MouseEvent, clip: Clip) => {
        e.stopPropagation();
        e.preventDefault();
        setDrag({
            type: "fade-out",
            clipId: clip.id,
            trackId: clip.trackId,
            startX: e.clientX,
            startFade: clip.audio?.fadeOut ?? 0,
            maxFade: clip.length * 0.5,
        });
    }, []);

    // ─── Track area click (draw tool) ───────────────────────────────
    const handleTrackMouseDown = useCallback((e: React.MouseEvent, track: DAWTrack) => {
        if (e.button !== 0) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);

        if (daw.tool === "draw") {
            e.stopPropagation();
            setDrag({
                type: "draw",
                trackId: track.id,
                startBeat: beat,
                currentBeat: beat,
            });
        }
    }, [daw, pxPerBeat, snapToBeat]);

    // ─── Double-click to create clip ────────────────────────────────
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

    // ─── Global mousemove ───────────────────────────────────────────
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!drag) return;

        if (drag.type === "move") {
            const dx = e.clientX - drag.startX;
            const dBeats = dx / pxPerBeat;
            const newPos = snapToBeat(Math.max(0, drag.startPos + dBeats));

            // Cross-track detection
            const targetInfo = getTrackAtY(e.clientY);
            const targetTrackId = targetInfo ? targetInfo.track.id : drag.trackId;

            daw.moveClip(drag.clipId, targetTrackId, newPos);
        } else if (drag.type === "resize-right") {
            const dx = e.clientX - drag.startX;
            const dBeats = dx / pxPerBeat;
            const newLen = Math.max(MIN_CLIP_LENGTH, snapToBeat(drag.startLen + dBeats) || MIN_CLIP_LENGTH);
            daw.resizeClip(drag.clipId, newLen);
        } else if (drag.type === "resize-left") {
            const dx = e.clientX - drag.startX;
            const dBeats = dx / pxPerBeat;
            const newPos = snapToBeat(Math.max(0, drag.startPos + dBeats));
            const delta = newPos - drag.startPos;
            const newLen = Math.max(MIN_CLIP_LENGTH, drag.startLen - delta);
            if (newLen >= MIN_CLIP_LENGTH) {
                daw.moveClip(drag.clipId, drag.trackId, newPos);
                daw.resizeClip(drag.clipId, newLen);
            }
        } else if (drag.type === "draw") {
            const area = trackAreaRef.current;
            if (!area) return;
            // Get the track lane element
            const trackLanes = area.querySelectorAll("[data-track-lane]");
            for (const lane of trackLanes) {
                if ((lane as HTMLElement).dataset.trackLane === drag.trackId) {
                    const rect = lane.getBoundingClientRect();
                    const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
                    const beat = snapToBeat(x / pxPerBeat);
                    setDrag(prev => prev?.type === "draw" ? { ...prev, currentBeat: beat } : prev);
                    break;
                }
            }
        } else if (drag.type === "fade-in") {
            const dx = e.clientX - drag.startX;
            const dBeats = dx / pxPerBeat;
            const newFade = Math.max(0, Math.min(drag.maxFade, drag.startFade + dBeats));
            // Find clip to get current fadeOut
            const found = daw.project.tracks.flatMap(t => t.clips).find(c => c.id === drag.clipId);
            daw.setClipFade(drag.clipId, newFade, found?.audio?.fadeOut ?? 0);
        } else if (drag.type === "fade-out") {
            const dx = -(e.clientX - drag.startX);
            const dBeats = dx / pxPerBeat;
            const newFade = Math.max(0, Math.min(drag.maxFade, drag.startFade + dBeats));
            // Find clip to get current fadeIn
            const found = daw.project.tracks.flatMap(t => t.clips).find(c => c.id === drag.clipId);
            daw.setClipFade(drag.clipId, found?.audio?.fadeIn ?? 0, newFade);
        }
    }, [drag, pxPerBeat, snapToBeat, daw, getTrackAtY]);

    // ─── Global mouseup ─────────────────────────────────────────────
    const handleMouseUp = useCallback(() => {
        if (drag?.type === "draw") {
            // Create clip from draw
            const start = Math.min(drag.startBeat, drag.currentBeat);
            const end = Math.max(drag.startBeat, drag.currentBeat);
            const len = end - start;
            if (len >= MIN_CLIP_LENGTH) {
                const track = daw.project.tracks.find(t => t.id === drag.trackId);
                if (track) {
                    const clipType = track.type === "midi" ? "midi" : "audio";
                    daw.addClip(drag.trackId, clipType as "audio" | "midi", start, len, `Clip ${track.clips.length + 1}`);
                }
            }
        }
        setDrag(null);
    }, [drag, daw]);

    // ─── Clip right-click context menu ──────────────────────────────
    const handleClipRightClick = useCallback((e: React.MouseEvent, clip: Clip, track: DAWTrack) => {
        e.preventDefault();
        daw.selectClip(clip.id);

        const items: MenuEntry[] = [
            { type: "label", label: clip.name },
            { type: "separator" },
            {
                label: "Duplicate Clip",
                icon: <Copy className="h-3.5 w-3.5" />,
                shortcut: "Ctrl+D",
                onClick: () => daw.duplicateClip(clip.id),
            },
            {
                label: "Split at Playhead",
                icon: <Scissors className="h-3.5 w-3.5" />,
                onClick: () => daw.splitClip(clip.id, daw.currentBeat),
            },
            {
                label: clip.muted ? "Unmute Clip" : "Mute Clip",
                icon: <EyeOff className="h-3.5 w-3.5" />,
                onClick: () => daw.muteClip(clip.id),
            },
            { type: "separator" },
            ...(clip.type === "audio" ? [{
                label: "Edit in Sound Editor",
                icon: <AudioWaveform className="h-3.5 w-3.5" />,
                onClick: () => {
                    const url = `/editor?clip=${clip.id}&track=${track.id}`;
                    window.open(url, "_blank");
                },
            }] as MenuEntry[] : []),
            ...(clip.type === "midi" ? [{
                label: "Open in Piano Roll",
                icon: <Piano className="h-3.5 w-3.5" />,
                onClick: () => daw.openPianoRoll(track.id, clip.id),
            }] as MenuEntry[] : []),
            { type: "separator" as const },
            {
                type: "sub" as const,
                label: "Set Color",
                icon: <Palette className="h-3.5 w-3.5" />,
                items: colorMenuItems(clip.color, c => daw.setClipColor(clip.id, c)),
            },
            { type: "separator" as const },
            {
                label: "Delete Clip",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                shortcut: "Del",
                destructive: true,
                onClick: () => daw.removeClip(clip.id),
            },
        ];

        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, ctxMenu]);

    // ─── File drop ──────────────────────────────────────────────────
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

    // ─── Draw preview rectangle ─────────────────────────────────────
    const drawPreview = drag?.type === "draw" ? {
        left: Math.min(drag.startBeat, drag.currentBeat),
        width: Math.abs(drag.currentBeat - drag.startBeat),
        trackId: drag.trackId,
    } : null;

    // ─── Cursor based on active tool ────────────────────────────────
    const toolCursor: Record<string, string> = {
        select: "default",
        draw: "crosshair",
        erase: "pointer",
        slice: "col-resize",
        mute: "pointer",
        automation: "default",
    };

    const playheadX = (daw.currentBeat - daw.scrollX) * pxPerBeat;

    return (
        <div
            ref={containerRef}
            className="h-full flex flex-col bg-[var(--daw-bg)] overflow-hidden"
            style={{ cursor: toolCursor[daw.tool] ?? "default" }}
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
                    onContextMenu={handleRulerContextMenu}
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
            <div ref={trackAreaRef} className="flex-1 overflow-y-auto overflow-x-hidden" style={{ marginTop: 0 }}>
                {daw.project.tracks.map((track, idx) => (
                    <div key={track.id} className="flex" style={{ height: track.height }}>
                        <TrackHeader track={track} index={idx} />

                        <div
                            data-track-lane={track.id}
                            className="flex-1 relative border-b border-[var(--daw-border)] overflow-hidden"
                            style={{ background: `linear-gradient(90deg, ${track.color}06 0%, transparent 100%)` }}
                            onMouseDown={e => handleTrackMouseDown(e, track)}
                            onDoubleClick={e => handleTrackDoubleClick(e, track)}
                            onDragOver={e => e.preventDefault()}
                            onDrop={e => handleTrackDrop(e, track)}
                        >
                            <GridLines scrollX={daw.scrollX} pxPerBeat={pxPerBeat} height={track.height} timeSignature={daw.project.timeSignature} />

                            {/* Draw preview ghost */}
                            {drawPreview && drawPreview.trackId === track.id && drawPreview.width > 0 && (
                                <div
                                    className="absolute top-1 rounded-md border border-dashed border-[var(--daw-accent)] bg-[var(--daw-accent)]/10 pointer-events-none z-10"
                                    style={{
                                        left: (drawPreview.left - daw.scrollX) * pxPerBeat,
                                        width: drawPreview.width * pxPerBeat,
                                        height: track.height - 10,
                                    }}
                                />
                            )}

                            {track.clips.map(clip => (
                                <ClipBlock
                                    key={clip.id}
                                    clip={clip}
                                    track={track}
                                    scrollX={daw.scrollX}
                                    pxPerBeat={pxPerBeat}
                                    height={track.height}
                                    selected={daw.selectedClipId === clip.id}
                                    tool={daw.tool}
                                    onMouseDown={e => handleClipMouseDown(e, clip, track)}
                                    onContextMenu={e => handleClipRightClick(e, clip, track)}
                                    onDoubleClick={() => {
                                        if (clip.type === "midi") daw.openPianoRoll(track.id, clip.id);
                                        else if (clip.type === "audio") {
                                            window.open(`/editor?clip=${clip.id}&track=${track.id}`, "_blank");
                                        }
                                    }}
                                    onResizeRightStart={e => handleResizeRightStart(e, clip)}
                                    onResizeLeftStart={e => handleResizeLeftStart(e, clip)}
                                    onFadeInStart={e => handleFadeInStart(e, clip)}
                                    onFadeOutStart={e => handleFadeOutStart(e, clip)}
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
    const ctxMenu = useContextMenu();
    const isSelected = daw.selectedTrackId === track.id;
    const TypeIcon = track.type === "midi" ? Piano : track.type === "return" ? Headphones : Music;

    const volumeRef = useScrollAdjust({
        value: track.volume,
        min: 0,
        max: 1,
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
                shortcut: "M",
                checked: track.muted,
                onClick: () => daw.toggleTrackMute(track.id),
            },
            {
                label: track.soloed ? "Unsolo" : "Solo",
                icon: <Headphones className="h-3.5 w-3.5" />,
                shortcut: "S",
                checked: track.soloed,
                onClick: () => daw.toggleTrackSolo(track.id),
            },
            {
                label: "Freeze Track",
                icon: <Snowflake className="h-3.5 w-3.5" />,
                onClick: () => daw.freezeTrack(track.id),
            },
            { type: "separator" },
            {
                type: "sub",
                label: "Track Height",
                icon: <ArrowUp className="h-3.5 w-3.5" />,
                items: [
                    { label: "Small (60px)", onClick: () => daw.setTrackHeight(track.id, 60) },
                    { label: "Medium (80px)", onClick: () => daw.setTrackHeight(track.id, 80) },
                    { label: "Large (120px)", onClick: () => daw.setTrackHeight(track.id, 120) },
                    { label: "Extra Large (180px)", onClick: () => daw.setTrackHeight(track.id, 180) },
                ],
            },
            {
                type: "sub",
                label: "Set Color",
                icon: <Palette className="h-3.5 w-3.5" />,
                items: colorMenuItems(track.color, c => daw.setTrackColor(track.id, c)),
            },
            { type: "separator" },
            index > 0
                ? { label: "Move Up", icon: <ArrowUp className="h-3.5 w-3.5" />, onClick: () => daw.reorderTrack(track.id, index - 1) }
                : { label: "Move Up", icon: <ArrowUp className="h-3.5 w-3.5" />, disabled: true, onClick: () => { } },
            index < daw.project.tracks.length - 1
                ? { label: "Move Down", icon: <ArrowDown className="h-3.5 w-3.5" />, onClick: () => daw.reorderTrack(track.id, index + 1) }
                : { label: "Move Down", icon: <ArrowDown className="h-3.5 w-3.5" />, disabled: true, onClick: () => { } },
            { type: "separator" },
            {
                label: "Delete Track",
                icon: <Trash2 className="h-3.5 w-3.5" />,
                destructive: true,
                onClick: () => daw.removeTrack(track.id),
            },
        ];

        ctxMenu.show(e.clientX, e.clientY, items);
    }, [daw, track, index, ctxMenu]);

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
            onContextMenu={handleContextMenu}
        >
            {/* Track name row */}
            <div className="flex items-center gap-1.5 mb-1.5">
                <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-1 ring-white/10"
                    style={{ background: track.color }}
                />
                <TypeIcon className="h-3 w-3 text-[var(--daw-text-dim)] flex-shrink-0" />
                <InlineEditName
                    value={track.name}
                    onCommit={name => daw.renameTrack(track.id, name)}
                    className="text-[11px] text-[var(--daw-text)] truncate flex-1 font-medium"
                />
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
                    ref={volumeRef}
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

function ClipBlock({ clip, track, scrollX, pxPerBeat, height, selected, tool, onMouseDown, onContextMenu, onDoubleClick, onResizeRightStart, onResizeLeftStart, onFadeInStart, onFadeOutStart }: {
    clip: Clip;
    track: DAWTrack;
    scrollX: number;
    pxPerBeat: number;
    height: number;
    selected: boolean;
    tool: string;
    onMouseDown: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onDoubleClick: () => void;
    onResizeRightStart: (e: React.MouseEvent) => void;
    onResizeLeftStart: (e: React.MouseEvent) => void;
    onFadeInStart: (e: React.MouseEvent) => void;
    onFadeOutStart: (e: React.MouseEvent) => void;
}) {
    const left = (clip.position - scrollX) * pxPerBeat;
    const width = clip.length * pxPerBeat;

    if (left + width < 0 || left > 2000) return null;

    const fadeInPx = (clip.audio?.fadeIn ?? 0) * pxPerBeat;
    const fadeOutPx = (clip.audio?.fadeOut ?? 0) * pxPerBeat;
    const isAudio = clip.type === "audio";
    const clipHeight = height - 10;

    return (
        <div
            className={cn(
                "absolute top-1 rounded-md overflow-hidden group transition-shadow duration-150",
                selected
                    ? "ring-1 ring-[var(--daw-accent)] shadow-[0_0_12px_var(--daw-accent-glow)]"
                    : "ring-1 ring-white/[0.06] hover:ring-white/15",
                clip.muted && "opacity-35",
                tool === "select" ? "cursor-grab active:cursor-grabbing" :
                    tool === "draw" ? "cursor-crosshair" :
                        tool === "erase" ? "cursor-pointer" :
                            tool === "slice" ? "cursor-col-resize" :
                                tool === "mute" ? "cursor-pointer" : "cursor-default"
            )}
            style={{
                left: Math.max(0, left),
                width: Math.max(4, width - (left < 0 ? -left : 0)),
                height: clipHeight,
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

                {/* Fade in overlay */}
                {isAudio && fadeInPx > 1 && (
                    <div
                        className="absolute top-0 left-0 bottom-0 pointer-events-none"
                        style={{
                            width: fadeInPx,
                            background: "linear-gradient(90deg, rgba(0,0,0,0.5) 0%, transparent 100%)",
                        }}
                    />
                )}

                {/* Fade out overlay */}
                {isAudio && fadeOutPx > 1 && (
                    <div
                        className="absolute top-0 right-0 bottom-0 pointer-events-none"
                        style={{
                            width: fadeOutPx,
                            background: "linear-gradient(-90deg, rgba(0,0,0,0.5) 0%, transparent 100%)",
                        }}
                    />
                )}
            </div>

            {/* Left resize handle */}
            <div
                className="absolute left-0 top-0 bottom-0 w-1.5 cursor-w-resize opacity-0 group-hover:opacity-100 bg-white/15 transition-opacity z-10"
                onMouseDown={onResizeLeftStart}
            />

            {/* Right resize handle */}
            <div
                className="absolute right-0 top-0 bottom-0 w-1.5 cursor-e-resize opacity-0 group-hover:opacity-100 bg-white/15 transition-opacity z-10"
                onMouseDown={onResizeRightStart}
            />

            {/* Fade in handle (audio only) */}
            {isAudio && (
                <div
                    className="absolute top-0 left-0 w-3 h-3 cursor-col-resize opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center"
                    style={{ left: Math.max(0, fadeInPx - 4) }}
                    onMouseDown={onFadeInStart}
                >
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--daw-accent)] shadow-[0_0_4px_var(--daw-accent-glow)]" />
                </div>
            )}

            {/* Fade out handle (audio only) */}
            {isAudio && (
                <div
                    className="absolute top-0 right-0 w-3 h-3 cursor-col-resize opacity-0 group-hover:opacity-100 transition-opacity z-20 flex items-center justify-center"
                    style={{ right: Math.max(0, fadeOutPx - 4) }}
                    onMouseDown={onFadeOutStart}
                >
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--daw-accent)] shadow-[0_0_4px_var(--daw-accent-glow)]" />
                </div>
            )}
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
