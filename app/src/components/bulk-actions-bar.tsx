"use client";

import { useState, useTransition } from "react";
import { useSelection } from "@/components/selection-provider";
import { AddToPlaylistModal } from "@/components/add-to-playlist-modal";
import { hideTracks } from "@/actions/tracks";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
    X,
    ListMusic,
    EyeOff,
    CheckSquare,
} from "lucide-react";

interface BulkActionsBarProps {
    onDone?: () => void;
}

export function BulkActionsBar({ onDone }: BulkActionsBarProps) {
    const selection = useSelection();
    const [playlistOpen, setPlaylistOpen] = useState(false);
    const [isPending, startTransition] = useTransition();

    if (selection.count === 0) return null;

    const ids = Array.from(selection.selectedIds);

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
