"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { useRouteMemorySave } from "@/hooks/use-route-memory";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/ui/dialog";
import { usePlayer } from "@/components/player-context";
import { StarRating } from "@/components/star-rating";
import { FavoriteButton } from "@/components/favorite-button";
import { TagBadges } from "@/components/tag-input";
import { Artwork } from "@/components/artwork";
import { TrackDetailModal } from "@/components/track-detail-modal";
import { TrackActions, TrackContextMenu } from "@/components/track-actions";
import { PlaylistActions } from "@/components/playlist-actions";
import { ColumnManager, useColumnConfig } from "@/components/column-manager";
import { Select } from "@/components/ui/select";
import { formatDuration, formatNumber, ENERGY_COLORS, GENRE_COLORS, cn } from "@/lib/utils";
import {
    Play,
    Pause,
    ListMusic,
    Music,
    Plus,
    Pencil,
    Trash2,
    Download,
    X,
    Loader2,
    FileDown,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    ListPlus,
    Sparkles,
} from "lucide-react";
import type { Track } from "@/db/schema";
import {
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    removeTrackFromPlaylist,
    exportPlaylistToXml,
    exportAllPlaylistsToXml,
    type RecommendedCategory,
} from "@/actions/playlists";
import { PlaylistRecommendations } from "@/components/playlist-recommendations";
import { SimilarTracksModal } from "@/components/similar-tracks-modal";
import { toggleFavorite, setTrackRating } from "@/actions/tracks";

interface PlaylistInfo {
    id: number;
    name: string;
    description: string | null;
    type: string | null;
    trackCount: number;
}

interface PlaylistsClientProps {
    playlists: PlaylistInfo[];
    tracks: (Track & { position: number })[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    activePlaylist?: PlaylistInfo;
    recommendedCategories: RecommendedCategory[];
}

export function PlaylistsClient({
    playlists,
    tracks,
    total,
    page,
    pageSize,
    totalPages,
    activePlaylist,
    recommendedCategories,
}: PlaylistsClientProps) {
    const player = usePlayer();
    const searchParams = useSearchParams();
    const router = useRouter();
    const activeId = searchParams.get("id");

    // Persist URL state so sidebar navigation restores it
    useRouteMemorySave("/playlists", searchParams.toString());

    // Dialogs
    const [createOpen, setCreateOpen] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [newName, setNewName] = useState("");
    const [newDesc, setNewDesc] = useState("");
    const [editName, setEditName] = useState("");

    // Track detail modal
    const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [similarOpen, setSimilarOpen] = useState(false);

    // Column management
    const { orderedColumns, visibleColumns, toggleColumn, isVisible, reorderColumns, resetToDefaults } = useColumnConfig("playlist-columns");

    const [isPending, startTransition] = useTransition();

    function navigatePlaylist(params: Record<string, string>) {
        const sp = new URLSearchParams(searchParams.toString());
        for (const [key, value] of Object.entries(params)) {
            if (value) sp.set(key, value);
            else sp.delete(key);
        }
        router.push(`/playlists?${sp.toString()}`);
    }

    function handlePageChange(newPage: number) {
        navigatePlaylist({ page: String(newPage) });
    }

    function generatePageNumbers(current: number, total: number): (number | "...")[] {
        if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
        const pages: (number | "...")[] = [1];
        if (current > 3) pages.push("...");
        for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) {
            pages.push(i);
        }
        if (current < total - 2) pages.push("...");
        pages.push(total);
        return pages;
    }

    function handlePlay(track: Track) {
        const trackList = tracks.map(({ position, ...t }) => t as Track);
        player.play(track, trackList);
    }

    function handleCreate() {
        if (!newName.trim()) return;
        startTransition(async () => {
            const pl = await createPlaylist(newName.trim(), newDesc.trim() || undefined);
            setCreateOpen(false);
            setNewName("");
            setNewDesc("");
            router.push(`/playlists?id=${pl.id}`);
            router.refresh();
        });
    }

    function handleEdit() {
        if (!activePlaylist || !editName.trim()) return;
        startTransition(async () => {
            await updatePlaylist(activePlaylist.id, { name: editName.trim() });
            setEditOpen(false);
            router.refresh();
        });
    }

    function handleDelete() {
        if (!activePlaylist) return;
        startTransition(async () => {
            await deletePlaylist(activePlaylist.id);
            setDeleteOpen(false);
            router.push("/playlists");
            router.refresh();
        });
    }

    function handleRemoveTrack(trackId: number) {
        if (!activePlaylist) return;
        startTransition(async () => {
            await removeTrackFromPlaylist(activePlaylist.id, trackId);
            router.refresh();
        });
    }

    async function handleExportPlaylist() {
        if (!activePlaylist) return;
        try {
            const xml = await exportPlaylistToXml(activePlaylist.id);
            downloadXml(xml, `${activePlaylist.name}.xml`);
        } catch (e) {
            console.error("Export failed:", e);
        }
    }

    async function handleExportAll() {
        try {
            const xml = await exportAllPlaylistsToXml();
            downloadXml(xml, "all-playlists.xml");
        } catch (e) {
            console.error("Export all failed:", e);
        }
    }

    function downloadXml(xml: string, filename: string) {
        const blob = new Blob([xml], { type: "application/xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div className="flex flex-col h-full">
            {/* Sticky Header */}
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 border-b border-border">
                {/* Header */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold">Playlists</h1>
                        <p className="text-[var(--muted-foreground)]">
                            {playlists.length} playlist{playlists.length !== 1 ? "s" : ""}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            onClick={handleExportAll}
                            disabled={playlists.length === 0}
                        >
                            <FileDown className="h-4 w-4" />
                            <span className="hidden sm:inline">Export All to XML</span>
                            <span className="sm:hidden">Export</span>
                        </Button>
                        <Button
                            size="sm"
                            className="gap-2"
                            onClick={() => {
                                setNewName("");
                                setNewDesc("");
                                setCreateOpen(true);
                            }}
                        >
                            <Plus className="h-4 w-4" />
                            New Playlist
                        </Button>
                    </div>
                </div>
            </div>

            {/* Scrollable Content Area */}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-3 sm:py-4 md:py-6">
                <div className="flex gap-6 h-full">
                    {/* Playlist List */}
                    <div className={cn(
                        "w-full md:w-72 shrink-0 space-y-1 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 overflow-y-auto",
                        activeId ? "hidden md:block" : "block"
                    )}>
                        {playlists.length === 0 ? (
                            <div className="py-8 text-center">
                                <ListMusic className="h-8 w-8 mx-auto mb-2 text-zinc-600" />
                                <p className="text-sm text-[var(--muted-foreground)]">
                                    No playlists yet
                                </p>
                                <p className="text-xs text-zinc-600 mt-1">
                                    Create one or import from rekordbox
                                </p>
                            </div>
                        ) : (
                            playlists.map((pl) => (
                                <div key={pl.id} className="group relative">
                                    <Link
                                        href={`/playlists?id=${pl.id}`}
                                        className={cn(
                                            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all hover:bg-[var(--accent)] pr-8",
                                            String(pl.id) === activeId &&
                                            "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                        )}
                                    >
                                        <ListMusic className="h-4 w-4 shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate font-medium">{pl.name}</p>
                                            <p className="text-xs text-[var(--muted-foreground)]">
                                                {String(pl.id) === activeId
                                                    ? `${formatNumber(total)} tracks`
                                                    : `${pl.trackCount} tracks`}
                                            </p>
                                        </div>
                                    </Link>
                                    <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                                        <PlaylistActions
                                            playlistId={pl.id}
                                            playlistName={pl.name}
                                            onMutate={() => router.refresh()}
                                        />
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Playlist Tracks */}
                    <div className={cn(
                        "flex-1 min-w-0",
                        activeId ? "block" : "hidden md:block"
                    )}>
                        {activePlaylist ? (
                            <div className="space-y-4">
                                {/* Playlist Header */}
                                <div className="flex items-center justify-between flex-wrap gap-3">
                                    <div className="flex items-center gap-3">
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="md:hidden h-9 w-9 shrink-0"
                                            onClick={() => router.push("/playlists")}
                                        >
                                            <ChevronLeft className="h-5 w-5" />
                                        </Button>
                                        <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-purple-500/20">
                                            <Music className="h-7 w-7 text-purple-400" />
                                        </div>
                                        <div>
                                            <h2 className="text-xl font-bold">
                                                {activePlaylist.name}
                                            </h2>
                                            <p className="text-sm text-[var(--muted-foreground)]">
                                                {formatNumber(total)} tracks
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={() => setSimilarOpen(true)}
                                        >
                                            <Sparkles className="h-3.5 w-3.5" />
                                            Similar
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={handleExportPlaylist}
                                        >
                                            <Download className="h-3.5 w-3.5" />
                                            Export XML
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5"
                                            onClick={() => {
                                                setEditName(activePlaylist.name);
                                                setEditOpen(true);
                                            }}
                                        >
                                            <Pencil className="h-3.5 w-3.5" />
                                            Rename
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="gap-1.5 text-rose-400 hover:text-rose-300 hover:border-rose-500/30"
                                            onClick={() => setDeleteOpen(true)}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Delete
                                        </Button>
                                    </div>
                                </div>

                                {/* Track Table */}
                                <div className="flex items-center justify-between text-sm text-[var(--muted-foreground)] mb-2">
                                    <span>
                                        {formatNumber((page - 1) * pageSize + 1)} – {formatNumber(Math.min(page * pageSize, total))} of {formatNumber(total)}
                                    </span>
                                    <ColumnManager
                                        orderedColumns={orderedColumns}
                                        visibleColumns={visibleColumns}
                                        onToggle={toggleColumn}
                                        onReorder={reorderColumns}
                                        onReset={resetToDefaults}
                                        availableColumns={["index", "play", "artwork", "artist", "title", "album", "bpm", "key", "genre", "energy", "rating", "duration", "favorites", "tags", "remove"]}
                                    />
                                </div>
                                <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow className="bg-[var(--card)] hover:bg-[var(--card)]">
                                                {orderedColumns.map((col) => {
                                                    switch (col) {
                                                        case "index": return <TableHead key={col} className="w-8 text-center">#</TableHead>;
                                                        case "play": return <TableHead key={col} className="w-10"></TableHead>;
                                                        case "artwork": return <TableHead key={col} className="w-10"></TableHead>;
                                                        case "artist": return <TableHead key={col}>Artist</TableHead>;
                                                        case "title": return <TableHead key={col}>Title</TableHead>;
                                                        case "album": return <TableHead key={col}>Album</TableHead>;
                                                        case "bpm": return <TableHead key={col} className="w-16 text-center">BPM</TableHead>;
                                                        case "key": return <TableHead key={col} className="w-14 text-center">Key</TableHead>;
                                                        case "genre": return <TableHead key={col} className="w-20">Genre</TableHead>;
                                                        case "energy": return <TableHead key={col} className="w-14 text-center">⚡</TableHead>;
                                                        case "rating": return <TableHead key={col} className="w-20 text-center">Rating</TableHead>;
                                                        case "duration": return <TableHead key={col} className="w-16 text-right">Time</TableHead>;
                                                        default: return null;
                                                    }
                                                })}
                                                <TableHead className="w-16"></TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {tracks.map((track, idx) => {
                                                const isCurrentTrack =
                                                    player.currentTrack?.id === track.id;
                                                const isPlayingThis =
                                                    isCurrentTrack && player.isPlaying;
                                                const tags: string[] = track.tags
                                                    ? JSON.parse(track.tags)
                                                    : [];

                                                return (
                                                    <TrackContextMenu
                                                        key={`${track.id}-${idx}`}
                                                        track={track}
                                                        playlistId={activePlaylist?.id}
                                                        showReorder
                                                        onOpenDetail={() => {
                                                            setSelectedTrack(track);
                                                            setModalOpen(true);
                                                        }}
                                                        onMutate={() => router.refresh()}
                                                    >
                                                        <TableRow
                                                            {...(isCurrentTrack ? { "data-playing-track": true } : {})}
                                                            className={cn(
                                                                "group cursor-pointer",
                                                                isCurrentTrack
                                                                    ? "bg-purple-500/5 border-l-2 border-l-purple-500"
                                                                    : ""
                                                            )}
                                                            onClick={() => {
                                                                setSelectedTrack(track);
                                                                setModalOpen(true);
                                                            }}
                                                        >
                                                            {orderedColumns.map((col) => {
                                                                switch (col) {
                                                                    case "index": return (
                                                                        <TableCell key={col} className="text-center text-xs text-[var(--muted-foreground)]">
                                                                            {(page - 1) * pageSize + idx + 1}
                                                                        </TableCell>
                                                                    );
                                                                    case "play": return (
                                                                        <TableCell key={col} className="text-center p-0" onClick={(e) => e.stopPropagation()}>
                                                                            <button
                                                                                onClick={() => isPlayingThis ? player.pause() : handlePlay(track)}
                                                                                className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-purple-500/20 transition-colors mx-auto cursor-pointer"
                                                                            >
                                                                                {isPlayingThis ? (
                                                                                    <Pause className="h-3.5 w-3.5 text-purple-400" />
                                                                                ) : (
                                                                                    <Play className="h-3.5 w-3.5 ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                                                )}
                                                                            </button>
                                                                        </TableCell>
                                                                    );
                                                                    case "artwork": return (
                                                                        <TableCell key={col} className="p-0">
                                                                            <Artwork src={track.artworkUrl} size="sm" showPlaceholder={false} />
                                                                        </TableCell>
                                                                    );
                                                                    case "artist": return (
                                                                        <TableCell key={col} className="max-w-[180px] truncate text-sm">
                                                                            <span className={cn(isCurrentTrack && "text-purple-400")}>
                                                                                {track.artist || "Unknown"}
                                                                            </span>
                                                                        </TableCell>
                                                                    );
                                                                    case "title": return (
                                                                        <TableCell key={col} className="max-w-[220px] text-sm font-medium">
                                                                            <div className="truncate">
                                                                                <span className={cn(isCurrentTrack && "text-purple-400")}>
                                                                                    {track.title || track.filename}
                                                                                </span>
                                                                            </div>
                                                                            {tags.length > 0 && (
                                                                                <div className="mt-0.5"><TagBadges tags={tags} /></div>
                                                                            )}
                                                                        </TableCell>
                                                                    );
                                                                    case "album": return (
                                                                        <TableCell key={col} className="max-w-[150px] truncate text-sm text-[var(--muted-foreground)]">
                                                                            {track.album || "—"}
                                                                        </TableCell>
                                                                    );
                                                                    case "bpm": return (
                                                                        <TableCell key={col} className="text-center text-sm tabular-nums">
                                                                            {track.bpm ? Math.round(track.bpm) : "—"}
                                                                        </TableCell>
                                                                    );
                                                                    case "key": return (
                                                                        <TableCell key={col} className="text-center font-mono text-xs">
                                                                            {track.keyCamelot || "—"}
                                                                        </TableCell>
                                                                    );
                                                                    case "genre": return (
                                                                        <TableCell key={col}>
                                                                            {track.genre ? (
                                                                                <Badge className={cn("text-[10px] px-1.5 py-0", GENRE_COLORS[track.genre] || GENRE_COLORS.Other)}>
                                                                                    {track.genre}
                                                                                </Badge>
                                                                            ) : "—"}
                                                                        </TableCell>
                                                                    );
                                                                    case "energy": return (
                                                                        <TableCell key={col} className="text-center">
                                                                            {track.energy ? (
                                                                                <div className="flex items-center justify-center gap-1">
                                                                                    <span className={cn("inline-block h-2 w-2 rounded-full", ENERGY_COLORS[track.energy])} />
                                                                                    <span className="text-xs">{track.energy}</span>
                                                                                </div>
                                                                            ) : "—"}
                                                                        </TableCell>
                                                                    );
                                                                    case "rating": return (
                                                                        <TableCell key={col} className="text-center" onClick={(e) => e.stopPropagation()}>
                                                                            <StarRating
                                                                                value={track.rating}
                                                                                size="sm"
                                                                                onChange={async (r) => { await setTrackRating(track.id, r || null); router.refresh(); }}
                                                                            />
                                                                        </TableCell>
                                                                    );
                                                                    case "duration": return (
                                                                        <TableCell key={col} className="text-right text-xs tabular-nums text-[var(--muted-foreground)]">
                                                                            {formatDuration(track.duration)}
                                                                        </TableCell>
                                                                    );
                                                                    default: return null;
                                                                }
                                                            })}
                                                            <TableCell
                                                                className="p-0"
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <TrackActions
                                                                    track={track}
                                                                    playlistId={activePlaylist?.id}
                                                                    showReorder
                                                                    onOpenDetail={() => {
                                                                        setSelectedTrack(track);
                                                                        setModalOpen(true);
                                                                    }}
                                                                    onMutate={() => router.refresh()}
                                                                />
                                                            </TableCell>
                                                        </TableRow>
                                                    </TrackContextMenu>
                                                );
                                            })}
                                        </TableBody>
                                    </Table>
                                </div>

                                {/* Pagination */}
                                {totalPages > 1 && (
                                    <div className="flex items-center justify-between mt-4">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm text-[var(--muted-foreground)]">
                                                Page {page} of {totalPages}
                                            </span>
                                            <Select
                                                value={String(pageSize)}
                                                onChange={(e) =>
                                                    navigatePlaylist({ pageSize: e.target.value, page: "1" })
                                                }
                                                className="w-20 h-8 text-xs"
                                            >
                                                <option value="25">25</option>
                                                <option value="50">50</option>
                                                <option value="100">100</option>
                                            </Select>
                                            <span className="text-xs text-[var(--muted-foreground)]">
                                                per page
                                            </span>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <Button
                                                variant="outline"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={page <= 1}
                                                onClick={() => handlePageChange(1)}
                                            >
                                                <ChevronsLeft className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={page <= 1}
                                                onClick={() => handlePageChange(page - 1)}
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </Button>

                                            {generatePageNumbers(page, totalPages).map((p, i) =>
                                                p === "..." ? (
                                                    <span
                                                        key={`dots-${i}`}
                                                        className="px-1 text-[var(--muted-foreground)]"
                                                    >
                                                        …
                                                    </span>
                                                ) : (
                                                    <Button
                                                        key={p}
                                                        variant={p === page ? "default" : "outline"}
                                                        size="icon"
                                                        className="h-8 w-8"
                                                        onClick={() => handlePageChange(p as number)}
                                                    >
                                                        {p}
                                                    </Button>
                                                )
                                            )}

                                            <Button
                                                variant="outline"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={page >= totalPages}
                                                onClick={() => handlePageChange(page + 1)}
                                            >
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="icon"
                                                className="h-8 w-8"
                                                disabled={page >= totalPages}
                                                onClick={() => handlePageChange(totalPages)}
                                            >
                                                <ChevronsRight className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-8">
                                <div className="flex flex-col items-center justify-center py-8 text-[var(--muted-foreground)]">
                                    <ListMusic className="h-12 w-12 mb-4 opacity-50" />
                                    <p className="text-lg">Select a playlist</p>
                                    <p className="text-sm">
                                        Choose a playlist from the left to view tracks, or create a new
                                        one.
                                    </p>
                                </div>
                                <PlaylistRecommendations categories={recommendedCategories} />
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Create Playlist Dialog */}
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create New Playlist</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 py-4">
                        <div>
                            <label className="text-sm text-zinc-400 mb-1 block">Name</label>
                            <Input
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="My Playlist"
                                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                            />
                        </div>
                        <div>
                            <label className="text-sm text-zinc-400 mb-1 block">
                                Description (optional)
                            </label>
                            <Input
                                value={newDesc}
                                onChange={(e) => setNewDesc(e.target.value)}
                                placeholder="Description..."
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCreateOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleCreate} disabled={isPending || !newName.trim()}>
                            {isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : null}
                            Create
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Playlist Dialog */}
            <Dialog open={editOpen} onOpenChange={setEditOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Rename Playlist</DialogTitle>
                    </DialogHeader>
                    <div className="py-4">
                        <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleEdit()}
                        />
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleEdit} disabled={isPending || !editName.trim()}>
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Playlist Dialog */}
            <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Delete Playlist</DialogTitle>
                    </DialogHeader>
                    <p className="text-sm text-[var(--muted-foreground)] py-2">
                        Are you sure you want to delete &quot;{activePlaylist?.name}&quot;?
                        This will remove the playlist but not the actual tracks.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete} disabled={isPending}>
                            {isPending ? (
                                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            ) : null}
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Track Detail Modal */}
            <TrackDetailModal
                track={selectedTrack}
                open={modalOpen}
                onOpenChange={setModalOpen}
                onTrackUpdated={() => router.refresh()}
            />

            {/* Similar Tracks Modal */}
            {activePlaylist && (
                <SimilarTracksModal
                    open={similarOpen}
                    onOpenChange={setSimilarOpen}
                    playlistId={activePlaylist.id}
                    playlistName={activePlaylist.name}
                    onMutate={() => router.refresh()}
                />
            )}
        </div>
    );
}
