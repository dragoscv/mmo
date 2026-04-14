"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { Select } from "@/components/ui/select";
import { StarRating } from "@/components/star-rating";
import { FavoriteButton } from "@/components/favorite-button";
import { TagBadges } from "@/components/tag-input";
import { Artwork } from "@/components/artwork";
import { TrackDetailModal } from "@/components/track-detail-modal";
import { ColumnManager, useColumnConfig } from "@/components/column-manager";
import { usePlayer } from "@/components/player-context";
import { toggleFavorite, setTrackRating } from "@/actions/tracks";
import {
    formatDuration,
    formatKey,
    getHarmonicColor,
    ENERGY_COLORS,
    ENERGY_LABELS,
    GENRE_COLORS,
    cn,
} from "@/lib/utils";
import {
    Play,
    Pause,
    ChevronUp,
    ChevronDown,
    ChevronsLeft,
    ChevronLeft,
    ChevronRight,
    ChevronsRight,
    Heart,
    Search,
    X,
    SlidersHorizontal,
    ListPlus,
} from "lucide-react";
import type { Track } from "@/db/schema";

interface LibraryClientProps {
    tracks: Track[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    genres: string[];
    allTags: string[];
    keys: string[];
    currentSort: string;
    currentOrder: "asc" | "desc";
    currentFilters: {
        genre: string;
        search: string;
        energy: string;
        key: string;
        favorites: string;
        tag: string;
        rating: string;
        minBpm: string;
        maxBpm: string;
        album: string;
    };
}

export function LibraryClient({
    tracks,
    total,
    page,
    pageSize,
    totalPages,
    genres,
    allTags,
    keys,
    currentSort,
    currentOrder,
    currentFilters,
}: LibraryClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [searchInput, setSearchInput] = useState(currentFilters.search);
    const player = usePlayer();

    // Track Detail Modal
    const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
    const [modalOpen, setModalOpen] = useState(false);

    // Column management
    const { visibleColumns, toggleColumn, isVisible, resetToDefaults } = useColumnConfig("library-columns");

    // Filters expanded
    const [showAdvanced, setShowAdvanced] = useState(
        !!(currentFilters.tag || currentFilters.rating || currentFilters.favorites || currentFilters.minBpm || currentFilters.maxBpm || currentFilters.album)
    );

    const buildUrl = useCallback(
        (updates: Record<string, string | undefined>) => {
            const params = new URLSearchParams(searchParams.toString());
            for (const [key, value] of Object.entries(updates)) {
                if (value) {
                    params.set(key, value);
                } else {
                    params.delete(key);
                }
            }
            return `/library?${params.toString()}`;
        },
        [searchParams]
    );

    function navigate(updates: Record<string, string | undefined>) {
        router.push(buildUrl(updates));
    }

    function handleSort(column: string) {
        if (currentSort === column) {
            navigate({
                sort: column,
                order: currentOrder === "asc" ? "desc" : "asc",
            });
        } else {
            navigate({ sort: column, order: "asc", page: "1" });
        }
    }

    function handleFilter(key: string, value: string) {
        navigate({ [key]: value || undefined, page: "1" });
    }

    function handleSearch() {
        navigate({ search: searchInput || undefined, page: "1" });
    }

    function handlePageChange(newPage: number) {
        navigate({ page: String(newPage) });
    }

    function handlePlay(track: Track) {
        player.play(track, tracks);
    }

    function clearAllFilters() {
        navigate({
            genre: undefined,
            energy: undefined,
            search: undefined,
            key: undefined,
            favorites: undefined,
            tag: undefined,
            rating: undefined,
            minBpm: undefined,
            maxBpm: undefined,
            album: undefined,
            page: "1",
        });
        setSearchInput("");
    }

    const hasFilters =
        currentFilters.genre ||
        currentFilters.energy ||
        currentFilters.search ||
        currentFilters.key ||
        currentFilters.favorites ||
        currentFilters.tag ||
        currentFilters.rating ||
        currentFilters.minBpm ||
        currentFilters.maxBpm ||
        currentFilters.album;

    const SortIcon = ({ column }: { column: string }) => {
        if (currentSort !== column) return null;
        return currentOrder === "asc" ? (
            <ChevronUp className="inline h-3 w-3 ml-0.5" />
        ) : (
            <ChevronDown className="inline h-3 w-3 ml-0.5" />
        );
    };

    const startIdx = (page - 1) * pageSize;

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Library</h1>
                    <p className="text-[var(--muted-foreground)]">
                        {total.toLocaleString()} track{total !== 1 ? "s" : ""} in library
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant={currentFilters.favorites === "true" ? "default" : "outline"}
                        size="sm"
                        className="gap-2"
                        onClick={() =>
                            handleFilter(
                                "favorites",
                                currentFilters.favorites === "true" ? "" : "true"
                            )
                        }
                    >
                        <Heart
                            className={cn(
                                "h-3.5 w-3.5",
                                currentFilters.favorites === "true" && "fill-current"
                            )}
                        />
                        Favorites
                    </Button>
                </div>
            </div>

            {/* Filters Bar */}
            <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleSearch();
                        }}
                        className="flex gap-2"
                    >
                        <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                            <Input
                                placeholder="Search artist, title..."
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                className="w-56 h-8 text-sm pl-8"
                            />
                        </div>
                        <Button type="submit" size="sm" variant="secondary" className="h-8">
                            Search
                        </Button>
                    </form>

                    <Select
                        value={currentFilters.genre}
                        onChange={(e) => handleFilter("genre", e.target.value)}
                        className="w-36 h-8 text-sm"
                    >
                        <option value="">All Genres</option>
                        {genres.map((g) => (
                            <option key={g} value={g}>
                                {g}
                            </option>
                        ))}
                    </Select>

                    <Select
                        value={currentFilters.energy}
                        onChange={(e) => handleFilter("energy", e.target.value)}
                        className="w-32 h-8 text-sm"
                    >
                        <option value="">All Energy</option>
                        {[1, 2, 3, 4, 5].map((e) => (
                            <option key={e} value={String(e)}>
                                {"★".repeat(e)} {ENERGY_LABELS[e]}
                            </option>
                        ))}
                    </Select>

                    <Select
                        value={currentFilters.key}
                        onChange={(e) => handleFilter("key", e.target.value)}
                        className="w-24 h-8 text-sm"
                    >
                        <option value="">All Keys</option>
                        {keys.length > 0
                            ? keys.map((k) => (
                                <option key={k} value={k}>
                                    {k}
                                </option>
                            ))
                            : [
                                "1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B",
                                "7A", "7B", "8A", "8B", "9A", "9B", "10A", "10B", "11A", "11B", "12A", "12B",
                            ].map((k) => (
                                <option key={k} value={k}>
                                    {k}
                                </option>
                            ))}
                    </Select>

                    <Button
                        variant="ghost"
                        size="sm"
                        className={cn(
                            "h-8 gap-1.5",
                            showAdvanced && "text-purple-400"
                        )}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                    >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                        More
                    </Button>

                    {hasFilters && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs gap-1"
                            onClick={clearAllFilters}
                        >
                            <X className="h-3 w-3" />
                            Clear
                        </Button>
                    )}

                    <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                        {startIdx + 1}–{Math.min(startIdx + pageSize, total)} of{" "}
                        {total.toLocaleString()}
                    </span>
                </div>

                {/* Advanced Filters */}
                {showAdvanced && (
                    <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[var(--border)]">
                        <Select
                            value={currentFilters.rating}
                            onChange={(e) => handleFilter("rating", e.target.value)}
                            className="w-32 h-8 text-sm"
                        >
                            <option value="">All Ratings</option>
                            {[5, 4, 3, 2, 1].map((r) => (
                                <option key={r} value={String(r)}>
                                    {"★".repeat(r)} ({r} star{r !== 1 ? "s" : ""})
                                </option>
                            ))}
                        </Select>

                        <Select
                            value={currentFilters.tag}
                            onChange={(e) => handleFilter("tag", e.target.value)}
                            className="w-36 h-8 text-sm"
                        >
                            <option value="">All Tags</option>
                            {allTags.map((t) => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </Select>

                        <div className="flex items-center gap-1.5">
                            <span className="text-xs text-[var(--muted-foreground)]">BPM</span>
                            <Input
                                type="number"
                                placeholder="Min"
                                value={currentFilters.minBpm}
                                onChange={(e) => handleFilter("minBpm", e.target.value)}
                                className="w-16 h-8 text-sm text-center"
                                min={0}
                                max={300}
                            />
                            <span className="text-xs text-[var(--muted-foreground)]">–</span>
                            <Input
                                type="number"
                                placeholder="Max"
                                value={currentFilters.maxBpm}
                                onChange={(e) => handleFilter("maxBpm", e.target.value)}
                                className="w-16 h-8 text-sm text-center"
                                min={0}
                                max={300}
                            />
                        </div>

                        <Input
                            placeholder="Album..."
                            value={currentFilters.album}
                            onChange={(e) => handleFilter("album", e.target.value)}
                            className="w-36 h-8 text-sm"
                        />
                    </div>
                )}
            </div>

            {/* Track Table */}
            <div className="flex items-center justify-end mb-2">
                <ColumnManager
                    visibleColumns={visibleColumns}
                    onToggle={toggleColumn}
                    onReset={resetToDefaults}
                    availableColumns={["index", "play", "artwork", "favorites", "artist", "title", "album", "bpm", "key", "genre", "energy", "rating", "duration"]}
                />
            </div>
            <div className="rounded-lg border border-[var(--border)] overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-[var(--card)] hover:bg-[var(--card)]">
                            {isVisible("index") && <TableHead className="w-8 text-center">#</TableHead>}
                            {isVisible("play") && <TableHead className="w-8"></TableHead>}
                            {isVisible("artwork") && <TableHead className="w-10"></TableHead>}
                            {isVisible("favorites") && <TableHead className="w-6"></TableHead>}
                            {isVisible("artist") && (
                                <TableHead
                                    className="cursor-pointer select-none hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("artist")}
                                >
                                    Artist <SortIcon column="artist" />
                                </TableHead>
                            )}
                            {isVisible("title") && (
                                <TableHead
                                    className="cursor-pointer select-none hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("title")}
                                >
                                    Title <SortIcon column="title" />
                                </TableHead>
                            )}
                            {isVisible("album") && <TableHead>Album</TableHead>}
                            {isVisible("bpm") && (
                                <TableHead
                                    className="w-16 cursor-pointer select-none text-center hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("bpm")}
                                >
                                    BPM <SortIcon column="bpm" />
                                </TableHead>
                            )}
                            {isVisible("key") && (
                                <TableHead
                                    className="w-20 cursor-pointer select-none text-center hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("key")}
                                >
                                    Key <SortIcon column="key" />
                                </TableHead>
                            )}
                            {isVisible("genre") && (
                                <TableHead
                                    className="w-24 cursor-pointer select-none hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("genre")}
                                >
                                    Genre <SortIcon column="genre" />
                                </TableHead>
                            )}
                            {isVisible("energy") && (
                                <TableHead
                                    className="w-14 cursor-pointer select-none text-center hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("energy")}
                                >
                                    ⚡ <SortIcon column="energy" />
                                </TableHead>
                            )}
                            {isVisible("rating") && (
                                <TableHead
                                    className="w-24 cursor-pointer select-none text-center hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("rating")}
                                >
                                    Rating <SortIcon column="rating" />
                                </TableHead>
                            )}
                            {isVisible("duration") && (
                                <TableHead
                                    className="w-16 cursor-pointer select-none text-right hover:text-[var(--foreground)]"
                                    onClick={() => handleSort("duration")}
                                >
                                    Time <SortIcon column="duration" />
                                </TableHead>
                            )}
                            <TableHead className="w-10"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {tracks.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={12} className="text-center py-12">
                                    <p className="text-[var(--muted-foreground)]">
                                        No tracks found. Scan a folder or import from rekordbox.
                                    </p>
                                </TableCell>
                            </TableRow>
                        ) : (
                            tracks.map((track, idx) => {
                                const isCurrentTrack =
                                    player.currentTrack?.id === track.id;
                                const isPlayingThis = isCurrentTrack && player.isPlaying;
                                const tags: string[] = track.tags
                                    ? JSON.parse(track.tags)
                                    : [];

                                const harmonicColor = !isCurrentTrack && player.currentTrack
                                    ? getHarmonicColor(track.keyCamelot, player.currentTrack.keyCamelot)
                                    : "";

                                return (
                                    <TableRow
                                        key={track.id}
                                        className={cn(
                                            "group cursor-pointer transition-colors",
                                            isCurrentTrack
                                                ? "bg-purple-500/10 border-l-2 border-l-purple-500"
                                                : harmonicColor
                                        )}
                                        onClick={() => {
                                            setSelectedTrack(track);
                                            setModalOpen(true);
                                        }}
                                    >
                                        {isVisible("index") && (
                                            <TableCell className="text-center text-xs text-[var(--muted-foreground)]">
                                                {startIdx + idx + 1}
                                            </TableCell>
                                        )}
                                        {/* Play */}
                                        {isVisible("play") && (
                                            <TableCell
                                                className="text-center p-0"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <button
                                                    onClick={() =>
                                                        isPlayingThis
                                                            ? player.pause()
                                                            : handlePlay(track)
                                                    }
                                                    className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-purple-500/20 transition-colors mx-auto cursor-pointer"
                                                >
                                                    {isPlayingThis ? (
                                                        <Pause className="h-3.5 w-3.5 text-purple-400" />
                                                    ) : (
                                                        <Play className="h-3.5 w-3.5 ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                    )}
                                                </button>
                                            </TableCell>
                                        )}
                                        {/* Artwork */}
                                        {isVisible("artwork") && (
                                            <TableCell className="p-1">
                                                <Artwork
                                                    src={track.artworkUrl}
                                                    size="sm"
                                                    showPlaceholder={false}
                                                />
                                            </TableCell>
                                        )}
                                        {/* Favorite */}
                                        {isVisible("favorites") && (
                                            <TableCell
                                                className="p-0"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <FavoriteButton
                                                    isFavorite={!!track.isFavorite}
                                                    size="sm"
                                                    onChange={async () => {
                                                        await toggleFavorite(track.id);
                                                        router.refresh();
                                                    }}
                                                />
                                            </TableCell>
                                        )}
                                        {/* Artist */}
                                        {isVisible("artist") && (
                                            <TableCell className="max-w-[180px] truncate text-sm">
                                                <span
                                                    className={cn(
                                                        isCurrentTrack && "text-purple-400"
                                                    )}
                                                >
                                                    {track.artist || "Unknown"}
                                                </span>
                                            </TableCell>
                                        )}
                                        {/* Title + Tags */}
                                        {isVisible("title") && (
                                            <TableCell className="max-w-[220px] text-sm">
                                                <div className="truncate font-medium">
                                                    <span
                                                        className={cn(
                                                            isCurrentTrack && "text-purple-400"
                                                        )}
                                                    >
                                                        {track.title || track.filename}
                                                    </span>
                                                </div>
                                                {tags.length > 0 && (
                                                    <div className="mt-0.5">
                                                        <TagBadges tags={tags} />
                                                    </div>
                                                )}
                                            </TableCell>
                                        )}
                                        {/* Album */}
                                        {isVisible("album") && (
                                            <TableCell className="max-w-[150px] truncate text-sm text-[var(--muted-foreground)]">
                                                {track.album || "—"}
                                            </TableCell>
                                        )}
                                        {/* BPM */}
                                        {isVisible("bpm") && (
                                            <TableCell className="text-center text-sm tabular-nums">
                                                {track.bpm ? Math.round(track.bpm) : "—"}
                                            </TableCell>
                                        )}
                                        {/* Key */}
                                        {isVisible("key") && (
                                            <TableCell className="text-center font-mono text-xs">
                                                {track.keyCamelot ? (
                                                    <span title={`${track.keyCamelot} · ${track.keyMusical || ""}`}>
                                                        <span className="text-[var(--foreground)]">{track.keyCamelot}</span>
                                                        {" "}
                                                        <span className="text-[var(--muted-foreground)]">
                                                            {track.keyMusical || ""}
                                                        </span>
                                                    </span>
                                                ) : "—"}
                                            </TableCell>
                                        )}
                                        {/* Genre */}
                                        {isVisible("genre") && (
                                            <TableCell>
                                                {track.genre ? (
                                                    <Badge
                                                        className={cn(
                                                            "text-[10px] px-1.5 py-0",
                                                            GENRE_COLORS[track.genre] ||
                                                            GENRE_COLORS.Other
                                                        )}
                                                    >
                                                        {track.genre}
                                                    </Badge>
                                                ) : (
                                                    <span className="text-xs text-zinc-600">—</span>
                                                )}
                                            </TableCell>
                                        )}
                                        {/* Energy */}
                                        {isVisible("energy") && (
                                            <TableCell className="text-center">
                                                {track.energy ? (
                                                    <div className="flex items-center justify-center gap-1">
                                                        <span
                                                            className={cn(
                                                                "inline-block h-2 w-2 rounded-full",
                                                                ENERGY_COLORS[track.energy]
                                                            )}
                                                        />
                                                        <span className="text-xs">{track.energy}</span>
                                                    </div>
                                                ) : (
                                                    <span className="text-xs text-zinc-600">—</span>
                                                )}
                                            </TableCell>
                                        )}
                                        {/* Rating */}
                                        {isVisible("rating") && (
                                            <TableCell
                                                className="text-center"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <StarRating
                                                    value={track.rating}
                                                    size="sm"
                                                    onChange={async (r) => {
                                                        await setTrackRating(track.id, r || null);
                                                        router.refresh();
                                                    }}
                                                />
                                            </TableCell>
                                        )}
                                        {/* Duration */}
                                        {isVisible("duration") && (
                                            <TableCell className="text-right text-xs tabular-nums text-[var(--muted-foreground)]">
                                                {formatDuration(track.duration)}
                                            </TableCell>
                                        )}
                                        {/* Add to Queue */}
                                        <TableCell
                                            className="p-0"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <button
                                                onClick={() => player.addToQueue(track)}
                                                className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-purple-500/20 transition-all cursor-pointer"
                                                title="Add to queue"
                                            >
                                                <ListPlus className="h-3.5 w-3.5 text-purple-400" />
                                            </button>
                                        </TableCell>
                                    </TableRow>
                                );
                            })
                        )}
                    </TableBody>
                </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-[var(--muted-foreground)]">
                            Page {page} of {totalPages}
                        </span>
                        <Select
                            value={String(pageSize)}
                            onChange={(e) =>
                                navigate({ pageSize: e.target.value, page: "1" })
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
                                    key={`e-${i}`}
                                    className="px-2 text-sm text-[var(--muted-foreground)]"
                                >
                                    …
                                </span>
                            ) : (
                                <Button
                                    key={p}
                                    variant={p === page ? "default" : "outline"}
                                    size="icon"
                                    className="h-8 w-8 text-xs"
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

            {/* Track Detail Modal */}
            <TrackDetailModal
                track={selectedTrack}
                open={modalOpen}
                onOpenChange={setModalOpen}
                onTrackUpdated={() => router.refresh()}
                allTags={allTags}
            />
        </div>
    );
}

function generatePageNumbers(
    current: number,
    total: number
): (number | "...")[] {
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const pages: (number | "...")[] = [1];
    if (current > 3) pages.push("...");
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) {
        pages.push(i);
    }
    if (current < total - 2) pages.push("...");
    pages.push(total);
    return pages;
}
