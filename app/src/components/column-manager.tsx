"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Settings2, Check, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ColumnDef {
    key: string;
    label: string;
    defaultVisible: boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
    { key: "index", label: "#", defaultVisible: true },
    { key: "play", label: "Play", defaultVisible: true },
    { key: "artwork", label: "Artwork", defaultVisible: true },
    { key: "artist", label: "Artist", defaultVisible: true },
    { key: "title", label: "Title", defaultVisible: true },
    { key: "album", label: "Album", defaultVisible: false },
    { key: "bpm", label: "BPM", defaultVisible: true },
    { key: "key", label: "Key", defaultVisible: true },
    { key: "genre", label: "Genre", defaultVisible: true },
    { key: "energy", label: "Energy", defaultVisible: true },
    { key: "rating", label: "Rating", defaultVisible: true },
    { key: "duration", label: "Time", defaultVisible: true },
    { key: "label", label: "Label", defaultVisible: false },
    { key: "format", label: "Format", defaultVisible: false },
    { key: "bitrate", label: "Bitrate", defaultVisible: false },
    { key: "addedAt", label: "Added", defaultVisible: false },
    { key: "favorites", label: "Favorite", defaultVisible: false },
    { key: "tags", label: "Tags", defaultVisible: false },
    { key: "color", label: "Color", defaultVisible: false },
    { key: "sampleRate", label: "Sample Rate", defaultVisible: false },
    { key: "year", label: "Year", defaultVisible: false },
    { key: "remove", label: "Remove", defaultVisible: true },
];

/** The default ordered list of visible column keys */
function getDefaultOrderedColumns(): string[] {
    return ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
}

/** Load ordered column keys from localStorage */
function loadColumns(storageKey: string): string[] {
    if (typeof window === "undefined") return getDefaultOrderedColumns();
    try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
            const parsed = JSON.parse(saved) as string[];
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch {
        // ignore
    }
    return getDefaultOrderedColumns();
}

function saveColumns(storageKey: string, columns: string[]) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(columns));
    } catch {
        // ignore
    }
}

export function useColumnConfig(storageKey: string) {
    // Ordered array of visible column keys
    const [orderedColumns, setOrderedColumns] = useState<string[]>(
        () => getDefaultOrderedColumns()
    );

    useEffect(() => {
        setOrderedColumns(loadColumns(storageKey));
    }, [storageKey]);

    // Derived Set for fast lookups
    const visibleSet = new Set(orderedColumns);

    const toggleColumn = useCallback(
        (key: string) => {
            setOrderedColumns((prev) => {
                if (prev.includes(key)) {
                    if (prev.length <= 1) return prev;
                    const next = prev.filter((k) => k !== key);
                    saveColumns(storageKey, next);
                    return next;
                } else {
                    const next = [...prev, key];
                    saveColumns(storageKey, next);
                    return next;
                }
            });
        },
        [storageKey]
    );

    const isVisible = useCallback(
        (key: string) => visibleSet.has(key),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [orderedColumns]
    );

    const reorderColumns = useCallback(
        (fromIndex: number, toIndex: number) => {
            setOrderedColumns((prev) => {
                const next = [...prev];
                const [moved] = next.splice(fromIndex, 1);
                next.splice(toIndex, 0, moved);
                saveColumns(storageKey, next);
                return next;
            });
        },
        [storageKey]
    );

    const resetToDefaults = useCallback(() => {
        const defaults = getDefaultOrderedColumns();
        setOrderedColumns(defaults);
        saveColumns(storageKey, defaults);
    }, [storageKey]);

    return {
        /** Ordered array of visible column keys */
        orderedColumns,
        /** Set for backward compat */
        visibleColumns: visibleSet,
        toggleColumn,
        isVisible,
        reorderColumns,
        resetToDefaults,
    };
}

interface ColumnManagerProps {
    orderedColumns: string[];
    visibleColumns: Set<string>;
    onToggle: (key: string) => void;
    onReorder: (fromIndex: number, toIndex: number) => void;
    onReset: () => void;
    /** Which columns to show in the picker (omit to show all) */
    availableColumns?: string[];
}

export function ColumnManager({
    orderedColumns,
    visibleColumns,
    onToggle,
    onReorder,
    onReset,
    availableColumns,
}: ColumnManagerProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const dragIdx = useRef<number | null>(null);
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

    useEffect(() => {
        if (!open) return;
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [open]);

    // All available columns, preserving current order for visible ones
    const allAvailable = availableColumns
        ? ALL_COLUMNS.filter((c) => availableColumns.includes(c.key))
        : ALL_COLUMNS;

    // Split into visible (ordered) and hidden
    const visibleOrdered = orderedColumns
        .map((key) => allAvailable.find((c) => c.key === key))
        .filter(Boolean) as ColumnDef[];
    const hiddenColumns = allAvailable.filter((c) => !visibleColumns.has(c.key));

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(!open)}
                className={cn(
                    "p-1.5 rounded-md transition-colors cursor-pointer",
                    open
                        ? "bg-purple-500/20 text-purple-400"
                        : "text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]"
                )}
                title="Manage columns"
            >
                <Settings2 className="h-4 w-4" />
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xl animate-[fadeIn_150ms_ease-out] overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                        <span className="text-xs font-semibold text-[var(--muted-foreground)]">Columns</span>
                        <button
                            onClick={onReset}
                            className="text-[10px] text-purple-400 hover:text-purple-300 transition-colors cursor-pointer"
                        >
                            Reset
                        </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                        {/* Visible columns — draggable */}
                        {visibleOrdered.length > 0 && (
                            <div className="px-2 pb-1">
                                <span className="text-[10px] font-medium text-[var(--muted-foreground)] px-1 uppercase tracking-wider">
                                    Visible
                                </span>
                            </div>
                        )}
                        {visibleOrdered.map((col, idx) => (
                            <div
                                key={col.key}
                                draggable
                                onDragStart={() => { dragIdx.current = idx; }}
                                onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx); }}
                                onDrop={() => {
                                    if (dragIdx.current !== null && dragIdx.current !== idx) {
                                        onReorder(dragIdx.current, idx);
                                    }
                                    dragIdx.current = null;
                                    setDragOverIdx(null);
                                }}
                                onDragEnd={() => { dragIdx.current = null; setDragOverIdx(null); }}
                                className={cn(
                                    "flex items-center gap-1.5 w-full px-2 py-1.5 text-sm hover:bg-[var(--accent)] transition-colors rounded-md mx-1",
                                    dragOverIdx === idx && "border-t-2 border-purple-500"
                                )}
                            >
                                <GripVertical className="h-3.5 w-3.5 text-[var(--muted-foreground)]/50 shrink-0 cursor-grab active:cursor-grabbing" />
                                <button
                                    onClick={() => onToggle(col.key)}
                                    className="flex items-center gap-2 flex-1 cursor-pointer"
                                >
                                    <div className="flex h-4 w-4 items-center justify-center rounded border bg-purple-500 border-purple-500 transition-colors">
                                        <Check className="h-3 w-3 text-primary-foreground" />
                                    </div>
                                    <span className="text-[var(--foreground)]">{col.label}</span>
                                </button>
                            </div>
                        ))}

                        {/* Hidden columns */}
                        {hiddenColumns.length > 0 && (
                            <div className="px-2 pt-2 pb-1 border-t border-[var(--border)] mt-1">
                                <span className="text-[10px] font-medium text-[var(--muted-foreground)] px-1 uppercase tracking-wider">
                                    Hidden
                                </span>
                            </div>
                        )}
                        {hiddenColumns.map((col) => (
                            <button
                                key={col.key}
                                onClick={() => onToggle(col.key)}
                                className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm hover:bg-[var(--accent)] transition-colors cursor-pointer ml-1"
                            >
                                <div className="ml-5 flex h-4 w-4 items-center justify-center rounded border border-[var(--border)] transition-colors" />
                                <span className="text-[var(--muted-foreground)]">{col.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
