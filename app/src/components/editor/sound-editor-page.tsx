"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorProvider, useEditor, type EditorView, type EditorTool } from "./editor-context";
import { HistoryPanel } from "../daw/daw-history-panel";
import { WaveformView } from "./waveform-view";
import { SpectrogramView } from "./spectrogram-view";
import { cn } from "@/lib/utils";
import { useSearchParams } from "next/navigation";
import {
    Play, Pause, Square, SkipBack, SkipForward,
    ZoomIn, ZoomOut, Scissors, Copy, Clipboard,
    Trash2, Undo2, Redo2, Volume2, AudioWaveform,
    MousePointer2, Hand, Pencil, Search, Waves,
    SplitSquareHorizontal, BarChart3, Bookmark,
    ArrowDownToLine, ArrowUpFromLine, RotateCcw,
    VolumeX, FileAudio, FolderOpen, Download, Save,
    ArrowLeft, Clock,
} from "lucide-react";
import Link from "next/link";

// ═══════════════════════════════════════════════════════════════════════════
// Sound Editor Page (wrapper with provider)
// ═══════════════════════════════════════════════════════════════════════════

export function SoundEditorPage() {
    return (
        <EditorProvider>
            <SoundEditorInner />
        </EditorProvider>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Inner component (uses context)
// ═══════════════════════════════════════════════════════════════════════════

function SoundEditorInner() {
    const editor = useEditor();
    const searchParams = useSearchParams();
    const dropRef = useRef<HTMLDivElement>(null);
    const [showHistory, setShowHistory] = useState(false);

    // Load from URL params on mount
    useEffect(() => {
        const clipId = searchParams.get("clip");
        const trackId = searchParams.get("track");
        if (trackId) {
            editor.loadFromUrl(`/api/audio/${trackId}`, `Track ${trackId}`);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keyboard shortcuts
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement) return;

            if (e.key === " ") { e.preventDefault(); editor.isPlaying ? editor.pause() : editor.play(); }
            else if (e.key === "Escape") { editor.stop(); }
            else if (e.ctrlKey && e.key === "z") { e.preventDefault(); editor.undo(); }
            else if (e.ctrlKey && e.key === "y") { e.preventDefault(); editor.redo(); }
            else if (e.ctrlKey && e.key === "x") { e.preventDefault(); editor.cut(); }
            else if (e.ctrlKey && e.key === "c") { e.preventDefault(); editor.copy(); }
            else if (e.ctrlKey && e.key === "v") { e.preventDefault(); editor.paste(); }
            else if (e.key === "Delete") { editor.deleteSelection(); }
            else if (e.key === "t") { editor.setTool("select"); }
            else if (e.key === "z") { editor.setTool("zoom"); }
            else if (e.key === "h") { editor.setTool("hand"); }
            else if (e.key === "p") { editor.setTool("pencil"); }
            else if (e.key === "r") { editor.setTool("razor"); }
            else if (e.key === "m") {
                editor.addMarker(editor.playPosition);
            }
            else if (e.key === "F8") { e.preventDefault(); setShowHistory(h => !h); }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [editor]);

    // File drop
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith("audio/"));
        if (file) editor.loadFromFile(file);
    }, [editor]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    }, []);

    // File picker
    const fileInputRef = useRef<HTMLInputElement>(null);
    const handleFileOpen = useCallback(() => fileInputRef.current?.click(), []);
    const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) editor.loadFromFile(file);
        e.target.value = "";
    }, [editor]);

    return (
        <div
            ref={dropRef}
            className="h-screen flex flex-col bg-[oklch(0.12_0.01_260)] text-white overflow-hidden"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
        >
            <input ref={fileInputRef} type="file" accept="audio/*" onChange={handleFileChange} className="hidden" />

            {/* Top Toolbar */}
            <EditorToolbar onFileOpen={handleFileOpen} showHistory={showHistory} onToggleHistory={() => setShowHistory(h => !h)} />

            {/* Main content area with optional history sidebar */}
            <div className="flex-1 flex overflow-hidden">
                {/* Waveform / Spectrogram area */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Timeline ruler */}
                    <TimelineRuler />

                    {/* Waveform / Spectrogram / Split */}
                    <div className="flex-1 relative overflow-hidden">
                        {editor.view === "waveform" && <WaveformView />}
                        {editor.view === "spectrogram" && <SpectrogramView />}
                        {editor.view === "split" && (
                            <div className="flex flex-col h-full">
                                <div className="flex-1 border-b border-[oklch(1_0_0/0.1)]">
                                    <WaveformView />
                                </div>
                                <div className="flex-1">
                                    <SpectrogramView />
                                </div>
                            </div>
                        )}

                        {/* Empty state */}
                        {!editor.buffer && !editor.isLoading && (
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="text-center space-y-4">
                                    <FileAudio className="h-16 w-16 text-[oklch(1_0_0/0.1)] mx-auto" />
                                    <div className="text-[oklch(1_0_0/0.3)] text-sm">
                                        Drop an audio file here, or click <strong>Open</strong> to load a file
                                    </div>
                                    <div className="text-[oklch(1_0_0/0.15)] text-xs">
                                        Supports MP3, WAV, FLAC, AAC, OGG, M4A
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Loading */}
                        {editor.isLoading && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-50">
                                <div className="text-center space-y-2">
                                    <div className="animate-spin h-8 w-8 border-2 border-[oklch(0.62_0.19_250)] border-t-transparent rounded-full mx-auto" />
                                    <div className="text-sm text-[oklch(1_0_0/0.5)]">Loading audio...</div>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Minimap */}
                    {editor.buffer && <Minimap />}
                </div>

                {/* History sidebar */}
                {showHistory && (
                    <div className="w-56 border-l border-[oklch(1_0_0/0.08)] flex-shrink-0">
                        <HistoryPanel
                            history={editor.history}
                            onUndo={editor.undo}
                            onRedo={editor.redo}
                            onJump={editor.jumpToHistoryEntry}
                            compact
                        />
                    </div>
                )}
            </div>

            {/* Bottom info bar */}
            <InfoBar />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Toolbar
// ═══════════════════════════════════════════════════════════════════════════

function EditorToolbar({ onFileOpen, showHistory, onToggleHistory }: { onFileOpen: () => void; showHistory: boolean; onToggleHistory: () => void }) {
    const editor = useEditor();

    const tools: { tool: EditorTool; icon: typeof MousePointer2; label: string; key: string }[] = [
        { tool: "select", icon: MousePointer2, label: "Select (T)", key: "T" },
        { tool: "zoom", icon: Search, label: "Zoom (Z)", key: "Z" },
        { tool: "hand", icon: Hand, label: "Hand (H)", key: "H" },
        { tool: "pencil", icon: Pencil, label: "Pencil (P)", key: "P" },
        { tool: "razor", icon: Scissors, label: "Razor (R)", key: "R" },
    ];

    const views: { view: EditorView; icon: typeof Waves; label: string }[] = [
        { view: "waveform", icon: AudioWaveform, label: "Waveform" },
        { view: "spectrogram", icon: BarChart3, label: "Spectrogram" },
        { view: "split", icon: SplitSquareHorizontal, label: "Split View" },
    ];

    return (
        <div className="h-10 bg-[oklch(0.16_0.01_260)] border-b border-[oklch(1_0_0/0.08)] flex items-center px-2 gap-1 flex-shrink-0">
            {/* Back to DAW */}
            <Link href="/daw" className="editor-btn" title="Back to DAW">
                <ArrowLeft className="h-3.5 w-3.5" />
            </Link>

            <Sep />

            {/* File */}
            <Btn icon={FolderOpen} label="Open" onClick={onFileOpen} />
            <Btn icon={Save} label="Save (Ctrl+S)" onClick={() => { /* TODO: export */ }} />
            <Btn icon={Download} label="Export" onClick={() => { /* TODO: export dialog */ }} />

            <Sep />

            {/* Undo/Redo */}
            <Btn icon={Undo2} label="Undo (Ctrl+Z)" onClick={editor.undo} disabled={!editor.canUndo} />
            <Btn icon={Redo2} label="Redo (Ctrl+Y)" onClick={editor.redo} disabled={!editor.canRedo} />

            <Sep />

            {/* Edit */}
            <Btn icon={Scissors} label="Cut (Ctrl+X)" onClick={editor.cut} disabled={!editor.selection} />
            <Btn icon={Copy} label="Copy (Ctrl+C)" onClick={editor.copy} disabled={!editor.selection} />
            <Btn icon={Clipboard} label="Paste (Ctrl+V)" onClick={editor.paste} />
            <Btn icon={Trash2} label="Delete (Del)" onClick={editor.deleteSelection} disabled={!editor.selection} />

            <Sep />

            {/* Tools */}
            {tools.map(t => (
                <Btn
                    key={t.tool}
                    icon={t.icon}
                    label={t.label}
                    onClick={() => editor.setTool(t.tool)}
                    active={editor.tool === t.tool}
                />
            ))}

            <Sep />

            {/* View */}
            {views.map(v => (
                <Btn
                    key={v.view}
                    icon={v.icon}
                    label={v.label}
                    onClick={() => editor.setView(v.view)}
                    active={editor.view === v.view}
                />
            ))}

            <div className="flex-1" />

            {/* Zoom */}
            <Btn icon={ZoomOut} label="Zoom Out" onClick={() => editor.setZoom(Math.max(10, editor.zoom * 0.7))} />
            <span className="text-[10px] text-[oklch(1_0_0/0.3)] font-mono w-10 text-center">{Math.round(editor.zoom)}x</span>
            <Btn icon={ZoomIn} label="Zoom In" onClick={() => editor.setZoom(Math.min(5000, editor.zoom * 1.5))} />

            <Sep />

            {/* Effects */}
            <Btn icon={Volume2} label="Normalize" onClick={editor.normalize} />
            <Btn icon={ArrowUpFromLine} label="Fade In" onClick={() => editor.fadeIn()} />
            <Btn icon={ArrowDownToLine} label="Fade Out" onClick={() => editor.fadeOut()} />
            <Btn icon={RotateCcw} label="Reverse" onClick={editor.reverse} />
            <Btn icon={VolumeX} label="Silence Selection" onClick={editor.silence} disabled={!editor.selection} />
            <Btn icon={Bookmark} label="Add Marker (M)" onClick={() => editor.addMarker(editor.playPosition)} />

            <Sep />

            {/* History toggle */}
            <Btn icon={Clock} label="History (F8)" onClick={onToggleHistory} active={showHistory} />

            <Sep />

            {/* Transport */}
            <Btn icon={SkipBack} label="Start" onClick={editor.stop} />
            {editor.isPlaying
                ? <Btn icon={Pause} label="Pause (Space)" onClick={editor.pause} active />
                : <Btn icon={Play} label="Play (Space)" onClick={editor.play} />}
            <Btn icon={Square} label="Stop (Esc)" onClick={editor.stop} />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Timeline Ruler
// ═══════════════════════════════════════════════════════════════════════════

function TimelineRuler() {
    const editor = useEditor();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(800);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const obs = new ResizeObserver(entries => {
            setWidth(entries[0]?.contentRect.width ?? 800);
        });
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const h = 24;
        canvas.width = width * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);

        ctx.fillStyle = "oklch(0.16 0.01 260)";
        ctx.fillRect(0, 0, width, h);

        if (!editor.buffer) return;

        const { scrollX, zoom, playPosition } = editor;

        // Time labels
        const interval = zoom > 200 ? 0.1 : zoom > 50 ? 0.5 : zoom > 20 ? 1 : 5;
        const startSec = Math.floor(scrollX / interval) * interval;
        const endSec = scrollX + width / zoom;

        ctx.fillStyle = "oklch(1 0 0 / 0.3)";
        ctx.strokeStyle = "oklch(1 0 0 / 0.1)";
        ctx.font = "9px monospace";

        for (let t = startSec; t <= endSec; t += interval) {
            const x = (t - scrollX) * zoom;
            ctx.beginPath();
            ctx.moveTo(x, h - 8);
            ctx.lineTo(x, h);
            ctx.stroke();

            const min = Math.floor(t / 60);
            const sec = (t % 60).toFixed(interval < 1 ? 1 : 0);
            ctx.fillText(`${min}:${sec.padStart(interval < 1 ? 4 : 2, "0")}`, x + 2, h - 10);
        }

        // Sub-ticks
        const subInterval = interval / 4;
        ctx.strokeStyle = "oklch(1 0 0 / 0.05)";
        for (let t = startSec; t <= endSec; t += subInterval) {
            const x = (t - scrollX) * zoom;
            ctx.beginPath();
            ctx.moveTo(x, h - 4);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        // Playhead
        const phx = (playPosition - scrollX) * zoom;
        if (phx >= 0 && phx <= width) {
            ctx.fillStyle = "#22c55e";
            ctx.beginPath();
            ctx.moveTo(phx - 4, h);
            ctx.lineTo(phx + 4, h);
            ctx.lineTo(phx, h - 6);
            ctx.closePath();
            ctx.fill();
        }
    }, [editor.buffer, editor.scrollX, editor.zoom, editor.playPosition, width]);

    const handleClick = useCallback((e: React.MouseEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const sec = editor.scrollX + x / editor.zoom;
        editor.seek(Math.max(0, sec));
    }, [editor]);

    return (
        <div ref={containerRef} className="h-6 flex-shrink-0 border-b border-[oklch(1_0_0/0.08)] cursor-pointer" onClick={handleClick}>
            <canvas ref={canvasRef} className="w-full h-full" />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Minimap
// ═══════════════════════════════════════════════════════════════════════════

function Minimap() {
    const editor = useEditor();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(800);
    const HEIGHT = 40;

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const obs = new ResizeObserver(entries => {
            setWidth(entries[0]?.contentRect.width ?? 800);
        });
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !editor.peaks) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = width * dpr;
        canvas.height = HEIGHT * dpr;
        ctx.scale(dpr, dpr);

        ctx.fillStyle = "oklch(0.14 0.01 260)";
        ctx.fillRect(0, 0, width, HEIGHT);

        // Draw peaks
        const peaks = editor.peaks;
        const step = peaks.length / width;
        ctx.fillStyle = "oklch(0.62 0.19 250 / 0.4)";
        for (let i = 0; i < width; i++) {
            const idx = Math.floor(i * step);
            const amp = peaks[idx] * HEIGHT * 0.45;
            ctx.fillRect(i, HEIGHT / 2 - amp, 1, amp * 2);
        }

        // Viewport indicator
        if (editor.buffer) {
            const viewStart = (editor.scrollX / editor.buffer.duration) * width;
            const viewWidth = (width / editor.zoom / editor.buffer.duration) * width;
            ctx.strokeStyle = "oklch(0.62 0.19 250 / 0.5)";
            ctx.lineWidth = 1;
            ctx.strokeRect(viewStart, 0, Math.max(4, viewWidth), HEIGHT);
            ctx.fillStyle = "oklch(0.62 0.19 250 / 0.08)";
            ctx.fillRect(viewStart, 0, Math.max(4, viewWidth), HEIGHT);
        }

        // Playhead
        if (editor.buffer) {
            const phx = (editor.playPosition / editor.buffer.duration) * width;
            ctx.strokeStyle = "#22c55e";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(phx, 0);
            ctx.lineTo(phx, HEIGHT);
            ctx.stroke();
        }
    }, [editor.peaks, editor.scrollX, editor.zoom, editor.playPosition, editor.buffer, width]);

    const handleClick = useCallback((e: React.MouseEvent) => {
        const canvas = canvasRef.current;
        if (!canvas || !editor.buffer) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = x / width;
        const sec = ratio * editor.buffer.duration;
        // Center viewport on click
        const viewWidth = width / editor.zoom;
        editor.setScrollX(Math.max(0, sec - viewWidth / 2));
    }, [editor, width]);

    return (
        <div ref={containerRef} className="h-10 flex-shrink-0 border-t border-[oklch(1_0_0/0.08)] cursor-pointer" onClick={handleClick}>
            <canvas ref={canvasRef} className="w-full h-full" />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Info Bar
// ═══════════════════════════════════════════════════════════════════════════

function InfoBar() {
    const editor = useEditor();

    const formatTime = (s: number) => {
        const min = Math.floor(s / 60);
        const sec = (s % 60).toFixed(3);
        return `${min}:${sec.padStart(6, "0")}`;
    };

    return (
        <div className="h-7 bg-[oklch(0.16_0.01_260)] border-t border-[oklch(1_0_0/0.08)] flex items-center px-3 gap-4 flex-shrink-0 text-[10px] font-mono text-[oklch(1_0_0/0.35)]">
            {/* File info */}
            <span>{editor.project.name}</span>
            <Sep />
            {editor.buffer && (
                <>
                    <span>{editor.buffer.sampleRate}Hz</span>
                    <span>{editor.buffer.numberOfChannels === 2 ? "Stereo" : "Mono"}</span>
                    <span>{formatTime(editor.project.duration)}</span>
                    <Sep />
                    {/* Position */}
                    <span className="text-[oklch(0.62_0.19_250)]">
                        Pos: {formatTime(editor.playPosition)}
                    </span>
                    {/* Selection */}
                    {editor.selection && (
                        <span className="text-[oklch(0.75_0.15_84)]">
                            Sel: {formatTime(editor.selection.start)} → {formatTime(editor.selection.end)}
                            ({formatTime(editor.selection.end - editor.selection.start)})
                        </span>
                    )}
                    <Sep />
                    {/* Levels */}
                    <div className="flex items-center gap-1">
                        <span>L</span>
                        <div className="w-16 h-1.5 bg-[oklch(1_0_0/0.06)] rounded overflow-hidden">
                            <div
                                className="h-full rounded transition-all duration-75"
                                style={{
                                    width: `${editor.peakL * 100}%`,
                                    background: editor.peakL > 0.9 ? "#ef4444" : editor.peakL > 0.7 ? "#f59e0b" : "#22c55e",
                                }}
                            />
                        </div>
                        <span>R</span>
                        <div className="w-16 h-1.5 bg-[oklch(1_0_0/0.06)] rounded overflow-hidden">
                            <div
                                className="h-full rounded transition-all duration-75"
                                style={{
                                    width: `${editor.peakR * 100}%`,
                                    background: editor.peakR > 0.9 ? "#ef4444" : editor.peakR > 0.7 ? "#f59e0b" : "#22c55e",
                                }}
                            />
                        </div>
                    </div>
                </>
            )}
            <div className="flex-1" />
            {editor.error && <span className="text-red-400">{editor.error}</span>}
            <span>History {editor.history.currentIndex}/{editor.history.entries.length - 1}</span>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Primitives
// ═══════════════════════════════════════════════════════════════════════════

function Btn({ icon: Icon, label, onClick, active, disabled }: {
    icon: typeof Play;
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={label}
            className={cn(
                "editor-btn h-7 w-7 flex items-center justify-center rounded transition-colors",
                active
                    ? "bg-[oklch(0.62_0.19_250/0.2)] text-[oklch(0.62_0.19_250)]"
                    : "text-[oklch(1_0_0/0.4)] hover:text-[oklch(1_0_0/0.7)] hover:bg-[oklch(1_0_0/0.05)]",
                disabled && "opacity-30 pointer-events-none"
            )}
        >
            <Icon className="h-3.5 w-3.5" />
        </button>
    );
}

function Sep() {
    return <div className="w-px h-4 bg-[oklch(1_0_0/0.06)] mx-0.5" />;
}
