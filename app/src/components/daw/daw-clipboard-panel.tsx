"use client";

import {
    type ClipboardState,
    type ClipboardEntry,
    getActiveEntry,
    getTypeLabel,
    getTypeIcon,
} from "@/lib/clipboard-manager";
import { cn } from "@/lib/utils";
import {
    Clipboard, Pin, PinOff, Trash2, X,
    Layers, Music, AudioWaveform, Waves, TrendingUp,
    ClipboardPaste,
} from "lucide-react";

const ICON_MAP: Record<string, typeof Layers> = {
    Layers, Music, AudioWaveform, Waves, TrendingUp,
};

function getIcon(hint: string) {
    return ICON_MAP[hint] || Clipboard;
}

// ═══════════════════════════════════════════════════════════════════════════
// Clipboard Panel — multi-item clipboard with management
// ═══════════════════════════════════════════════════════════════════════════

interface ClipboardPanelProps {
    clipboard: ClipboardState;
    onSetActive: (index: number) => void;
    onRemove: (id: string) => void;
    onTogglePin: (id: string) => void;
    onClear: () => void;
    onPaste?: () => void;
    className?: string;
    compact?: boolean;
}

export function ClipboardPanel({
    clipboard,
    onSetActive,
    onRemove,
    onTogglePin,
    onClear,
    onPaste,
    className,
    compact = false,
}: ClipboardPanelProps) {
    const { entries, activeIndex } = clipboard;

    const timeFormat = (ts: number) => {
        const diff = Date.now() - ts;
        if (diff < 60_000) return "just now";
        if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
        return `${Math.floor(diff / 3_600_000)}h ago`;
    };

    return (
        <div className={cn(
            "flex flex-col h-full bg-[var(--daw-surface,oklch(0.14_0.01_260))]",
            "text-[var(--daw-text,oklch(0.95_0.01_260))]",
            className,
        )}>
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--daw-border,oklch(1_0_0/0.08))]">
                <Clipboard className="h-3.5 w-3.5 text-[var(--daw-text-dim,oklch(1_0_0/0.3))]" />
                <span className="text-xs font-medium flex-1">Clipboard</span>
                <span className="text-[10px] font-mono text-[var(--daw-text-dim,oklch(1_0_0/0.3))]">
                    {entries.length} items
                </span>
                {entries.length > 0 && (
                    <button
                        onClick={onClear}
                        className="h-5 px-1.5 flex items-center gap-1 rounded text-[9px] hover:bg-[oklch(0.6_0.2_25/0.15)] text-[oklch(0.6_0.2_25)] transition-colors"
                        title="Clear all unpinned"
                    >
                        <X className="h-2.5 w-2.5" />
                        Clear
                    </button>
                )}
            </div>

            {/* Entry list */}
            <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
                {entries.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--daw-text-dim,oklch(1_0_0/0.2))]">
                        <Clipboard className="h-8 w-8 opacity-30" />
                        <span className="text-[11px]">Clipboard is empty</span>
                        <span className="text-[9px]">Copy clips, notes, or tracks with Ctrl+C</span>
                    </div>
                )}

                {entries.map((entry, i) => {
                    const iconHint = getTypeIcon(entry.type);
                    const Icon = getIcon(iconHint);
                    const isActive = i === activeIndex;

                    return (
                        <div
                            key={entry.id}
                            onClick={() => onSetActive(i)}
                            className={cn(
                                "group flex items-center gap-2 px-3 cursor-pointer transition-all",
                                compact ? "py-1.5" : "py-2",
                                "hover:bg-[var(--daw-hover,oklch(1_0_0/0.05))]",
                                isActive && "bg-[oklch(0.62_0.19_250/0.1)] border-l-2 border-l-[oklch(0.62_0.19_250)]",
                                !isActive && "border-l-2 border-l-transparent",
                            )}
                        >
                            {/* Type icon */}
                            <div className={cn(
                                "h-7 w-7 rounded flex items-center justify-center shrink-0",
                                isActive
                                    ? "bg-[oklch(0.62_0.19_250/0.15)]"
                                    : "bg-[var(--daw-hover,oklch(1_0_0/0.04))]",
                            )}>
                                <Icon className={cn(
                                    "h-3.5 w-3.5",
                                    isActive ? "text-[oklch(0.62_0.19_250)]" : "text-[var(--daw-text-dim,oklch(1_0_0/0.3))]",
                                )} />
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className={cn(
                                        "text-[11px] truncate",
                                        isActive && "font-medium text-[oklch(0.62_0.19_250)]",
                                    )}>
                                        {entry.label}
                                    </span>
                                    {entry.pinned && (
                                        <Pin className="h-2.5 w-2.5 text-[oklch(0.75_0.15_84)] shrink-0" />
                                    )}
                                </div>
                                {!compact && (
                                    <div className="flex items-center gap-2 text-[9px] text-[var(--daw-text-dim,oklch(1_0_0/0.2))]">
                                        <span>{getTypeLabel(entry.type)}</span>
                                        <span>·</span>
                                        <span>{entry.description}</span>
                                        <span>·</span>
                                        <span>{timeFormat(entry.timestamp)}</span>
                                    </div>
                                )}
                                {/* Preview info */}
                                {entry.preview && !compact && (
                                    <div className="flex items-center gap-2 mt-0.5 text-[9px] text-[var(--daw-text-dim,oklch(1_0_0/0.15))]">
                                        {entry.preview.clipCount !== undefined && (
                                            <span>{entry.preview.clipCount} clip(s)</span>
                                        )}
                                        {entry.preview.noteCount !== undefined && (
                                            <span>{entry.preview.noteCount} note(s)</span>
                                        )}
                                        {entry.preview.duration !== undefined && (
                                            <span>{entry.preview.duration.toFixed(2)}s</span>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Actions (visible on hover) */}
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                {isActive && onPaste && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onPaste(); }}
                                        className="h-5 w-5 flex items-center justify-center rounded hover:bg-[oklch(0.62_0.19_250/0.2)] text-[oklch(0.62_0.19_250)] transition-colors"
                                        title="Paste"
                                    >
                                        <ClipboardPaste className="h-3 w-3" />
                                    </button>
                                )}
                                <button
                                    onClick={(e) => { e.stopPropagation(); onTogglePin(entry.id); }}
                                    className="h-5 w-5 flex items-center justify-center rounded hover:bg-[var(--daw-hover,oklch(1_0_0/0.08))] transition-colors"
                                    title={entry.pinned ? "Unpin" : "Pin"}
                                >
                                    {entry.pinned
                                        ? <PinOff className="h-3 w-3 text-[oklch(0.75_0.15_84)]" />
                                        : <Pin className="h-3 w-3" />}
                                </button>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
                                    className="h-5 w-5 flex items-center justify-center rounded hover:bg-[oklch(0.6_0.2_25/0.15)] text-[oklch(0.6_0.2_25)] transition-colors"
                                    title="Remove"
                                >
                                    <Trash2 className="h-3 w-3" />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 border-t border-[var(--daw-border,oklch(1_0_0/0.08))] text-[9px] text-[var(--daw-text-dim,oklch(1_0_0/0.2))]">
                {activeIndex >= 0 && entries[activeIndex]
                    ? `Active: "${entries[activeIndex].label}" — Ctrl+V to paste`
                    : "No item selected"}
            </div>
        </div>
    );
}
