"use client";

import { useState, useEffect, useTransition } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
    Plus,
    Check,
    ListMusic,
    Loader2,
    Search,
    CheckCircle2,
} from "lucide-react";
import {
    getPlaylists,
    addTracksToPlaylist,
    createPlaylist,
    getPlaylistsForTrack,
} from "@/actions/playlists";
import { toast } from "sonner";

interface PlaylistOption {
    id: number;
    name: string;
    trackCount: number;
    containsTrack: boolean;
}

interface AddToPlaylistModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    trackIds: number[];
    trackLabel?: string;
    onDone?: () => void;
}

export function AddToPlaylistModal({
    open,
    onOpenChange,
    trackIds,
    trackLabel,
    onDone,
}: AddToPlaylistModalProps) {
    const [playlists, setPlaylists] = useState<PlaylistOption[]>([]);
    const [search, setSearch] = useState("");
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [isPending, startTransition] = useTransition();
    const [addedTo, setAddedTo] = useState<Set<number>>(new Set());

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- imperative reset on open transition + async data fetch
        setSearch("");
        setCreating(false);
        setNewName("");
        setAddedTo(new Set());

        (async () => {
            const all = await getPlaylists();
            const isSingle = trackIds.length === 1;
            const containingPlaylists = isSingle
                ? await getPlaylistsForTrack(trackIds[0])
                : [];
            const containingIds = new Set(containingPlaylists.map((p) => p.id));

            setPlaylists(
                all.map((p) => ({
                    id: p.id,
                    name: p.name,
                    trackCount: p.trackCount,
                    containsTrack: containingIds.has(p.id),
                }))
            );
        })();
    }, [open, trackIds]);

    const filtered = playlists.filter((p) =>
        p.name.toLowerCase().includes(search.toLowerCase())
    );

    function handleAddToPlaylist(playlistId: number) {
        startTransition(async () => {
            const result = await addTracksToPlaylist(playlistId, trackIds);
            setAddedTo((prev) => new Set(prev).add(playlistId));
            const name = playlists.find((p) => p.id === playlistId)?.name;
            if (result.added > 0) {
                toast.success(
                    `Added ${result.added} track${result.added > 1 ? "s" : ""} to "${name}"`
                );
            } else {
                toast.info(`Track${trackIds.length > 1 ? "s" : ""} already in "${name}"`);
            }
        });
    }

    function handleCreateAndAdd() {
        if (!newName.trim()) return;
        startTransition(async () => {
            const pl = await createPlaylist(newName.trim());
            await addTracksToPlaylist(pl.id, trackIds);
            toast.success(
                `Created "${pl.name}" and added ${trackIds.length} track${trackIds.length > 1 ? "s" : ""}`
            );
            setCreating(false);
            setNewName("");
            onOpenChange(false);
            onDone?.();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md max-h-[70vh] flex flex-col gap-0 p-0 overflow-hidden">
                <DialogHeader className="px-6 pt-6 pb-3 border-b border-[var(--border)] shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/20">
                            <ListMusic className="h-3.5 w-3.5 text-purple-400" />
                        </div>
                        Add to Playlist
                    </DialogTitle>
                    {trackLabel && (
                        <p className="text-xs text-[var(--muted-foreground)] mt-1 truncate">
                            {trackLabel}
                        </p>
                    )}
                </DialogHeader>

                <div className="px-4 py-3 border-b border-[var(--border)]">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--muted-foreground)]" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search playlists..."
                            className="pl-8 h-8 text-sm"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto px-2 py-2 min-h-0">
                    {filtered.length === 0 && !creating ? (
                        <div className="text-center py-8 text-[var(--muted-foreground)]">
                            <ListMusic className="h-8 w-8 mx-auto mb-2 opacity-40" />
                            <p className="text-sm">No playlists found</p>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {filtered.map((pl) => {
                                const isAdded =
                                    addedTo.has(pl.id) || pl.containsTrack;
                                return (
                                    <button
                                        key={pl.id}
                                        onClick={() =>
                                            !isAdded &&
                                            handleAddToPlaylist(pl.id)
                                        }
                                        disabled={isPending || isAdded}
                                        className={cn(
                                            "flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-left transition-all cursor-pointer",
                                            isAdded
                                                ? "bg-green-500/5 text-green-400"
                                                : "hover:bg-[var(--accent)]",
                                            isPending && "opacity-60"
                                        )}
                                    >
                                        <div
                                            className={cn(
                                                "flex h-8 w-8 items-center justify-center rounded-md shrink-0",
                                                isAdded
                                                    ? "bg-green-500/20"
                                                    : "bg-purple-500/10"
                                            )}
                                        >
                                            {isAdded ? (
                                                <CheckCircle2 className="h-4 w-4 text-green-400" />
                                            ) : (
                                                <ListMusic className="h-4 w-4 text-purple-400" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium truncate">
                                                {pl.name}
                                            </p>
                                            <p className="text-[10px] text-[var(--muted-foreground)]">
                                                {pl.trackCount} track
                                                {pl.trackCount !== 1 ? "s" : ""}
                                                {isAdded &&
                                                    pl.containsTrack &&
                                                    !addedTo.has(pl.id) &&
                                                    " · already added"}
                                                {isAdded &&
                                                    addedTo.has(pl.id) &&
                                                    " · just added"}
                                            </p>
                                        </div>
                                        {!isAdded && (
                                            <Plus className="h-4 w-4 text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100" />
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                <div className="px-4 py-3 border-t border-[var(--border)] shrink-0">
                    {creating ? (
                        <div className="flex gap-2">
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="New playlist name..."
                                className="h-8 text-sm flex-1"
                                autoFocus
                                onKeyDown={(e) =>
                                    e.key === "Enter" && handleCreateAndAdd()
                                }
                            />
                            <Button
                                size="sm"
                                onClick={handleCreateAndAdd}
                                disabled={isPending || !newName.trim()}
                                className="h-8"
                            >
                                {isPending ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Check className="h-3.5 w-3.5" />
                                )}
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCreating(false)}
                                className="h-8"
                            >
                                Cancel
                            </Button>
                        </div>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            className="w-full gap-2"
                            onClick={() => {
                                setCreating(true);
                                setNewName("");
                            }}
                        >
                            <Plus className="h-3.5 w-3.5" />
                            Create New Playlist
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
