"use client";

import { useCallback, useEffect, useState } from "react";
import { useDAW } from "./daw-context";
import { getDockviewApi, PANEL_IDS } from "./daw-dockview";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
    Eye,
    EyeOff,
    PanelTop,
    PanelBottom,
    Crosshair,
    RotateCcw,
    LayoutDashboard,
    Piano,
    Drum,
    Plug,
    Waves,
    AudioLines,
    PanelLeft,
    LayoutGrid,
    AudioWaveform,
    Clock,
    Clipboard,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// ═══════════════════════════════════════════════════════════════════════════
// Panel definitions
// ═══════════════════════════════════════════════════════════════════════════

type PanelName = "browser" | "mixer" | "pianoRoll" | "stepSequencer" | "effectsRack" | "synth" | "automation" | "history" | "clipboard";

interface PanelDef {
    id: string;
    name: PanelName;
    label: string;
    icon: typeof Piano;
    shortcut: string;
    stateKey: string;
}

const PANELS: PanelDef[] = [
    { id: PANEL_IDS.timeline, name: "browser" as PanelName, label: "Timeline", icon: AudioLines, shortcut: "—", stateKey: "" },
    { id: PANEL_IDS.browser, name: "browser", label: "Browser", icon: PanelLeft, shortcut: "F1", stateKey: "showBrowser" },
    { id: PANEL_IDS.mixer, name: "mixer", label: "Mixer", icon: LayoutGrid, shortcut: "F2", stateKey: "showMixer" },
    { id: PANEL_IDS.pianoRoll, name: "pianoRoll", label: "Piano Roll", icon: Piano, shortcut: "F3", stateKey: "showPianoRoll" },
    { id: PANEL_IDS.stepSequencer, name: "stepSequencer", label: "Step Sequencer", icon: Drum, shortcut: "F4", stateKey: "showStepSequencer" },
    { id: PANEL_IDS.effectsRack, name: "effectsRack", label: "Effects Rack", icon: Plug, shortcut: "F5", stateKey: "showEffectsRack" },
    { id: PANEL_IDS.synthesizer, name: "synth", label: "Synthesizer", icon: Waves, shortcut: "F6", stateKey: "showSynth" },
    { id: PANEL_IDS.history, name: "history", label: "History", icon: Clock, shortcut: "F8", stateKey: "showHistory" },
    { id: PANEL_IDS.clipboard, name: "clipboard", label: "Clipboard", icon: Clipboard, shortcut: "F9", stateKey: "showClipboard" },
];

// Automation doesn't have a dockview panel, it's a toolbar toggle
const AUTOMATION_PANEL: PanelDef = {
    id: "automation",
    name: "automation",
    label: "Automation",
    icon: AudioWaveform,
    shortcut: "F7",
    stateKey: "showAutomation",
};

// ═══════════════════════════════════════════════════════════════════════════
// Panel status helpers
// ═══════════════════════════════════════════════════════════════════════════

type PanelStatus = "hidden" | "docked" | "floating" | "always";

function getPanelStatus(panelId: string): PanelStatus {
    if (panelId === PANEL_IDS.timeline) return "always";

    const api = getDockviewApi();
    if (!api) return "hidden";

    const panel = api.getPanel(panelId);
    if (!panel) return "hidden";

    try {
        const loc = panel.api.location;
        if (loc.type === "floating") return "floating";
        return "docked";
    } catch {
        return "docked";
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Panel Manager Popover
// ═══════════════════════════════════════════════════════════════════════════

export function DAWPanelManager() {
    const daw = useDAW();
    const [open, setOpen] = useState(false);
    const [, setTick] = useState(0);

    // Re-render when popover opens to get fresh panel statuses
    useEffect(() => {
        if (!open) return;
        const iv = setInterval(() => setTick(t => t + 1), 500);
        return () => clearInterval(iv);
    }, [open]);

    const isVisible = useCallback((def: PanelDef): boolean => {
        if (def.id === PANEL_IDS.timeline) return true;
        if (def.id === "automation") return daw.showAutomation;
        const key = def.stateKey as keyof typeof daw;
        return Boolean(daw[key]);
    }, [daw]);

    const toggleVisibility = useCallback((def: PanelDef) => {
        if (def.id === PANEL_IDS.timeline) return;
        daw.togglePanel(def.name);
    }, [daw]);

    const focusPanel = useCallback((panelId: string) => {
        const api = getDockviewApi();
        if (!api) return;
        const panel = api.getPanel(panelId);
        if (panel) {
            panel.api.setActive();
            setOpen(false);
        }
    }, []);

    const floatPanel = useCallback((panelId: string) => {
        const api = getDockviewApi();
        if (!api) return;
        const panel = api.getPanel(panelId);
        if (!panel) return;

        const loc = panel.api.location;
        if (loc.type === "floating") {
            // Dock it next to timeline
            const timelinePanel = api.getPanel(PANEL_IDS.timeline);
            if (timelinePanel) {
                panel.api.moveTo({ group: timelinePanel.group, position: "center" });
            }
        } else {
            api.addFloatingGroup(panel, { width: 500, height: 400 });
        }
    }, []);

    const resetLayout = useCallback(() => {
        localStorage.removeItem("daw_dockview_layout");
        window.location.reload();
    }, []);

    const allPanels = [...PANELS, AUTOMATION_PANEL];

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <TooltipProvider delayDuration={200}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                            <button
                                className={cn(
                                    "daw-btn h-7 w-7",
                                    open
                                        ? "daw-btn-active"
                                        : "text-[var(--daw-text-dim)] hover:text-[var(--daw-text-muted)]"
                                )}
                            >
                                <LayoutDashboard className="h-3.5 w-3.5" />
                            </button>
                        </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                        Panel Manager
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <PopoverContent
                side="bottom"
                align="end"
                sideOffset={6}
                className="daw-panel-manager w-72 p-0"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--daw-border)]">
                    <span className="text-[11px] font-semibold text-[var(--daw-text)] uppercase tracking-wider">
                        Panels & Views
                    </span>
                    <button
                        onClick={resetLayout}
                        className="text-[10px] text-[var(--daw-text-dim)] hover:text-[var(--daw-accent)] transition-colors flex items-center gap-1"
                    >
                        <RotateCcw className="h-3 w-3" />
                        Reset
                    </button>
                </div>

                {/* Panel list */}
                <div className="py-1">
                    {allPanels.map(def => {
                        const visible = isVisible(def);
                        const status = def.id === "automation"
                            ? (daw.showAutomation ? "docked" : "hidden")
                            : getPanelStatus(def.id);
                        const isTimeline = def.id === PANEL_IDS.timeline;
                        const isAutomation = def.id === "automation";
                        const Icon = def.icon;

                        return (
                            <div
                                key={def.id}
                                className={cn(
                                    "flex items-center gap-2 px-3 py-1.5 group transition-colors",
                                    visible
                                        ? "hover:bg-[var(--daw-surface-2)]"
                                        : "opacity-50 hover:opacity-75 hover:bg-[var(--daw-surface-2)]"
                                )}
                            >
                                {/* Icon */}
                                <Icon className={cn(
                                    "h-3.5 w-3.5 shrink-0",
                                    visible ? "text-[var(--daw-accent)]" : "text-[var(--daw-text-dim)]"
                                )} />

                                {/* Name + Shortcut */}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className={cn(
                                            "text-[11px] truncate",
                                            visible ? "text-[var(--daw-text)]" : "text-[var(--daw-text-dim)]"
                                        )}>
                                            {def.label}
                                        </span>
                                        <span className="text-[9px] text-[var(--daw-text-dim)] font-mono ml-auto shrink-0">
                                            {def.shortcut}
                                        </span>
                                    </div>
                                </div>

                                {/* Status badge */}
                                <span className={cn(
                                    "text-[8px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded shrink-0",
                                    status === "always" && "bg-[var(--daw-accent)]/20 text-[var(--daw-accent)]",
                                    status === "docked" && "bg-emerald-500/20 text-emerald-400",
                                    status === "floating" && "bg-purple-500/20 text-purple-400",
                                    status === "hidden" && "bg-[var(--daw-surface-2)] text-[var(--daw-text-dim)]",
                                )}>
                                    {status}
                                </span>

                                {/* Actions */}
                                <div className="flex items-center gap-0.5 shrink-0">
                                    {/* Toggle visibility */}
                                    {!isTimeline && (
                                        <ActionBtn
                                            icon={visible ? Eye : EyeOff}
                                            label={visible ? "Hide" : "Show"}
                                            onClick={() => toggleVisibility(def)}
                                            active={visible}
                                        />
                                    )}

                                    {/* Float / Dock */}
                                    {!isTimeline && !isAutomation && visible && (
                                        <ActionBtn
                                            icon={status === "floating" ? PanelBottom : PanelTop}
                                            label={status === "floating" ? "Dock" : "Float"}
                                            onClick={() => floatPanel(def.id)}
                                        />
                                    )}

                                    {/* Focus */}
                                    {!isAutomation && visible && (
                                        <ActionBtn
                                            icon={Crosshair}
                                            label="Focus"
                                            onClick={() => focusPanel(def.id)}
                                        />
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>

                {/* Footer */}
                <div className="px-3 py-1.5 border-t border-[var(--daw-border)] flex items-center justify-between">
                    <span className="text-[9px] text-[var(--daw-text-dim)]">
                        {allPanels.filter(d => isVisible(d)).length} / {allPanels.length} visible
                    </span>
                    <span className="text-[9px] text-[var(--daw-text-dim)]">
                        Drag tabs to rearrange
                    </span>
                </div>
            </PopoverContent>
        </Popover>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// Small action button
// ═══════════════════════════════════════════════════════════════════════════

function ActionBtn({
    icon: Icon,
    label,
    onClick,
    active,
}: {
    icon: typeof Eye;
    label: string;
    onClick: () => void;
    active?: boolean;
}) {
    return (
        <TooltipProvider delayDuration={150}>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        onClick={onClick}
                        className={cn(
                            "h-5 w-5 flex items-center justify-center rounded transition-colors",
                            "opacity-0 group-hover:opacity-100",
                            active
                                ? "text-[var(--daw-accent)] hover:bg-[var(--daw-accent)]/20"
                                : "text-[var(--daw-text-dim)] hover:text-[var(--daw-text)] hover:bg-[var(--daw-surface-2)]"
                        )}
                    >
                        <Icon className="h-3 w-3" />
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[10px] px-1.5 py-0.5">
                    {label}
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
}
