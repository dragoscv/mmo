"use client";

/**
 * Horizontal strip of saved-search "crates" shown above the library
 * filter bar. Click a chip to apply that crate's filters; the active
 * crate (whose filter set matches the current URL exactly) is
 * highlighted. The "Save current" button on the right captures the
 * active filter state and asks for a name via a small dialog.
 *
 * Renaming and deleting are handled inline via the chip's overflow
 * (right-click / long-press → context menu). Kept intentionally
 * lightweight: no drag-to-reorder yet, no icons picker, just text +
 * delete + rename.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Plus, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
    createSavedSearch, deleteSavedSearch, renameSavedSearch,
} from "@/actions/saved-searches";
import { filtersToQueryString, hasMeaningfulFilters, type SavedSearchFilters, SAVED_SEARCH_KEYS } from "@/lib/saved-searches";

interface SavedSearchChip {
    id: number;
    name: string;
    icon?: string | null;
    filters: Record<string, string>;
}

interface Props {
    savedSearches: SavedSearchChip[];
    /** Current URL filters (may include keys we don't persist, like
     *  `page` / `pageSize` — those are stripped). */
    currentFilters: Record<string, string>;
}

export function SavedSearchesStrip({ savedSearches, currentFilters }: Props) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [pendingName, setPendingName] = useState("");
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState("");

    const persistableFilters = pickPersistable(currentFilters);
    const canSave = hasMeaningfulFilters(persistableFilters);
    const activeId = findActiveCrate(savedSearches, persistableFilters);

    function applyCrate(filters: Record<string, string>) {
        const qs = filtersToQueryString(filters as SavedSearchFilters);
        router.push(`/library${qs}`);
    }

    function handleSave() {
        const name = pendingName.trim();
        if (!name) {
            toast.error("Enter a name for the crate.");
            return;
        }
        startTransition(async () => {
            try {
                await createSavedSearch({ name, filters: persistableFilters });
                toast.success(`Saved "${name}".`);
                setShowSaveDialog(false);
                setPendingName("");
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to save crate.");
            }
        });
    }

    function handleRename() {
        if (renamingId === null) return;
        const name = renameValue.trim();
        if (!name) return;
        startTransition(async () => {
            try {
                await renameSavedSearch({ id: renamingId, name });
                toast.success("Renamed.");
                setRenamingId(null);
                setRenameValue("");
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to rename.");
            }
        });
    }

    function handleDelete(id: number, name: string) {
        if (!confirm(`Delete crate "${name}"?`)) return;
        startTransition(async () => {
            try {
                await deleteSavedSearch(id);
                toast.success(`Deleted "${name}".`);
                router.refresh();
            } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to delete.");
            }
        });
    }

    if (savedSearches.length === 0 && !canSave) return null;

    return (
        <div className="flex flex-wrap items-center gap-2 mb-3">
            <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />
            {savedSearches.map((c) => {
                const isActive = c.id === activeId;
                const isRenaming = c.id === renamingId;
                if (isRenaming) {
                    return (
                        <span key={c.id} className="inline-flex items-center gap-1 rounded-full border border-primary px-2 py-0.5">
                            <Input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") handleRename();
                                    if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                                }}
                                className="h-6 w-32 text-xs"
                            />
                        </span>
                    );
                }
                return (
                    <span
                        key={c.id}
                        className={cn(
                            "group inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            isActive
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border hover:bg-muted/50 text-muted-foreground hover:text-foreground",
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => applyCrate(c.filters)}
                            className="cursor-pointer"
                        >
                            {c.name}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setRenamingId(c.id); setRenameValue(c.name); }}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                            title="Rename"
                        >
                            <Pencil className="h-3 w-3" />
                        </button>
                        <button
                            type="button"
                            onClick={() => handleDelete(c.id, c.name)}
                            className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                            title="Delete"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </span>
                );
            })}
            {canSave && activeId === null && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-6 gap-1 text-xs px-2"
                    onClick={() => setShowSaveDialog(true)}
                    disabled={isPending}
                >
                    <Plus className="h-3 w-3" />
                    Save current
                </Button>
            )}

            <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle>Name this crate</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-2">
                        <Input
                            autoFocus
                            placeholder="e.g. Tech-house warmup 124-128"
                            value={pendingName}
                            onChange={(e) => setPendingName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                            maxLength={60}
                        />
                        <p className="text-xs text-muted-foreground">
                            Re-runs against your library every time you open it.
                        </p>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setShowSaveDialog(false)}>Cancel</Button>
                        <Button onClick={handleSave} disabled={isPending || !pendingName.trim()}>Save</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/**
 * Trim the URL filters to the keys we actually persist, dropping
 * pagination, page-size, and any unknown junk.
 */
function pickPersistable(filters: Record<string, string>): SavedSearchFilters {
    const out: Record<string, string> = {};
    for (const key of SAVED_SEARCH_KEYS) {
        const v = filters[key];
        if (typeof v === "string" && v.length > 0) out[key] = v;
    }
    return out as SavedSearchFilters;
}

/** Find a crate whose filter set matches the current URL exactly. */
function findActiveCrate(
    crates: SavedSearchChip[],
    current: SavedSearchFilters,
): number | null {
    for (const c of crates) {
        if (sameFilters(c.filters, current)) return c.id;
    }
    return null;
}

function sameFilters(a: Record<string, string>, b: Record<string, string>): boolean {
    const aKeys = Object.keys(a).filter((k) => a[k]);
    const bKeys = Object.keys(b).filter((k) => b[k]);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) if (a[k] !== b[k]) return false;
    return true;
}
