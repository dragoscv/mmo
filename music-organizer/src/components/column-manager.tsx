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

function getDefaultVisibleColumns(): Set<string> {
    return new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));
}

function loadColumns(storageKey: string): Set<string> {
    if (typeof window === "undefined") return getDefaultVisibleColumns();
    try {
        const saved = localStorage.getItem(storageKey);
        if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch {
        // ignore
    }
    return getDefaultVisibleColumns();
}

function saveColumns(storageKey: string, columns: Set<string>) {
    try {
        localStorage.setItem(storageKey, JSON.stringify([...columns]));
    } catch {
        // ignore
    }
}

export function useColumnConfig(storageKey: string) {
    const [visibleColumns, setVisibleColumns] = useState<Set<string>>(
        () => getDefaultVisibleColumns()
    );

    // Load from localStorage on mount
    useEffect(() => {
        setVisibleColumns(loadColumns(storageKey));
    }, [storageKey]);

    const toggleColumn = useCallback(
        (key: string) => {
            setVisibleColumns((prev) => {
                const next = new Set(prev);
                if (next.has(key)) {
                    // Don't allow hiding all columns
                    if (next.size <= 1) return prev;
                    next.delete(key);
                } else {
                    next.add(key);
                }
                saveColumns(storageKey, next);
                return next;
            });
        },
        [storageKey]
    );

    const isVisible = useCallback(
        (key: string) => visibleColumns.has(key),
        [visibleColumns]
    );

    const resetToDefaults = useCallback(() => {
        const defaults = getDefaultVisibleColumns();
        setVisibleColumns(defaults);
        saveColumns(storageKey, defaults);
    }, [storageKey]);

    return { visibleColumns, toggleColumn, isVisible, resetToDefaults };
}

interface ColumnManagerProps {
    visibleColumns: Set<string>;
    onToggle: (key: string) => void;
    onReset: () => void;
    /** Which columns to show in the picker (omit to show all) */
    availableColumns?: string[];
}

export function ColumnManager({
    visibleColumns,
    onToggle,
    onReset,
    availableColumns,
}: ColumnManagerProps) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    // Close on outside click
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

    const columns = availableColumns
        ? ALL_COLUMNS.filter((c) => availableColumns.includes(c.key))
        : ALL_COLUMNS;

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
                <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xl animate-[fadeIn_150ms_ease-out] overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                        <span className="text-xs font-semibold text-[var(--muted-foreground)]">Columns</span>
                        <button
                            onClick={onReset}
                            className="text-[10px] text-purple-400 hover:text-purple-300 transition-colors cursor-pointer"
                        >
                            Reset
                        </button>
                    </div>
                    <div className="max-h-64 overflow-y-auto py-1">
                        {columns.map((col) => {
                            const checked = visibleColumns.has(col.key);
                            return (
                                <button
                                    key={col.key}
                                    onClick={() => onToggle(col.key)}
                                    className="flex items-center gap-2.5 w-full px-3 py-1.5 text-sm hover:bg-[var(--accent)] transition-colors cursor-pointer"
                                >
                                    <div
                                        className={cn(
                                            "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                                            checked
                                                ? "bg-purple-500 border-purple-500"
                                                : "border-[var(--border)]"
                                        )}
                                    >
                                        {checked && <Check className="h-3 w-3 text-white" />}
                                    </div>
                                    <span className={checked ? "text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}>
                                        {col.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
