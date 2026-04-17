"use client";

import { useRef, useCallback, useState, useEffect } from "react";
import { useDAW } from "./daw-context";
import {
    Volume2, VolumeX, Headphones, Circle, Trash2, Plus, Piano, Music,
    Copy, Scissors, Palette, EyeOff, Snowflake, ArrowUp, ArrowDown,
    Volume1, AudioWaveform, ChevronDown, Drum, CornerDownRight, Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DAWTrack, Clip, AutomationLane } from "@/lib/daw-engine";
import { useContextMenu, colorMenuItems, type MenuEntry } from "./daw-context-menu";
import { InlineEditName, useScrollAdjust } from "./daw-ui-utils";
import { useDAWSettings, PLAYHEAD_COLORS, type WaveformStyle, type WaveformColorMode } from "@/hooks/use-daw-settings";

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
    const ds = useDAWSettings();
    const ctxMenu = useContextMenu();
    const containerRef = useRef<HTMLDivElement>(null);
    const trackAreaRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<DragMode>(null);
    const [dropPreview, setDropPreview] = useState<{ trackId: string; beat: number; name: string; duration: number } | null>(null);

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
            }, {
                label: "Separate to Stems",
                icon: <Layers className="h-3.5 w-3.5 text-purple-400" />,
                onClick: () => {
                    import("sonner").then(({ toast }) => {
                        const toastId = toast.loading("Separating stems...", { description: clip.name });
                        daw.separateClipToStems(clip.id).then(() => {
                            toast.success("Stems separated into tracks", { id: toastId, description: "4 new tracks created: Vocals, Drums, Bass, Melody" });
                        }).catch(() => {
                            toast.error("Stem separation failed", { id: toastId });
                        });
                    });
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
    const handleTrackDragOver = useCallback((e: React.DragEvent, track: DAWTrack) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);
        // We don't have access to the drag data during dragover (browser security),
        // so show a generic preview placeholder
        setDropPreview(prev =>
            prev?.trackId === track.id && prev.beat === beat ? prev : { trackId: track.id, beat, name: "", duration: 0 }
        );
    }, [daw.scrollX, pxPerBeat, snapToBeat]);

    const handleTrackDragLeave = useCallback((e: React.DragEvent) => {
        // Only clear if actually leaving the track lane (not entering a child)
        const related = e.relatedTarget as HTMLElement | null;
        if (related && e.currentTarget.contains(related)) return;
        setDropPreview(null);
    }, []);

    const handleTrackDrop = useCallback(async (e: React.DragEvent, track: DAWTrack) => {
        e.preventDefault();
        setDropPreview(null);

        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + daw.scrollX * pxPerBeat;
        const beat = snapToBeat(x / pxPerBeat);

        // Try JSON data first (sample browser / library drags)
        const jsonData = e.dataTransfer.getData("text/plain");
        if (jsonData) {
            try {
                const data = JSON.parse(jsonData);
                if (data.type === "sample" && data.path) {
                    if (track.type !== "audio") return;
                    const clip = daw.addClip(track.id, "audio", beat, 4, data.name || "Sample");
                    await daw.loadAudioIntoClip(clip.id, data.path, data.name);
                    return;
                }
                if (data.type === "library-track" && data.track?.filePath) {
                    if (track.type !== "audio") return;
                    const filePath = data.track.filePath;
                    const audioUrl = filePath.startsWith("/") ? filePath : `/api/audio/${encodeURIComponent(filePath)}`;
                    const clip = daw.addClip(track.id, "audio", beat, 4, data.track.title || "Audio");
                    await daw.loadAudioIntoClip(clip.id, audioUrl, data.track.title);
                    return;
                }
            } catch { /* not JSON, fall through to file drop */ }
        }

        // Native file drop
        if (track.type !== "audio") return;
        const files = Array.from(e.dataTransfer.files);
        const audioFile = files.find(f => f.type.startsWith("audio/"));
        if (!audioFile) return;
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
            onDragEnd={() => setDropPreview(null)}
        >
            {/* Ruler */}
            <div className="flex flex-shrink-0" style={{ height: RULER_HEIGHT }}>
                <div
                    className="flex-shrink-0 bg-[var(--daw-surface)] border-r border-b border-[var(--daw-border)] flex items-center px-3"
                    style={{ width: HEADER_WIDTH }}
                >
                    <AddTrackMenu />
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
                            style={{ left: playheadX, background: ds.playheadHex }}
                        >
                            <div
                                className="w-3 h-3 rounded-b-sm -ml-[5px]"
                                style={{ background: ds.playheadHex }}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Tracks */}
            <div ref={trackAreaRef} className="flex-1 overflow-y-auto overflow-x-hidden" style={{ marginTop: 0 }}>
                {daw.project.tracks.map((track, idx) => {
                    const hasActiveClip = daw.isPlaying && track.clips.some(c => daw.activeClipIds.includes(c.id));
                    return (
                    <div key={track.id} className="flex" style={{ height: track.height }}>
                        <TrackHeader track={track} index={idx} isActive={hasActiveClip} />

                        <div
                            data-track-lane={track.id}
                            className={cn(
                                "flex-1 relative border-b border-[var(--daw-border)] overflow-hidden transition-colors duration-150",
                                dropPreview?.trackId === track.id && "bg-[var(--daw-accent)]/[0.04]"
                            )}
                            style={{ background: dropPreview?.trackId === track.id ? undefined : `linear-gradient(90deg, ${track.color}06 0%, transparent 100%)` }}
                            onMouseDown={e => handleTrackMouseDown(e, track)}
                            onDoubleClick={e => handleTrackDoubleClick(e, track)}
                            onDragOver={e => handleTrackDragOver(e, track)}
                            onDragLeave={handleTrackDragLeave}
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

                            {/* Drop preview ghost */}
                            {dropPreview && dropPreview.trackId === track.id && (
                                <div
                                    className="absolute top-1 rounded-md pointer-events-none z-20 animate-in fade-in-0 zoom-in-95 duration-150"
                                    style={{
                                        left: (dropPreview.beat - daw.scrollX) * pxPerBeat,
                                        width: Math.max(4 * pxPerBeat, 60),
                                        height: track.height - 10,
                                        background: `linear-gradient(180deg, ${track.color}25 0%, ${track.color}10 100%)`,
                                        borderLeft: `2px solid ${track.color}`,
                                        boxShadow: `0 0 20px ${track.color}20, inset 0 0 20px ${track.color}08`,
                                    }}
                                >
                                    {/* Mini waveform bars placeholder */}
                                    <div className="absolute inset-0 flex items-center justify-center gap-[1px] px-2 opacity-60">
                                        {Array.from({ length: 24 }).map((_, i) => {
                                            const h = 15 + Math.sin(i * 0.8) * 12 + Math.sin(i * 2.1) * 8;
                                            return (
                                                <div
                                                    key={i}
                                                    className="flex-1 rounded-full min-w-[1px]"
                                                    style={{
                                                        height: `${Math.max(10, Math.min(85, h))}%`,
                                                        background: track.color,
                                                        opacity: 0.4 + Math.sin(i * 0.5) * 0.2,
                                                    }}
                                                />
                                            );
                                        })}
                                    </div>
                                    {/* Drop indicator line */}
                                    <div
                                        className="absolute left-0 top-0 bottom-0 w-0.5 animate-pulse"
                                        style={{ background: track.color }}
                                    />
                                </div>
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
                                    isActive={daw.isPlaying && daw.activeClipIds.includes(clip.id)}
                                    tool={daw.tool}
                                    onMouseDown={e => handleClipMouseDown(e, clip, track)}
                                    onContextMenu={e => handleClipRightClick(e, clip, track)}
                                    onDoubleClick={e => {
                                        e.stopPropagation();
                                        if (clip.type === "midi") daw.openPianoRoll(track.id, clip.id);
                                        else if (clip.type === "audio" && clip.audio?.sourceUrl) {
                                            const params = new URLSearchParams({
                                                clip: clip.id,
                                                track: track.id,
                                                src: clip.audio.sourceUrl,
                                                name: clip.name,
                                            });
                                            window.open(`/editor?${params.toString()}`, "_blank");
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
                                    style={{ left: playheadX, background: ds.playheadHex }}
                                />
                            )}

                            {/* Automation lane overlay */}
                            {track.automationLanes.filter(l => l.visible).map(lane => (
                                <AutomationCurve
                                    key={lane.id}
                                    lane={lane}
                                    scrollX={daw.scrollX}
                                    pxPerBeat={pxPerBeat}
                                    height={track.height}
                                />
                            ))}
                        </div>
                    </div>
                    );
                })}

                <div className="h-32" />
            </div>
        </div>
    );
}

// ─── Track Header ────────────────────────────────────────────────────────

function TrackHeader({ track, index, isActive }: { track: DAWTrack; index: number; isActive?: boolean }) {
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
                    : isActive
                        ? "bg-[var(--daw-surface-2)] shadow-[inset_3px_0_0_var(--daw-green)]"
                        : "bg-[var(--daw-surface)] hover:bg-[var(--daw-surface-2)]"
            )}
            style={{ width: HEADER_WIDTH }}
            onClick={() => daw.selectTrack(track.id)}
            onContextMenu={handleContextMenu}
        >
            {/* Track name row */}
            <div className="flex items-center gap-1.5 mb-1.5">
                <div className="relative flex-shrink-0">
                    <div
                        className="w-2.5 h-2.5 rounded-full ring-1 ring-white/10"
                        style={{ background: track.color }}
                    />
                    {isActive && (
                        <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--daw-green)] animate-pulse shadow-[0_0_4px_var(--daw-green)]" />
                    )}
                </div>
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

// ─── Add Track Menu ────────────────────────────────────────────────────────

function AddTrackMenu() {
    const daw = useDAW();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const items: { label: string; icon: React.ReactNode; type: "audio" | "midi" | "return" }[] = [
        { label: "Audio Track", icon: <AudioWaveform className="h-3 w-3" />, type: "audio" },
        { label: "MIDI Track", icon: <Piano className="h-3 w-3" />, type: "midi" },
        { label: "Return Track", icon: <CornerDownRight className="h-3 w-3" />, type: "return" },
    ];

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(v => !v)}
                className="daw-btn h-6 gap-1 px-2 text-[10px] text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
            >
                <Plus className="h-3 w-3" /> Add Track <ChevronDown className="h-2.5 w-2.5 opacity-60" />
            </button>
            {open && (
                <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[140px] rounded-md border border-[var(--daw-border)] bg-[var(--daw-surface)] shadow-lg py-1">
                    {items.map(item => (
                        <button
                            key={item.type}
                            onClick={() => { daw.addTrack(item.type); setOpen(false); }}
                            className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-[var(--daw-text-muted)] hover:bg-[var(--daw-accent)]/10 hover:text-[var(--daw-text)]"
                        >
                            {item.icon} {item.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Clip Block ──────────────────────────────────────────────────────────

function ClipBlock({ clip, track, scrollX, pxPerBeat, height, selected, isActive, tool, onMouseDown, onContextMenu, onDoubleClick, onResizeRightStart, onResizeLeftStart, onFadeInStart, onFadeOutStart }: {
    clip: Clip;
    track: DAWTrack;
    scrollX: number;
    pxPerBeat: number;
    height: number;
    selected: boolean;
    isActive: boolean;
    tool: string;
    onMouseDown: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
    onResizeRightStart: (e: React.MouseEvent) => void;
    onResizeLeftStart: (e: React.MouseEvent) => void;
    onFadeInStart: (e: React.MouseEvent) => void;
    onFadeOutStart: (e: React.MouseEvent) => void;
}) {
    const ds = useDAWSettings();
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
                    : (isActive && ds.activeClipHighlight)
                        ? "ring-1 ring-[var(--daw-green)] shadow-[0_0_10px_oklch(0.72_0.17_142/0.25)]"
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
            <div className={cn(
                "h-4 px-1.5 flex items-center gap-1 bg-black/15",
                (isActive && ds.activeClipHighlight) && "bg-[var(--daw-green)]/10"
            )}>
                {(isActive && ds.activeClipHighlight) && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--daw-green)] flex-shrink-0 animate-pulse shadow-[0_0_3px_var(--daw-green)]" />
                )}
                {ds.showClipNames && (
                    <span className={cn(
                        "text-[9px] truncate font-medium",
                        (isActive && ds.activeClipHighlight) ? "text-white/80" : "text-white/60"
                    )}>{clip.name}</span>
                )}
                {ds.showClipInfoBadges && clip.type === "midi" && (
                    <span className="text-[7px] text-purple-400/40 flex-shrink-0 ml-auto">MIDI</span>
                )}
                {ds.showClipInfoBadges && clip.type === "audio" && clip.audio && clip.audio.duration > 0 && (
                    <span className="text-[7px] text-cyan-400/40 flex-shrink-0 ml-auto">
                        {clip.audio.duration < 1 ? `${Math.round(clip.audio.duration * 1000)}ms` : `${clip.audio.duration.toFixed(1)}s`}
                    </span>
                )}
            </div>

            {/* Clip content */}
            <div className="flex-1 relative overflow-hidden" style={{ opacity: ds.clipOpacity }}>
                {clip.type === "audio" && clip.audio?.waveformPeaks && (ds.clipDisplayMode === "waveform" || ds.clipDisplayMode === "both") && (
                    <WaveformPreview peaks={clip.audio.waveformPeaks} color={clip.color} style={ds.waveformStyle} colorMode={ds.waveformColorMode} />
                )}
                {clip.type === "midi" && clip.midi && (ds.clipDisplayMode === "notes" || ds.clipDisplayMode === "both") && (
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

function WaveformPreview({ peaks, color, style, colorMode }: { peaks: Float32Array; color: string; style: WaveformStyle; colorMode: WaveformColorMode }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        const baseColor = colorMode === "mono" ? "#888888" : color;
        const step = peaks.length / w;

        if (style === "filled") {
            // Filled area under the waveform
            ctx.fillStyle = baseColor + "40";
            ctx.beginPath();
            ctx.moveTo(0, h / 2);
            for (let i = 0; i < w; i++) {
                const idx = Math.floor(i * step);
                const amp = peaks[idx] * h * 0.4;
                ctx.lineTo(i, h / 2 - amp);
            }
            for (let i = w - 1; i >= 0; i--) {
                const idx = Math.floor(i * step);
                const amp = peaks[idx] * h * 0.4;
                ctx.lineTo(i, h / 2 + amp);
            }
            ctx.closePath();
            ctx.fill();
            // Outline
            ctx.strokeStyle = baseColor + "90";
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            for (let i = 0; i < w; i++) {
                const idx = Math.floor(i * step);
                const amp = peaks[idx] * h * 0.4;
                if (i === 0) ctx.moveTo(i, h / 2 - amp);
                else ctx.lineTo(i, h / 2 - amp);
            }
            ctx.stroke();
        } else if (style === "lines") {
            // Line waveform (single line connecting peaks)
            ctx.strokeStyle = baseColor + "90";
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < w; i++) {
                const idx = Math.floor(i * step);
                const amp = peaks[idx] * h * 0.4;
                const y = h / 2 - amp;
                if (i === 0) ctx.moveTo(i, y);
                else ctx.lineTo(i, y);
            }
            ctx.stroke();
        } else if (style === "bars") {
            // Discrete bars
            const barWidth = Math.max(2, Math.floor(w / 60));
            const barGap = 1;
            if (colorMode === "gradient") {
                for (let x = 0; x < w; x += barWidth + barGap) {
                    const idx = Math.floor(x * step);
                    const amp = peaks[idx] * h * 0.4;
                    const ratio = x / w;
                    ctx.fillStyle = `hsl(${200 + ratio * 160}, 70%, 55%)`;
                    ctx.fillRect(x, h / 2 - amp, barWidth, amp * 2);
                }
            } else {
                ctx.fillStyle = baseColor + "70";
                for (let x = 0; x < w; x += barWidth + barGap) {
                    const idx = Math.floor(x * step);
                    const amp = peaks[idx] * h * 0.4;
                    ctx.fillRect(x, h / 2 - amp, barWidth, amp * 2);
                }
            }
        } else {
            // Classic (default): column per pixel
            if (colorMode === "gradient") {
                for (let i = 0; i < w; i++) {
                    const idx = Math.floor(i * step);
                    const amp = peaks[idx] * h * 0.4;
                    const ratio = i / w;
                    ctx.fillStyle = `hsl(${200 + ratio * 160}, 70%, 55%)`;
                    ctx.fillRect(i, h / 2 - amp, 1, amp * 2);
                }
            } else {
                ctx.fillStyle = baseColor + "70";
                for (let i = 0; i < w; i++) {
                    const idx = Math.floor(i * step);
                    const amp = peaks[idx] * h * 0.4;
                    ctx.fillRect(i, h / 2 - amp, 1, amp * 2);
                }
            }
        }
    }, [peaks, color, style, colorMode]);

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
    const ds = useDAWSettings();
    if (ds.gridStyle === "none") return null;

    const lines: { x: number; isBeat: boolean; isBar: boolean }[] = [];
    const beatsPerBar = timeSignature.numerator;
    const startBeat = Math.floor(scrollX);
    const visibleBeats = Math.ceil(2000 / pxPerBeat) + 2;

    for (let b = startBeat; b < startBeat + visibleBeats; b++) {
        const x = (b - scrollX) * pxPerBeat;
        lines.push({ x, isBeat: b % 1 === 0, isBar: b % beatsPerBar === 0 });
    }

    if (ds.gridStyle === "dots") {
        return (
            <>
                {lines.filter(l => l.isBeat).map((l, i) => (
                    <div
                        key={i}
                        className="absolute pointer-events-none rounded-full"
                        style={{
                            left: l.x - 1,
                            top: height / 2 - 1,
                            width: l.isBar ? 3 : 2,
                            height: l.isBar ? 3 : 2,
                            background: `oklch(1 0 0 / ${l.isBar ? ds.gridOpacity * 0.15 : ds.gridOpacity * 0.08})`,
                        }}
                    />
                ))}
            </>
        );
    }

    return (
        <>
            {lines.map((l, i) => (
                <div
                    key={i}
                    className="absolute top-0 bottom-0 pointer-events-none w-px"
                    style={{
                        left: l.x,
                        background: l.isBar
                            ? `oklch(1 0 0 / ${ds.gridOpacity * 0.15})`
                            : l.isBeat
                                ? `oklch(1 0 0 / ${ds.gridOpacity * 0.08})`
                                : undefined,
                    }}
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

// ─── Automation Curve Overlay ────────────────────────────────────────────

function AutomationCurve({ lane, scrollX, pxPerBeat, height }: {
    lane: AutomationLane;
    scrollX: number;
    pxPerBeat: number;
    height: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || lane.points.length < 2) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        // Draw automation curve
        ctx.beginPath();
        ctx.strokeStyle = lane.color + "90";
        ctx.lineWidth = 1.5;

        const points = lane.points.sort((a, b) => a.time - b.time);

        for (let i = 0; i < points.length; i++) {
            const x = (points[i].time - scrollX) * pxPerBeat;
            const y = h - points[i].value * h; // value is 0-1, map to height
            if (i === 0) ctx.moveTo(x, y);
            else if (points[i].curve === "step") {
                const prevY = h - points[i - 1].value * h;
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw points
        for (const point of points) {
            const x = (point.time - scrollX) * pxPerBeat;
            const y = h - point.value * h;
            if (x < -5 || x > w + 5) continue;
            ctx.beginPath();
            ctx.arc(x, y, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = lane.color;
            ctx.fill();
        }

        // Fill under curve with low opacity
        ctx.beginPath();
        for (let i = 0; i < points.length; i++) {
            const x = (points[i].time - scrollX) * pxPerBeat;
            const y = h - points[i].value * h;
            if (i === 0) ctx.moveTo(x, y);
            else if (points[i].curve === "step") {
                const prevY = h - points[i - 1].value * h;
                ctx.lineTo(x, prevY);
                ctx.lineTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        const lastX = (points[points.length - 1].time - scrollX) * pxPerBeat;
        ctx.lineTo(lastX, h);
        ctx.lineTo((points[0].time - scrollX) * pxPerBeat, h);
        ctx.closePath();
        ctx.fillStyle = lane.color + "15";
        ctx.fill();
    }, [lane, scrollX, pxPerBeat, height]);

    if (lane.points.length < 2) return null;

    return (
        <canvas
            ref={canvasRef}
            className="absolute top-0 left-0 w-full h-full pointer-events-none z-5"
            width={2000}
            height={height}
        />
    );
}
