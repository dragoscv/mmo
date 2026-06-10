"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
    MoreHorizontal,
    Pencil,
    Trash2,
    Copy,
    Download,
    ListX,
    Loader2,
    RefreshCw,
    Sparkles,
} from "lucide-react";
import {
    updatePlaylist,
    deletePlaylist,
    duplicatePlaylist,
    clearPlaylist,
    exportPlaylistToXml,
} from "@/actions/playlists";
import {
    refreshSmartPlaylist,
    getSmartPlaylistRules,
} from "@/actions/smart-playlists";
import { SmartPlaylistDialog } from "@/components/smart-playlist-dialog";
import type { SmartRules } from "@/lib/smart-rules";
import { toast } from "sonner";

interface PlaylistActionsProps {
    playlistId: number;
    playlistName: string;
    /** When true, shows the Refresh + Edit Smart Rules menu items.
     *  Parent passes this from a single getSmartPlaylistIds() lookup
     *  so we don't fetch per-row in big sidebars. */
    isSmart?: boolean;
    onMutate?: () => void;
    className?: string;
}

export function PlaylistActions({
    playlistId,
    playlistName,
    isSmart,
    onMutate,
    className,
}: PlaylistActionsProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [clearOpen, setClearOpen] = useState(false);
    const [editName, setEditName] = useState(playlistName);
    const [smartEditOpen, setSmartEditOpen] = useState(false);
    const [smartInitial, setSmartInitial] = useState<{ rules: SmartRules; source: "builder" | "sql" | "graph" | "ai" } | null>(null);

    function handleRefreshSmart() {
        startTransition(async () => {
            const r = await refreshSmartPlaylist(playlistId);
            if (r.success) {
                toast.success(`Refreshed — ${r.count ?? 0} tracks now match`);
                onMutate?.();
                router.refresh();
            } else {
                toast.error(r.error ?? "Refresh failed");
            }
        });
    }

    function handleOpenSmartEdit() {
        startTransition(async () => {
            const data = await getSmartPlaylistRules(playlistId);
            if (!data) {
                toast.error("Couldn't load smart rules");
                return;
            }
            setSmartInitial({
                rules: data.rules,
                source: (data.ruleSource as "builder" | "sql" | "graph" | "ai"),
            });
            setSmartEditOpen(true);
        });
    }

    function handleRename() {
        if (!editName.trim()) return;
        startTransition(async () => {
            await updatePlaylist(playlistId, { name: editName.trim() });
            setRenameOpen(false);
            onMutate?.();
            router.refresh();
            toast.success(`Renamed to "${editName.trim()}"`);
        });
    }

    function handleDelete() {
        startTransition(async () => {
            await deletePlaylist(playlistId);
            setDeleteOpen(false);
            onMutate?.();
            router.push("/playlists");
            router.refresh();
            toast.success(`Deleted "${playlistName}"`);
        });
    }

    function handleDuplicate() {
        startTransition(async () => {
            const newPl = await duplicatePlaylist(playlistId);
            onMutate?.();
            router.push(`/playlists?id=${newPl.id}`);
            router.refresh();
            toast.success(`Duplicated as "${newPl.name}"`);
        });
    }

    function handleClear() {
        startTransition(async () => {
            await clearPlaylist(playlistId);
            setClearOpen(false);
            onMutate?.();
            router.refresh();
            toast.success("All tracks removed from playlist");
        });
    }

    async function handleExport() {
        try {
            const xml = await exportPlaylistToXml(playlistId);
            const blob = new Blob([xml], { type: "application/xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${playlistName}.xml`;
            a.click();
            URL.revokeObjectURL(url);
            toast.success("Exported playlist to XML");
        } catch {
            toast.error("Export failed");
        }
    }

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        className={cn(
                            "flex h-6 w-6 items-center justify-center rounded transition-all cursor-pointer opacity-0 group-hover:opacity-100 hover:bg-[var(--accent)] focus:outline-none focus:opacity-100",
                            className
                        )}
                        onClick={(e) => e.preventDefault()}
                    >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="end"
                    className="w-48"
                    onClick={(e) => e.stopPropagation()}
                >
                    <DropdownMenuItem onClick={() => {
                        setEditName(playlistName);
                        setRenameOpen(true);
                    }}>
                        <Pencil className="h-3.5 w-3.5 mr-2" />
                        Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDuplicate}>
                        <Copy className="h-3.5 w-3.5 mr-2" />
                        Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExport}>
                        <Download className="h-3.5 w-3.5 mr-2" />
                        Export to XML
                    </DropdownMenuItem>

                    {isSmart && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={handleRefreshSmart}>
                                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                                Refresh Smart Rules
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={handleOpenSmartEdit}>
                                <Sparkles className="h-3.5 w-3.5 mr-2" />
                                Edit Smart Rules
                            </DropdownMenuItem>
                        </>
                    )}

                    <DropdownMenuSeparator />

                    <DropdownMenuItem
                        onClick={() => setClearOpen(true)}
                        className="text-amber-400 focus:text-amber-300"
                    >
                        <ListX className="h-3.5 w-3.5 mr-2" />
                        Clear All Tracks
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onClick={() => setDeleteOpen(true)}
                        className="text-rose-400 focus:text-rose-300"
                    >
                        <Trash2 className="h-3.5 w-3.5 mr-2" />
                        Delete Playlist
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            {/* Rename Dialog */}
            <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Rename Playlist</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            placeholder="Playlist name..."
                            autoFocus
                            onKeyDown={(e) =>
                                e.key === "Enter" && handleRename()
                            }
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setRenameOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            onClick={handleRename}
                            disabled={isPending || !editName.trim()}
                        >
                            {isPending && (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            )}
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation */}
            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Playlist</AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete &quot;
                            {playlistName}&quot;? This will remove the playlist
                            but not the actual tracks from your library.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleDelete}
                            className="bg-rose-600 hover:bg-rose-700"
                        >
                            {isPending && (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            )}
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Clear Confirmation */}
            <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Clear Playlist</AlertDialogTitle>
                        <AlertDialogDescription>
                            Remove all tracks from &quot;{playlistName}&quot;?
                            Tracks will remain in your library.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleClear}
                            className="bg-amber-600 hover:bg-amber-700"
                        >
                            Clear All
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Smart Rules Edit Dialog */}
            {smartInitial && (
                <SmartPlaylistDialog
                    open={smartEditOpen}
                    onOpenChange={(o) => {
                        setSmartEditOpen(o);
                        if (!o) setSmartInitial(null);
                    }}
                    editPlaylistId={playlistId}
                    editPlaylistName={playlistName}
                    initialRules={smartInitial.rules}
                    initialRuleSource={smartInitial.source}
                    onCreated={() => {
                        onMutate?.();
                        router.refresh();
                    }}
                />
            )}
        </>
    );
}
