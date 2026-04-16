"use client";

import React, { useState, useTransition, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    ContextMenuLabel,
} from "@/components/ui/context-menu";
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
import { AddToPlaylistModal } from "@/components/add-to-playlist-modal";
import { cn } from "@/lib/utils";
import {
    MoreHorizontal,
    Play,
    ListPlus,
    ListMusic,
    Heart,
    HeartOff,
    Star,
    Info,
    Pencil,
    Trash2,
    ArrowUp,
    ArrowDown,
    X,
    Copy,
    ExternalLink,
    Music,
    Disc3,
    EyeOff,
    Radio,
    Piano,
} from "lucide-react";
import { toggleFavorite, deleteTrack, hideTracks } from "@/actions/tracks";
import {
    removeTrackFromPlaylist,
    moveTrackInPlaylist,
} from "@/actions/playlists";
import { usePlayer } from "@/components/player-context";
import { useMixer } from "@/components/mixer-context";
import { toast } from "sonner";
import { getRadioMix } from "@/actions/recommendations";
import type { Track } from "@/db/schema";

// ─── Shared Props ────────────────────────────────────────────────────────────
interface TrackActionConfig {
    track: Track;
    playlistId?: number;
    showReorder?: boolean;
    hideDeckActions?: boolean;
    onOpenDetail?: () => void;
    onEdit?: () => void;
    onMutate?: () => void;
}

// ─── Shared Hook ─────────────────────────────────────────────────────────────
function useTrackActionHandlers(config: TrackActionConfig) {
    const { track, playlistId, onMutate } = config;
    const player = usePlayer();
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [playlistModalOpen, setPlaylistModalOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [removeDialogOpen, setRemoveDialogOpen] = useState(false);

    const artist = track.artist || "Unknown";
    const title = track.title || track.filename;
    const trackLabel = `${artist} — ${title}`;

    function handlePlay() {
        player.play(track);
    }

    function handleAddToQueue() {
        player.addToQueue(track);
        toast.success("Added to queue", { description: trackLabel });
    }

    function handleRadioMix() {
        toast.promise(
            getRadioMix(track.id, 30).then((mixTracks) => {
                if (mixTracks.length <= 1) {
                    throw new Error("No similar tracks found");
                }
                player.play(mixTracks[0], mixTracks);
                return mixTracks;
            }),
            {
                loading: `Building radio mix from ${title}...`,
                success: (t) => `Radio mix started · ${t.length} tracks`,
                error: "Couldn't find enough similar tracks",
            }
        );
    }

    function handleToggleFavorite() {
        startTransition(async () => {
            await toggleFavorite(track.id);
            onMutate?.();
            router.refresh();
            toast.success(
                track.isFavorite
                    ? "Removed from favorites"
                    : "Added to favorites"
            );
        });
    }

    function handleRemoveFromPlaylist() {
        if (!playlistId) return;
        startTransition(async () => {
            await removeTrackFromPlaylist(playlistId, track.id);
            onMutate?.();
            router.refresh();
            toast.success("Removed from playlist");
        });
        setRemoveDialogOpen(false);
    }

    function handleMoveTrack(direction: "up" | "down") {
        if (!playlistId) return;
        startTransition(async () => {
            await moveTrackInPlaylist(playlistId, track.id, direction);
            onMutate?.();
            router.refresh();
        });
    }

    function handleDeleteTrack() {
        startTransition(async () => {
            await deleteTrack(track.id);
            onMutate?.();
            router.refresh();
            toast.success("Track deleted from library");
        });
        setDeleteDialogOpen(false);
    }

    function handleHideTrack() {
        startTransition(async () => {
            await hideTracks([track.id]);
            onMutate?.();
            router.refresh();
            toast.success("Track hidden from library");
        });
    }

    function handleCopyInfo() {
        const info = `${artist} - ${title}`;
        navigator.clipboard.writeText(info);
        toast.success("Copied to clipboard", { description: info });
    }

    return {
        isPending,
        trackLabel,
        artist,
        title,
        playlistModalOpen,
        setPlaylistModalOpen,
        deleteDialogOpen,
        setDeleteDialogOpen,
        removeDialogOpen,
        setRemoveDialogOpen,
        handlePlay,
        handleAddToQueue,
        handleRadioMix,
        handleToggleFavorite,
        handleRemoveFromPlaylist,
        handleMoveTrack,
        handleDeleteTrack,
        handleCopyInfo,
        handleHideTrack,
        router,
    };
}

// ─── Generic Menu Items ──────────────────────────────────────────────────────
// Renders the shared set of menu items for both DropdownMenu and ContextMenu.
// Accepts generic component slots so the same content works in either context.
function TrackMenuItems({
    config,
    handlers,
    Item,
    Separator,
}: {
    config: TrackActionConfig;
    handlers: ReturnType<typeof useTrackActionHandlers>;
    Item: React.ComponentType<{ onClick?: () => void; className?: string; children: React.ReactNode }>;
    Separator: React.ComponentType;
}) {
    const { track, playlistId, showReorder, hideDeckActions, onOpenDetail, onEdit } = config;
    const mixer = useMixer();

    return (
        <>
            {/* Playback */}
            <Item onClick={handlers.handlePlay}>
                <Play className="h-3.5 w-3.5 mr-2" />
                Play Now
            </Item>
            <Item onClick={handlers.handleAddToQueue}>
                <ListPlus className="h-3.5 w-3.5 mr-2" />
                Add to Queue
            </Item>
            <Item onClick={handlers.handleRadioMix}>
                <Radio className="h-3.5 w-3.5 mr-2" />
                Radio Mix...
            </Item>

            <Separator />

            {/* Mixer Decks */}
            {!hideDeckActions && (
                <>
                    <Item onClick={() => { mixer.loadTrack("A", track); toast.success(`Loaded to Deck A`); }}>
                        <Disc3 className="h-3.5 w-3.5 mr-2 text-purple-400" />
                        Load to Deck A
                    </Item>
                    <Item onClick={() => { mixer.loadTrack("B", track); toast.success(`Loaded to Deck B`); }}>
                        <Disc3 className="h-3.5 w-3.5 mr-2 text-blue-400" />
                        Load to Deck B
                    </Item>

                    <Separator />
                </>
            )}

            {/* DAW */}
            <Item onClick={() => {
                const params = new URLSearchParams({ trackId: String(track.id), title: track.title || track.filename, filePath: track.filepath });
                handlers.router.push(`/daw?${params.toString()}`);
            }}>
                <Piano className="h-3.5 w-3.5 mr-2 text-emerald-400" />
                Open in DAW
            </Item>

            {/* Playlist */}
            <Item onClick={() => handlers.setPlaylistModalOpen(true)}>
                <ListMusic className="h-3.5 w-3.5 mr-2" />
                Add to Playlist...
            </Item>

            {playlistId && showReorder && (
                <>
                    <Separator />
                    <Item onClick={() => handlers.handleMoveTrack("up")}>
                        <ArrowUp className="h-3.5 w-3.5 mr-2" />
                        Move Up
                    </Item>
                    <Item onClick={() => handlers.handleMoveTrack("down")}>
                        <ArrowDown className="h-3.5 w-3.5 mr-2" />
                        Move Down
                    </Item>
                </>
            )}

            <Separator />

            {/* Metadata */}
            <Item onClick={handlers.handleToggleFavorite}>
                {track.isFavorite ? (
                    <HeartOff className="h-3.5 w-3.5 mr-2" />
                ) : (
                    <Heart className="h-3.5 w-3.5 mr-2" />
                )}
                {track.isFavorite
                    ? "Remove from Favorites"
                    : "Add to Favorites"}
            </Item>
            <Item onClick={handlers.handleCopyInfo}>
                <Copy className="h-3.5 w-3.5 mr-2" />
                Copy Track Info
            </Item>

            {onOpenDetail && (
                <Item onClick={onOpenDetail}>
                    <Info className="h-3.5 w-3.5 mr-2" />
                    Track Details
                </Item>
            )}
            {onEdit && (
                <Item onClick={onEdit}>
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Edit Metadata
                </Item>
            )}

            <Separator />

            {/* Hide & Destructive */}
            <Item onClick={handlers.handleHideTrack}>
                <EyeOff className="h-3.5 w-3.5 mr-2" />
                Hide from Library
            </Item>
            {playlistId && (
                <Item
                    onClick={() => handlers.setRemoveDialogOpen(true)}
                    className="text-rose-400 focus:text-rose-300"
                >
                    <X className="h-3.5 w-3.5 mr-2" />
                    Remove from Playlist
                </Item>
            )}
            <Item
                onClick={() => handlers.setDeleteDialogOpen(true)}
                className="text-rose-400 focus:text-rose-300"
            >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete from Library
            </Item>
        </>
    );
}

// ─── Shared Dialogs ──────────────────────────────────────────────────────────
function TrackDialogs({
    config,
    handlers,
}: {
    config: TrackActionConfig;
    handlers: ReturnType<typeof useTrackActionHandlers>;
}) {
    const { track, playlistId } = config;

    return (
        <>
            <AddToPlaylistModal
                open={handlers.playlistModalOpen}
                onOpenChange={handlers.setPlaylistModalOpen}
                trackIds={[track.id]}
                trackLabel={handlers.trackLabel}
                onDone={() => {
                    config.onMutate?.();
                    handlers.router.refresh();
                }}
            />

            <AlertDialog
                open={handlers.removeDialogOpen}
                onOpenChange={handlers.setRemoveDialogOpen}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Remove from Playlist
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Remove &quot;{handlers.trackLabel}&quot; from this
                            playlist? The track will remain in your library.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handlers.handleRemoveFromPlaylist}
                            className="bg-rose-600 hover:bg-rose-700"
                        >
                            Remove
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <AlertDialog
                open={handlers.deleteDialogOpen}
                onOpenChange={handlers.setDeleteDialogOpen}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Delete Track from Library
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            Are you sure you want to delete &quot;
                            {handlers.trackLabel}&quot; from your library? This
                            will remove the track from all playlists. The file
                            on disk will not be deleted.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handlers.handleDeleteTrack}
                            className="bg-rose-600 hover:bg-rose-700"
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

// ─── Dropdown Trigger (dots button) ──────────────────────────────────────────
interface TrackActionsProps extends TrackActionConfig {
    variant?: "icon" | "dots";
    className?: string;
}

export function TrackActions({
    variant = "dots",
    className,
    ...config
}: TrackActionsProps) {
    const handlers = useTrackActionHandlers(config);

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        className={cn(
                            "flex items-center justify-center rounded-md transition-all cursor-pointer focus:outline-none",
                            variant === "dots"
                                ? "h-7 w-7 hover:bg-[var(--accent)] opacity-0 group-hover:opacity-100"
                                : "h-8 w-8 hover:bg-[var(--accent)]",
                            handlers.isPending && "opacity-50",
                            className
                        )}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <MoreHorizontal className="h-4 w-4" />
                    </button>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                    align="end"
                    className="w-52"
                    onClick={(e) => e.stopPropagation()}
                >
                    <TrackMenuItems
                        config={config}
                        handlers={handlers}
                        Item={DropdownMenuItem}
                        Separator={DropdownMenuSeparator}
                    />
                </DropdownMenuContent>
            </DropdownMenu>

            <TrackDialogs config={config} handlers={handlers} />
        </>
    );
}

// ─── Context Menu (right-click) ──────────────────────────────────────────────
interface TrackContextMenuProps extends TrackActionConfig {
    children: React.ReactNode;
}

function LongPressTrigger({ children }: { children: React.ReactNode }) {
    const ref = useRef<HTMLElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const movedRef = useRef(false);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        movedRef.current = false;
        const touch = e.touches[0];
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            if (touch && !movedRef.current && ref.current) {
                ref.current.dispatchEvent(
                    new MouseEvent("contextmenu", {
                        bubbles: true,
                        clientX: touch.clientX,
                        clientY: touch.clientY,
                    })
                );
            }
        }, 500);
    }, []);

    const cancel = useCallback((e?: React.TouchEvent) => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        } else if (!movedRef.current && e) {
            // Long press already fired — prevent click/tap from triggering
            e.preventDefault();
        }
        movedRef.current = true;
    }, []);

    // Merge touch handlers onto the child element to avoid wrapping with a <div>,
    // which breaks HTML semantics inside <table>/<tbody>
    const child = React.isValidElement(children) ? children : <span>{children}</span>;

    return (
        <ContextMenuTrigger asChild>
            {React.cloneElement(child as React.ReactElement<Record<string, unknown>>, {
                ref,
                onTouchStart: handleTouchStart,
                onTouchMove: cancel,
                onTouchEnd: cancel,
                onTouchCancel: cancel,
            })}
        </ContextMenuTrigger>
    );
}

export function TrackContextMenu({
    children,
    ...config
}: TrackContextMenuProps) {
    const handlers = useTrackActionHandlers(config);

    return (
        <>
            <ContextMenu>
                <LongPressTrigger>
                    {children}
                </LongPressTrigger>

                <ContextMenuContent className="w-56">
                    {/* Header */}
                    <ContextMenuLabel className="flex items-center gap-2 pb-1.5">
                        <Disc3 className="h-3.5 w-3.5 text-purple-400" />
                        <span className="truncate max-w-[180px]">
                            {handlers.artist} — {handlers.title}
                        </span>
                    </ContextMenuLabel>
                    <ContextMenuSeparator />

                    <TrackMenuItems
                        config={config}
                        handlers={handlers}
                        Item={ContextMenuItem}
                        Separator={ContextMenuSeparator}
                    />
                </ContextMenuContent>
            </ContextMenu>

            <TrackDialogs config={config} handlers={handlers} />
        </>
    );
}
