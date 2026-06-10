"use client";

/**
 * Snapshots panel — drawer-style UI for listing, creating, and
 * restoring project snapshots.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <SnapshotsPanel
 *     open={open}
 *     onOpenChange={setOpen}
 *     kind="daw"
 *     externalId={project.id}
 *     getCurrentDocument={() => state.project as unknown as Record<string, unknown>}
 *     onRestore={(doc) => loadProjectFromDocument(doc)}
 *   />
 *
 * Server actions: listSnapshots / createSnapshot / getSnapshot.
 */

import { useCallback, useEffect, useState } from "react";
import { listSnapshots, createSnapshot, getSnapshot } from "@/actions/projects";
import type { ProjectKind } from "@/db/schema-projects";
import { Camera, RotateCcw, GitCommit, X, Loader2 } from "lucide-react";
import { StorageTierSelector } from "./storage-tier-selector";

interface SnapshotRow {
    externalId: string;
    label: string | null;
    auto: boolean;
    createdAt: string;
    gitCommitSha: string | null;
}

interface SnapshotsPanelProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    kind: ProjectKind;
    externalId: string;
    /** Returns the current in-memory document so we can persist a fresh snapshot. */
    getCurrentDocument: () => Record<string, unknown>;
    /** Called when the user picks a snapshot to restore — caller mutates app state. */
    onRestore?: (document: Record<string, unknown>) => void;
}

function formatDate(iso: string): string {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return iso;
    }
}

export function SnapshotsPanel(props: SnapshotsPanelProps) {
    const { open, onOpenChange, kind, externalId, getCurrentDocument, onRestore } = props;
    const [rows, setRows] = useState<SnapshotRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [restoring, setRestoring] = useState<string | null>(null);
    const [label, setLabel] = useState("");
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!externalId) return;
        setLoading(true);
        setError(null);
        try {
            const out = await listSnapshots(kind, externalId);
            setRows(out as SnapshotRow[]);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, [kind, externalId]);

    useEffect(() => {
        if (open) refresh();
    }, [open, refresh]);

    const onSnapshotNow = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
            await createSnapshot(kind, externalId, getCurrentDocument(), label || undefined);
            setLabel("");
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }, [kind, externalId, getCurrentDocument, label, refresh]);

    const restoreEnabled = typeof onRestore === "function";
    const onRestoreClick = useCallback(async (snap: SnapshotRow) => {
        if (!onRestore) return;
        const confirmed = window.confirm(
            `Restore snapshot "${snap.label ?? formatDate(snap.createdAt)}"?\n\nCurrent unsaved changes will be lost.`
        );
        if (!confirmed) return;
        setRestoring(snap.externalId);
        setError(null);
        try {
            const got = await getSnapshot(snap.externalId);
            if (got) onRestore(got.document);
            onOpenChange(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setRestoring(null);
        }
    }, [onRestore, onOpenChange]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 flex">
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={() => onOpenChange(false)}
            />
            <aside
                className="relative ml-auto w-full max-w-md h-full bg-zinc-900 border-l border-white/10 shadow-2xl flex flex-col"
                role="dialog"
                aria-label="Snapshots"
            >
                <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
                    <h2 className="text-base font-medium text-white/90 flex items-center gap-2">
                        <GitCommit className="h-4 w-4" /> Snapshots
                    </h2>
                    <button
                        onClick={() => onOpenChange(false)}
                        className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white/90"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </header>

                <div className="px-4 py-3 border-b border-white/10 flex flex-col gap-3">
                    <StorageTierSelector kind={kind} externalId={externalId} />
                    <input
                        type="text"
                        placeholder="Label (optional)"
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-black/40 border border-white/10 rounded-md text-white/90 focus:outline-none focus:border-blue-500/60"
                    />
                    <button
                        onClick={onSnapshotNow}
                        disabled={saving || !externalId}
                        className="flex items-center justify-center gap-2 px-3 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-md text-white font-medium transition-colors"
                    >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                        Snapshot now
                    </button>
                </div>

                {error && (
                    <div className="mx-4 mt-3 px-3 py-2 text-xs bg-red-500/15 border border-red-500/30 rounded-md text-red-300">
                        {error}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto px-2 py-2">
                    {loading && rows.length === 0 && (
                        <div className="flex items-center justify-center py-8 text-white/40 text-sm">
                            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
                        </div>
                    )}
                    {!loading && rows.length === 0 && (
                        <div className="text-center py-8 text-white/40 text-sm">
                            No snapshots yet.
                        </div>
                    )}
                    <ul className="flex flex-col gap-1">
                        {rows.map((s) => (
                            <li
                                key={s.externalId}
                                className="px-3 py-2 rounded-md border border-white/5 hover:border-white/15 transition-colors flex items-start gap-3"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 text-sm text-white/90 truncate">
                                        {s.label ?? <span className="text-white/50">Untitled</span>}
                                        {s.auto && (
                                            <span className="text-[10px] uppercase tracking-wide bg-white/10 text-white/60 px-1.5 py-0.5 rounded">
                                                auto
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 text-xs text-white/50">
                                        <span>{formatDate(s.createdAt)}</span>
                                        {s.gitCommitSha && (
                                            <a
                                                href={`https://github.com/search?q=${s.gitCommitSha}&type=commits`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-blue-400 hover:underline font-mono"
                                            >
                                                {s.gitCommitSha.slice(0, 7)}
                                            </a>
                                        )}
                                    </div>
                                </div>
                                {restoreEnabled && (
                                    <button
                                        onClick={() => onRestoreClick(s)}
                                        disabled={restoring !== null}
                                        className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white/90 disabled:opacity-50"
                                        aria-label={`Restore snapshot ${s.label ?? s.externalId}`}
                                        title="Restore"
                                    >
                                        {restoring === s.externalId
                                            ? <Loader2 className="h-4 w-4 animate-spin" />
                                            : <RotateCcw className="h-4 w-4" />}
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </aside>
        </div>
    );
}
