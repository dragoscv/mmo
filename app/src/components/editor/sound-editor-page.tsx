"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { EditorProvider, useEditor, type EditorView, type EditorTool } from "./editor-context";
import { EditorRemoteBridge } from "@/components/remote/editor-remote-bridge";
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
    ArrowLeft, Clock, Settings, X, Maximize2, Minimize2,
    Mic, Zap, Cpu, Box, MonitorSpeaker, MemoryStick,
    Layers,
} from "lucide-react";
import { useFocusMode } from "@/components/focus-mode-context";
import { usePerformanceStats } from "@/hooks/use-performance-stats";
import Link from "next/link";
import { VoiceProcessor } from "@/components/daw/daw-voice-processor";
import {
    useDAWSettings,
    enumerateAudioOutputs,
    enumerateAudioInputs,
    requestAudioPermission,
    setAudioContextSinkId,
    type EditorWaveformColor,
    type SpectrogramColorMap,
    EDITOR_WAVEFORM_COLORS,
} from "@/hooks/use-daw-settings";

// ═══════════════════════════════════════════════════════════════════════════
// Sound Editor Page (wrapper with provider)
// ═══════════════════════════════════════════════════════════════════════════

export function SoundEditorPage() {
    return (
        <EditorProvider>
            <EditorRemoteBridge />
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
    const [showSettings, setShowSettings] = useState(false);
    const [showFxPanel, setShowFxPanel] = useState(false);
    const displaySettings = useDAWSettings();

    // Load from URL params on mount
    useEffect(() => {
        const src = searchParams.get("src");
        const name = searchParams.get("name");
        const trackId = searchParams.get("track");
        if (src) {
            // Direct source URL (from DAW clip or sample)
            editor.loadFromUrl(src, name || src.split("/").pop() || "Audio");
        } else if (trackId) {
            // Legacy: load from API by track ID
            editor.loadFromUrl(`/api/audio/${trackId}`, name || `Track ${trackId}`);
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
            else if (e.key === "F10") { e.preventDefault(); setShowFxPanel(f => !f); }
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
            <EditorToolbar
                onFileOpen={handleFileOpen}
                showHistory={showHistory}
                onToggleHistory={() => setShowHistory(h => !h)}
                onToggleSettings={() => setShowSettings(s => !s)}
                showFx={showFxPanel}
                onToggleFx={() => setShowFxPanel(f => !f)}
            />

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
                    {editor.buffer && displaySettings.editorShowMinimap && <Minimap />}
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

                {/* FX / Voice Processor sidebar */}
                {showFxPanel && (
                    <div className="w-[340px] border-l border-[oklch(1_0_0/0.08)] flex-shrink-0 overflow-hidden">
                        <VoiceProcessor compact />
                    </div>
                )}
            </div>

            {/* Bottom info bar */}
            <InfoBar />

            {/* Settings Modal */}
            {showSettings && <EditorSettingsModal onClose={() => setShowSettings(false)} />}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Toolbar
// ═══════════════════════════════════════════════════════════════════════════

function EditorToolbar({ onFileOpen, showHistory, onToggleHistory, onToggleSettings, showFx, onToggleFx }: { onFileOpen: () => void; showHistory: boolean; onToggleHistory: () => void; onToggleSettings: () => void; showFx: boolean; onToggleFx: () => void }) {
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

            {/* Stems */}
            <StemsToolbarSection />

            <Sep />

            {/* History toggle */}
            <Btn icon={Clock} label="History (F8)" onClick={onToggleHistory} active={showHistory} />

            {/* Voice Processor / FX Panel */}
            <Btn icon={Mic} label="Voice Processor (F10)" onClick={onToggleFx} active={showFx} />

            {/* Settings */}
            <Btn icon={Settings} label="Settings" onClick={onToggleSettings} />

            {/* Focus Mode */}
            <FocusModeBtn />

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
    const stats = usePerformanceStats();
    const settings = useDAWSettings();
    const cfg = settings.editorStatusBarStats;

    const fpsPct = (stats.fps / 60) * 100;
    const heapPct = stats.jsHeapLimit > 0 ? (stats.jsHeapUsed / stats.jsHeapLimit) * 100 : 0;

    const formatTime = (s: number) => {
        const min = Math.floor(s / 60);
        const sec = (s % 60).toFixed(3);
        return `${min}:${sec.padStart(6, "0")}`;
    };

    const hasAnyPerfStat = cfg.showFps || cfg.showHeapMemory || cfg.showJsHeapTotal || cfg.showDomNodes || cfg.showAudioLatency || cfg.showCpuCores || cfg.showDeviceMemory;

    return (
        <div className="h-7 bg-[oklch(0.16_0.01_260)] border-t border-[oklch(1_0_0/0.08)] flex items-center px-3 gap-4 flex-shrink-0 text-[10px] font-mono text-[oklch(1_0_0/0.35)]">
            {/* Performance stats */}
            {hasAnyPerfStat && (
                <>
                    <div className="flex items-center gap-2.5">
                        {cfg.showFps && (
                            <div className="flex items-center gap-1">
                                <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", fpsPct >= 90 ? "bg-emerald-500" : fpsPct >= 50 ? "bg-amber-500" : "bg-rose-500")} />
                                <span>{stats.fps} FPS</span>
                            </div>
                        )}
                        {cfg.showHeapMemory && (
                            <div className="flex items-center gap-1">
                                <Cpu className="h-2.5 w-2.5 opacity-40" />
                                <span className={cn(heapPct >= 90 ? "text-rose-400" : heapPct >= 70 ? "text-amber-400" : "")}>
                                    {stats.jsHeapUsed.toFixed(0)}MB
                                </span>
                            </div>
                        )}
                        {cfg.showJsHeapTotal && (
                            <div className="flex items-center gap-1">
                                <Box className="h-2.5 w-2.5 opacity-40" />
                                <span>Heap {stats.jsHeapTotal.toFixed(0)}MB</span>
                            </div>
                        )}
                        {cfg.showDomNodes && (
                            <div className="flex items-center gap-1">
                                <MonitorSpeaker className="h-2.5 w-2.5 opacity-40" />
                                <span>{stats.domNodes} DOM</span>
                            </div>
                        )}
                        {cfg.showAudioLatency && stats.audioLatency > 0 && (
                            <div className="flex items-center gap-1">
                                <Zap className="h-2.5 w-2.5 opacity-40" />
                                <span className={cn(stats.audioLatency > 20 ? "text-amber-400" : "")}>
                                    {stats.audioLatency.toFixed(1)}ms
                                </span>
                            </div>
                        )}
                        {cfg.showCpuCores && stats.cpuCores > 0 && (
                            <div className="flex items-center gap-1">
                                <MemoryStick className="h-2.5 w-2.5 opacity-40" />
                                <span>{stats.cpuCores} cores</span>
                            </div>
                        )}
                        {cfg.showDeviceMemory && stats.deviceMemory > 0 && (
                            <div className="flex items-center gap-1">
                                <MemoryStick className="h-2.5 w-2.5 opacity-40" />
                                <span>{stats.deviceMemory}GB RAM</span>
                            </div>
                        )}
                    </div>
                    <Sep />
                </>
            )}
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

function FocusModeBtn() {
    const { isFocusMode, toggleFocusMode } = useFocusMode();
    return (
        <button
            onClick={toggleFocusMode}
            title={isFocusMode ? "Exit focus mode" : "Focus mode (hide sidebar & player)"}
            className={cn(
                "editor-btn h-7 w-7 flex items-center justify-center rounded transition-colors",
                isFocusMode
                    ? "bg-[oklch(0.62_0.19_300/0.2)] text-[oklch(0.62_0.19_300)]"
                    : "text-[oklch(1_0_0/0.4)] hover:text-[oklch(1_0_0/0.7)] hover:bg-[oklch(1_0_0/0.05)]"
            )}
        >
            {isFocusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
    );
}

const STEM_ITEMS: { type: import("@/lib/stems-engine").StemType; label: string; color: string }[] = [
    { type: "vocals", label: "Vocals", color: "#a855f7" },
    { type: "drums", label: "Drums", color: "#ef4444" },
    { type: "bass", label: "Bass", color: "#3b82f6" },
    { type: "melody", label: "Melody", color: "#22c55e" },
];

function StemsToolbarSection() {
    const editor = useEditor();
    const [open, setOpen] = useState(false);
    const hasBuf = !!editor.buffer;

    return (
        <div className="relative">
            <button
                onClick={() => setOpen(o => !o)}
                disabled={!hasBuf}
                title="Stems Separation"
                className={cn(
                    "editor-btn h-7 px-2 flex items-center gap-1 rounded transition-colors",
                    open
                        ? "bg-purple-500/20 text-purple-400"
                        : "text-[oklch(1_0_0/0.4)] hover:text-[oklch(1_0_0/0.7)] hover:bg-[oklch(1_0_0/0.05)]",
                    !hasBuf && "opacity-30 pointer-events-none",
                )}
            >
                <Layers className="h-3.5 w-3.5" />
                <span className="text-[10px] font-medium">Stems</span>
            </button>

            {open && hasBuf && (
                <div className="absolute top-full left-0 mt-1 z-50 w-44 rounded-lg border border-[oklch(1_0_0/0.1)] bg-[oklch(0.14_0.01_260)] shadow-xl p-1.5 animate-in fade-in slide-in-from-top-1 duration-150">
                    {/* Separate All */}
                    <button
                        onClick={() => {
                            import("sonner").then(({ toast }) => {
                                const toastId = toast.loading("Separating stems...");
                                editor.separateStems().then(() => {
                                    toast.success("Stems separated", { id: toastId, description: "Click a stem below to extract it" });
                                }).catch(() => {
                                    toast.error("Separation failed", { id: toastId });
                                });
                            });
                        }}
                        disabled={editor.isSeparatingStems}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-purple-400 hover:bg-purple-500/10 transition-colors cursor-pointer disabled:opacity-40"
                    >
                        <Layers className="h-3.5 w-3.5" />
                        {editor.isSeparatingStems ? "Separating..." : "Analyze Stems"}
                    </button>

                    <div className="h-px bg-[oklch(1_0_0/0.06)] my-1" />

                    {/* Extract individual stems */}
                    {STEM_ITEMS.map(s => (
                        <button
                            key={s.type}
                            onClick={() => {
                                import("sonner").then(({ toast }) => {
                                    const toastId = toast.loading(`Extracting ${s.label}...`);
                                    editor.extractStem(s.type).then(() => {
                                        toast.success(`${s.label} extracted`, { id: toastId, description: "Buffer replaced with stem audio" });
                                        setOpen(false);
                                    }).catch(() => {
                                        toast.error(`Failed to extract ${s.label}`, { id: toastId });
                                    });
                                });
                            }}
                            disabled={editor.isSeparatingStems}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-[oklch(1_0_0/0.6)] hover:bg-[oklch(1_0_0/0.05)] transition-colors cursor-pointer disabled:opacity-40"
                        >
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                            Extract {s.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Editor Settings Modal
// ═══════════════════════════════════════════════════════════════════════════

function EditorSettingsModal({ onClose }: { onClose: () => void }) {
    const s = useDAWSettings();
    const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [audioPermission, setAudioPermission] = useState<"prompt" | "granted" | "denied">("prompt");
    const [tab, setTab] = useState<"audio" | "display">("audio");

    useEffect(() => {
        (async () => {
            try {
                const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
                if (status.state === "granted") {
                    setAudioPermission("granted");
                    setAudioDevices(await enumerateAudioOutputs());
                    setInputDevices(await enumerateAudioInputs());
                } else if (status.state === "denied") {
                    setAudioPermission("denied");
                } else {
                    setAudioPermission("prompt");
                    setAudioDevices(await enumerateAudioOutputs());
                }
            } catch {
                setAudioDevices(await enumerateAudioOutputs());
            }
        })();
    }, []);

    const handleRequestPermission = useCallback(async () => {
        const result = await requestAudioPermission();
        setAudioPermission(result);
        if (result === "granted") {
            setAudioDevices(await enumerateAudioOutputs());
            setInputDevices(await enumerateAudioInputs());
        }
    }, []);

    const handleOutputChange = useCallback(async (deviceId: string) => {
        s.update({ audioOutputDeviceId: deviceId });
        const audios = document.querySelectorAll("audio");
        for (const audio of audios) {
            if ("setSinkId" in audio) {
                try {
                    await (audio as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId);
                } catch { /* not supported */ }
            }
        }
    }, [s]);

    const tabs = [
        { id: "audio" as const, label: "Audio", icon: Volume2 },
        { id: "display" as const, label: "Display", icon: Settings },
    ];

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-[500px] max-h-[70vh] bg-[oklch(0.14_0.01_260)] border border-[oklch(1_0_0/0.1)] rounded-xl shadow-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-[oklch(1_0_0/0.08)]">
                    <div className="flex items-center gap-2">
                        <Settings className="h-4 w-4 text-[oklch(1_0_0/0.3)]" />
                        <h2 className="text-sm font-medium text-[oklch(1_0_0/0.8)]">Editor Settings</h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-6 h-6 rounded flex items-center justify-center text-[oklch(1_0_0/0.3)] hover:text-[oklch(1_0_0/0.6)] hover:bg-[oklch(1_0_0/0.05)]"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Tab bar */}
                <div className="flex border-b border-[oklch(1_0_0/0.08)] px-2">
                    {tabs.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "flex items-center gap-1.5 px-3 h-9 text-xs transition-colors",
                                tab === t.id ? "text-[oklch(1_0_0/0.8)] border-b-2 border-[oklch(0.62_0.19_250)]" : "text-[oklch(1_0_0/0.3)]"
                            )}
                        >
                            <t.icon className="h-3 w-3" />
                            {t.label}
                        </button>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {tab === "audio" && (
                        <>
                            <EditorSettingsSection title="Audio Output">
                                <EditorSettingsRow label="Output Device" description="Select audio playback device">
                                    {audioPermission !== "granted" ? (
                                        <button
                                            onClick={handleRequestPermission}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium bg-[oklch(0.62_0.19_250/0.2)] border border-[oklch(0.62_0.19_250/0.3)] text-[oklch(0.75_0.15_250)] hover:bg-[oklch(0.62_0.19_250/0.3)] transition-colors cursor-pointer"
                                        >
                                            <Volume2 className="w-3 h-3" />
                                            Grant Permission
                                        </button>
                                    ) : (
                                        <select
                                            value={s.audioOutputDeviceId}
                                            onChange={(e) => handleOutputChange(e.target.value)}
                                            className="h-7 bg-black/30 border border-[oklch(1_0_0/0.1)] rounded text-xs px-2 text-[oklch(1_0_0/0.6)] focus:outline-none min-w-[180px]"
                                        >
                                            {audioDevices.length === 0 && (
                                                <option value="default">Default</option>
                                            )}
                                            {audioDevices.map(d => (
                                                <option key={d.deviceId} value={d.deviceId}>
                                                    {d.label || `Output ${d.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </EditorSettingsRow>
                            </EditorSettingsSection>

                            <EditorSettingsSection title="Audio Input">
                                <EditorSettingsRow label="Input Device" description="Microphone / line input for voice processor">
                                    {audioPermission !== "granted" ? (
                                        <button
                                            onClick={handleRequestPermission}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-medium bg-[oklch(0.62_0.19_250/0.2)] border border-[oklch(0.62_0.19_250/0.3)] text-[oklch(0.75_0.15_250)] hover:bg-[oklch(0.62_0.19_250/0.3)] transition-colors cursor-pointer"
                                        >
                                            <Mic className="w-3 h-3" />
                                            Grant Permission
                                        </button>
                                    ) : (
                                        <select
                                            value={s.audioInputDeviceId}
                                            onChange={(e) => s.update({ audioInputDeviceId: e.target.value })}
                                            className="h-7 bg-black/30 border border-[oklch(1_0_0/0.1)] rounded text-xs px-2 text-[oklch(1_0_0/0.6)] focus:outline-none min-w-[180px]"
                                        >
                                            {inputDevices.length === 0 && (
                                                <option value="default">Default</option>
                                            )}
                                            {inputDevices.map(d => (
                                                <option key={d.deviceId} value={d.deviceId}>
                                                    {d.label || `Input ${d.deviceId.slice(0, 8)}`}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </EditorSettingsRow>
                            </EditorSettingsSection>
                        </>
                    )}

                    {tab === "display" && (
                        <>
                            <EditorSettingsSection title="Waveform">
                                <EditorSettingsRow label="Waveform Color" description="Color of the waveform display">
                                    <div className="flex items-center gap-1.5">
                                        {(Object.keys(EDITOR_WAVEFORM_COLORS) as EditorWaveformColor[]).map(c => (
                                            <button
                                                key={c}
                                                onClick={() => s.update({ editorWaveformColor: c })}
                                                className={cn(
                                                    "w-5 h-5 rounded-full border-2 transition-all",
                                                    s.editorWaveformColor === c ? "border-white/60 scale-110" : "border-white/10 hover:border-white/30"
                                                )}
                                                style={{ background: EDITOR_WAVEFORM_COLORS[c] }}
                                                title={c}
                                            />
                                        ))}
                                    </div>
                                </EditorSettingsRow>
                                <EditorSettingsRow label="Show RMS Overlay" description="Display RMS energy alongside peaks">
                                    <EditorToggle checked={s.editorShowRms} onChange={(v) => s.update({ editorShowRms: v })} />
                                </EditorSettingsRow>
                                <EditorSettingsRow label="Show Grid Lines" description="Time grid lines in waveform view">
                                    <EditorToggle checked={s.editorShowGridLines} onChange={(v) => s.update({ editorShowGridLines: v })} />
                                </EditorSettingsRow>
                                <EditorSettingsRow label="Show Minimap" description="Overview minimap below waveform">
                                    <EditorToggle checked={s.editorShowMinimap} onChange={(v) => s.update({ editorShowMinimap: v })} />
                                </EditorSettingsRow>
                            </EditorSettingsSection>

                            <EditorSettingsSection title="Spectrogram">
                                <EditorSettingsRow label="Color Map" description="Spectrogram color scheme">
                                    <select
                                        value={s.spectrogramColorMap}
                                        onChange={(e) => s.update({ spectrogramColorMap: e.target.value as SpectrogramColorMap })}
                                        className="h-7 bg-black/30 border border-[oklch(1_0_0/0.1)] rounded text-xs px-2 text-[oklch(1_0_0/0.6)] focus:outline-none"
                                    >
                                        <option value="magma">Magma</option>
                                        <option value="viridis">Viridis</option>
                                        <option value="inferno">Inferno</option>
                                        <option value="plasma">Plasma</option>
                                        <option value="grayscale">Grayscale</option>
                                    </select>
                                </EditorSettingsRow>
                                <EditorSettingsRow label="FFT Size" description="Frequency resolution">
                                    <select
                                        value={s.spectrogramFftSize}
                                        onChange={(e) => s.update({ spectrogramFftSize: parseInt(e.target.value) })}
                                        className="h-7 bg-black/30 border border-[oklch(1_0_0/0.1)] rounded text-xs px-2 text-[oklch(1_0_0/0.6)] focus:outline-none"
                                    >
                                        <option value="512">512 (fast)</option>
                                        <option value="1024">1024</option>
                                        <option value="2048">2048 (balanced)</option>
                                        <option value="4096">4096 (detailed)</option>
                                    </select>
                                </EditorSettingsRow>
                            </EditorSettingsSection>

                            <EditorSettingsSection title="Status Bar Stats">
                                <p className="text-[9px] text-[oklch(1_0_0/0.2)] -mt-1 mb-2">Choose which performance metrics to display in the info bar</p>
                                {([
                                    { key: "showFps" as const, label: "FPS", desc: "Frame rate counter" },
                                    { key: "showHeapMemory" as const, label: "Heap Memory", desc: "JS heap used (MB)" },
                                    { key: "showJsHeapTotal" as const, label: "JS Heap Total", desc: "Total JS heap allocated" },
                                    { key: "showDomNodes" as const, label: "DOM Nodes", desc: "Number of DOM elements" },
                                    { key: "showAudioLatency" as const, label: "Audio Latency", desc: "Audio context latency (ms)" },
                                    { key: "showCpuCores" as const, label: "CPU Cores", desc: "Hardware concurrency" },
                                    { key: "showDeviceMemory" as const, label: "Device Memory", desc: "Approximate device RAM" },
                                ] as const).map(item => (
                                    <EditorSettingsRow key={item.key} label={item.label} description={item.desc}>
                                        <EditorToggle
                                            checked={s.editorStatusBarStats[item.key]}
                                            onChange={(v) => s.update({ editorStatusBarStats: { ...s.editorStatusBarStats, [item.key]: v } })}
                                        />
                                    </EditorSettingsRow>
                                ))}
                            </EditorSettingsSection>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function EditorSettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div>
            <h3 className="text-[10px] text-[oklch(1_0_0/0.3)] uppercase tracking-wider mb-2">{title}</h3>
            <div className="space-y-2 pl-1">{children}</div>
        </div>
    );
}

function EditorSettingsRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between py-1">
            <div>
                <p className="text-[11px] text-[oklch(1_0_0/0.6)]">{label}</p>
                <p className="text-[9px] text-[oklch(1_0_0/0.2)]">{description}</p>
            </div>
            {children}
        </div>
    );
}

function EditorToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            onClick={() => onChange(!checked)}
            className={cn(
                "w-8 h-4 rounded-full transition-colors relative",
                checked ? "bg-[oklch(0.62_0.19_250)]" : "bg-[oklch(1_0_0/0.1)]"
            )}
        >
            <div
                className={cn(
                    "w-3 h-3 bg-white rounded-full absolute top-0.5 transition-transform",
                    checked ? "translate-x-4" : "translate-x-0.5"
                )}
            />
        </button>
    );
}
