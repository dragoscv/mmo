"use client";

import { useState, useTransition } from "react";
import { useSelection } from "@/components/selection-provider";
import { AddToPlaylistModal } from "@/components/add-to-playlist-modal";
import { hideTracks } from "@/actions/tracks";
import { bulkSuggestAndApplyTags } from "@/actions/ai-tag";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
    X,
    ListMusic,
    EyeOff,
    CheckSquare,
    Sparkles,
    Loader2,
} from "lucide-react";

interface BulkActionsBarProps {
    onDone?: () => void;
}

export function BulkActionsBar({ onDone }: BulkActionsBarProps) {
    const selection = useSelection();
    const [playlistOpen, setPlaylistOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const [isSuggesting, setIsSuggesting] = useState(false);

    if (selection.count === 0) return null;

    const ids = Array.from(selection.selectedIds);
    const BULK_LIMIT = 50;

    async function handleHide() {
        startTransition(async () => {
            const result = await hideTracks(ids);
            if (result.success) {
                toast.success(`Hidden ${result.count} track${result.count !== 1 ? "s" : ""}`);
                selection.clear();
                onDone?.();
            }
        });
    }

    async function handleAiSuggest() {
        if (isSuggesting) return;
        const targetIds = ids.slice(0, BULK_LIMIT);
        const dropped = ids.length - targetIds.length;
        if (dropped > 0) {
            toast.info(`AI bulk capped at ${BULK_LIMIT}`, {
                description: `Processing first ${BULK_LIMIT} tracks; ${dropped} skipped (rerun for the rest).`,
            });
        }
        setIsSuggesting(true);
        const tid = toast.loading(`AI suggesting tags for ${targetIds.length} track${targetIds.length === 1 ? "" : "s"}…`);
        try {
            const res = await bulkSuggestAndApplyTags(targetIds);
            toast.dismiss(tid);
            if (!res.success) {
                toast.error("AI bulk suggest failed", { description: res.error ?? "Unknown error" });
                return;
            }
            const provider = res.provider ? ` via ${res.provider}` : "";
            toast.success(
                `AI filled ${res.filled} / ${res.processed}${provider}`,
                {
                    description: [
                        res.skipped ? `${res.skipped} already complete` : null,
                        res.failed ? `${res.failed} failed` : null,
                    ].filter(Boolean).join(" · ") || "All tracks updated.",
                },
            );
            selection.clear();
            onDone?.();
        } catch (err) {
            toast.dismiss(tid);
            toast.error("AI bulk suggest failed", {
                description: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setIsSuggesting(false);
        }
    }

    return (
        <>
            <div className="flex items-center gap-2 rounded-lg border border-purple-500/30 bg-purple-500/5 px-3 py-2 animate-[fadeIn_150ms_ease-out]">
                <div className="flex items-center gap-1.5 text-sm font-medium text-purple-400">
                    <CheckSquare className="h-4 w-4" />
                    <span>{selection.count} selected</span>
                </div>

                <div className="mx-2 h-4 w-px bg-[var(--border)]" />

                <button
                    onClick={() => setPlaylistOpen(true)}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-purple-500/10 transition-colors cursor-pointer"
                >
                    <ListMusic className="h-3.5 w-3.5" />
                    Add to Playlist
                </button>

                <button
                    onClick={handleHide}
                    disabled={isPending}
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-orange-500/10 hover:text-orange-400 transition-colors cursor-pointer disabled:opacity-50"
                >
                    <EyeOff className="h-3.5 w-3.5" />
                    Hide
                </button>

                <button
                    onClick={handleAiSuggest}
                    disabled={isSuggesting}
                    title="Use the AI provider configured in Settings → AI to fill empty genre / mood / energy / etc. fields. Only fills empty fields, never overwrites."
                    className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--foreground)] hover:bg-fuchsia-500/10 hover:text-fuchsia-300 transition-colors cursor-pointer disabled:opacity-50"
                >
                    {isSuggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    AI Suggest
                </button>

                <div className="ml-auto">
                    <button
                        onClick={() => selection.clear()}
                        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors cursor-pointer"
                    >
                        <X className="h-3 w-3" />
                        Clear
                    </button>
                </div>
            </div>

            <AddToPlaylistModal
                open={playlistOpen}
                onOpenChange={setPlaylistOpen}
                trackIds={ids}
                trackLabel={`${selection.count} track${selection.count !== 1 ? "s" : ""}`}
                onDone={() => {
                    selection.clear();
                    onDone?.();
                }}
            />
        </>
    );
}
