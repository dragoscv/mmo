"use client";

import { useState, useRef, useEffect } from "react";
import { useDAW } from "./daw-context";
import {
    MousePointer2, Pencil, Eraser, Scissors, VolumeX, TrendingUp,
    FolderOpen, Save, FilePlus, Settings, Undo2, Redo2, Download,
    LayoutGrid, Piano, Drum, Plug, Waves, Maximize, Minimize,
    PanelLeft, AudioWaveform,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ToolMode, SnapValue } from "@/lib/daw-engine";

const TOOLS: { mode: ToolMode; icon: typeof MousePointer2; label: string; shortcut: string }[] = [
    { mode: "select", icon: MousePointer2, label: "Select", shortcut: "V" },
    { mode: "draw", icon: Pencil, label: "Draw", shortcut: "D" },
    { mode: "erase", icon: Eraser, label: "Erase", shortcut: "E" },
    { mode: "slice", icon: Scissors, label: "Slice", shortcut: "C" },
    { mode: "mute", icon: VolumeX, label: "Mute", shortcut: "M" },
    { mode: "automation", icon: TrendingUp, label: "Automation", shortcut: "A" },
];

const SNAPS: { value: SnapValue; label: string }[] = [
    { value: "1/1", label: "1 Bar" },
    { value: "1/2", label: "1/2" },
    { value: "1/4", label: "1/4" },
    { value: "1/8", label: "1/8" },
    { value: "1/16", label: "1/16" },
    { value: "1/32", label: "1/32" },
    { value: "none", label: "Off" },
];

export function DAWToolbar() {
    const daw = useDAW();

    return (
        <TooltipProvider delayDuration={200}>
            <div className="h-11 bg-[var(--daw-surface)] border-b border-[var(--daw-border)] flex items-center px-2.5 gap-1 daw-animate-in">
                {/* Project actions */}
                <ToolGroup>
                    <ToolBtn icon={FilePlus} label="New Project" onClick={() => daw.setProjectModal(true)} />
                    <ToolBtn icon={FolderOpen} label="Open Project" onClick={() => daw.setProjectModal(true)} />
                    <ToolBtn
                        icon={Save}
                        label="Save (Ctrl+S)"
                        onClick={daw.saveCurrentProject}
                        active={daw.isDirty}
                        glow={daw.isDirty}
                    />
                    <ToolBtn icon={Download} label="Export (Ctrl+Shift+E)" onClick={() => daw.setExportModal(true)} />
                </ToolGroup>

                <Divider />

                {/* Undo / Redo */}
                <ToolGroup>
                    <ToolBtn icon={Undo2} label="Undo (Ctrl+Z)" onClick={daw.undo} disabled={daw.undoStack.length === 0} />
                    <ToolBtn icon={Redo2} label="Redo (Ctrl+Y)" onClick={daw.redo} disabled={daw.redoStack.length === 0} />
                </ToolGroup>

                <Divider />

                {/* Tools */}
                <ToolGroup>
                    {TOOLS.map(t => (
                        <ToolBtn
                            key={t.mode}
                            icon={t.icon}
                            label={`${t.label} (${t.shortcut})`}
                            onClick={() => daw.setTool(t.mode)}
                            active={daw.tool === t.mode}
                        />
                    ))}
                </ToolGroup>

                <Divider />

                {/* Snap */}
                <div className="flex items-center gap-1.5 mx-1">
                    <span className="text-[10px] text-[var(--daw-text-dim)] uppercase tracking-widest">Snap</span>
                    <select
                        value={daw.snap}
                        onChange={e => daw.setSnap(e.target.value as SnapValue)}
                        className="daw-select h-7"
                    >
                        {SNAPS.map(s => (
                            <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                    </select>
                </div>

                <Divider />

                {/* Zoom */}
                <div className="flex items-center gap-1.5 mx-1">
                    <span className="text-[10px] text-[var(--daw-text-dim)] uppercase tracking-widest">Zoom</span>
                    <input
                        type="range"
                        min={10}
                        max={200}
                        value={daw.zoom}
                        onChange={e => daw.setZoom(Number(e.target.value))}
                        className="daw-slider daw-slider-accent w-20"
                    />
                    <span className="text-[10px] text-[var(--daw-text-dim)] w-8 font-mono tabular-nums">{daw.zoom}px</span>
                </div>

                <div className="flex-1" />

                {/* Panel toggles */}
                <ToolGroup>
                    <ToolBtn icon={PanelLeft} label="Browser (F1)" onClick={() => daw.togglePanel("browser")} active={daw.showBrowser} />
                    <ToolBtn icon={LayoutGrid} label="Mixer (F2)" onClick={() => daw.togglePanel("mixer")} active={daw.showMixer} />
                    <ToolBtn icon={Piano} label="Piano Roll (F3)" onClick={() => daw.togglePanel("pianoRoll")} active={daw.showPianoRoll} />
                    <ToolBtn icon={Drum} label="Step Seq (F4)" onClick={() => daw.togglePanel("stepSequencer")} active={daw.showStepSequencer} />
                    <ToolBtn icon={Plug} label="Effects (F5)" onClick={() => daw.togglePanel("effectsRack")} active={daw.showEffectsRack} />
                    <ToolBtn icon={Waves} label="Synth (F6)" onClick={() => daw.togglePanel("synth")} active={daw.showSynth} />
                    <ToolBtn icon={AudioWaveform} label="Automation (F7)" onClick={() => daw.togglePanel("automation")} active={daw.showAutomation} />
                </ToolGroup>

                <Divider />

                <ToolBtn
                    icon={daw.focusMode ? Minimize : Maximize}
                    label={`Focus Mode (F11)`}
                    onClick={daw.toggleFocusMode}
                    active={daw.focusMode}
                />
                <ToolBtn icon={Settings} label="Settings" onClick={() => daw.setSettingsModal(true)} />

                {/* Project name */}
                <ProjectName />
            </div>
        </TooltipProvider>
    );
}

// ─── Primitives ──────────────────────────────────────────────────────────

function ToolGroup({ children }: { children: React.ReactNode }) {
    return <div className="flex items-center gap-0.5">{children}</div>;
}

function Divider() {
    return <div className="w-px h-5 bg-[var(--daw-border)] mx-1" />;
}

function ToolBtn({ icon: Icon, label, onClick, active, disabled, glow }: {
    icon: typeof MousePointer2;
    label: string;
    onClick: () => void;
    active?: boolean;
    disabled?: boolean;
    glow?: boolean;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    onClick={onClick}
                    disabled={disabled}
                    className={cn(
                        "daw-btn h-7 w-7",
                        active
                            ? "daw-btn-active"
                            : "text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]",
                        disabled && "opacity-25 !cursor-not-allowed",
                        glow && "shadow-[0_0_8px_var(--daw-accent-glow)]"
                    )}
                >
                    <Icon className="h-3.5 w-3.5" />
                </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
                {label}
            </TooltipContent>
        </Tooltip>
    );
}

function ProjectName() {
    const daw = useDAW();
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(daw.project.name);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setName(daw.project.name); }, [daw.project.name]);
    useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

    const commit = () => {
        const trimmed = name.trim();
        if (trimmed && trimmed !== daw.project.name) daw.renameProject(trimmed);
        setEditing(false);
    };

    if (editing) {
        return (
            <input
                ref={inputRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onBlur={commit}
                onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setName(daw.project.name); setEditing(false); } }}
                className="daw-input ml-2 w-[180px] h-7 px-2 text-xs"
                autoFocus
            />
        );
    }

    return (
        <div
            className="ml-2 flex items-center gap-2 cursor-pointer group px-2 py-1 rounded-md hover:bg-[oklch(1_0_0/3%)] transition-colors"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
        >
            <span className="text-xs text-[var(--daw-text-muted)] max-w-[200px] truncate group-hover:text-[var(--daw-text)] transition-colors font-medium">
                {daw.project.name}
            </span>
            {daw.isDirty && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
        </div>
    );
}
