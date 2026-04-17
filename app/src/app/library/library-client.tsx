"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRouteMemorySave, clearRouteMemory } from "@/hooks/use-route-memory";
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
import { ComboboxFilter } from "@/components/combobox-filter";
import { StarRating } from "@/components/star-rating";
import { FavoriteButton } from "@/components/favorite-button";
import { TagBadges } from "@/components/tag-input";
import { Artwork } from "@/components/artwork";
import { TrackDetailModal } from "@/components/track-detail-modal";
import { ColumnManager, useColumnConfig } from "@/components/column-manager";
import { MetadataLink } from "@/components/metadata-link";
import { usePlayer } from "@/components/player-context";
import { useSelection } from "@/components/selection-provider";
import { toggleFavorite, setTrackRating } from "@/actions/tracks";
import { TrackActions, TrackContextMenu } from "@/components/track-actions";
import { TrackAvailability } from "@/components/track-availability";
import { BulkActionsBar } from "@/components/bulk-actions-bar";
import {
    formatDuration,
    formatNumber,
    formatKey,
    getHarmonicColor,
    ENERGY_COLORS,
    ENERGY_LABELS,
    GENRE_COLORS,
    cn,
} from "@/lib/utils";
import { useDAWSettings } from "@/hooks/use-daw-settings";
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
    Check,
    EyeOff,
} from "lucide-react";
import Link from "next/link";
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
        artist: string;
        year: string;
        label: string;
        subgenre: string;
        mood: string;
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
    const selection = useSelection();
    const { noteNotations } = useDAWSettings();
    const pageTrackIds = useMemo(() => tracks.map((t) => t.id), [tracks]);
    const allPageSelected = pageTrackIds.length > 0 && pageTrackIds.every((id) => selection.isSelected(id));

    // Persist URL state so sidebar navigation restores it
    useRouteMemorySave("/library", searchParams.toString());

    // Track Detail Modal
    const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
    const [modalOpen, setModalOpen] = useState(false);

    // Column management
    const { orderedColumns, visibleColumns, toggleColumn, isVisible, reorderColumns, resetToDefaults } = useColumnConfig("library-columns");

    // Filters expanded
    const [showAdvanced, setShowAdvanced] = useState(
        !!(currentFilters.tag || currentFilters.rating || currentFilters.favorites || currentFilters.minBpm || currentFilters.maxBpm || currentFilters.album || currentFilters.artist || currentFilters.year || currentFilters.label || currentFilters.subgenre || currentFilters.mood)
    );

    // Combobox options
    const genreOptions = useMemo(() => genres.map((g) => ({ value: g, label: g })), [genres]);
    const keyOptions = useMemo(() => {
        const allKeys = keys.length > 0 ? keys : [
            "1A", "1B", "2A", "2B", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B",
            "7A", "7B", "8A", "8B", "9A", "9B", "10A", "10B", "11A", "11B", "12A", "12B",
        ];
        return allKeys.map((k) => ({ value: k, label: k }));
    }, [keys]);
    const energyOptions = useMemo(() => [1, 2, 3, 4, 5].map((e) => ({
        value: String(e),
        label: `${"★".repeat(e)} ${ENERGY_LABELS[e]}`,
    })), []);
    const ratingOptions = useMemo(() => [5, 4, 3, 2, 1].map((r) => ({
        value: String(r),
        label: `${"★".repeat(r)} (${r} star${r !== 1 ? "s" : ""})`,
    })), []);
    const tagOptions = useMemo(() => allTags.map((t) => ({ value: t, label: t })), [allTags]);

    // Multi-value filter helpers
    const genreValues = useMemo(() => currentFilters.genre ? currentFilters.genre.split(",") : [], [currentFilters.genre]);
    const keyValues = useMemo(() => currentFilters.key ? currentFilters.key.split(",") : [], [currentFilters.key]);
    const tagValues = useMemo(() => currentFilters.tag ? currentFilters.tag.split(",") : [], [currentFilters.tag]);

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
        clearRouteMemory("/library");
        setSearchInput("");
        router.push("/library");
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
        currentFilters.album ||
        currentFilters.artist ||
        currentFilters.year ||
        currentFilters.label ||
        currentFilters.subgenre ||
        currentFilters.mood;

    const hasNonDefaultState =
        hasFilters ||
        currentSort !== "addedAt" ||
        currentOrder !== "desc" ||
        page !== 1;

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
        <div className="flex flex-col h-full">
            {/* Sticky Header + Filters */}
            <div className="shrink-0 sticky top-0 z-20 bg-background/95 backdrop-blur-sm px-3 sm:px-4 md:px-6 pt-3 sm:pt-4 md:pt-6 pb-3 space-y-3 border-b border-border">
                {/* Header */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-bold">Library</h1>
                        <p className="text-[var(--muted-foreground)]">
                            {formatNumber(total)} track{total !== 1 ? "s" : ""} in library
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
                        <Link
                            href="/library/hidden"
                            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--muted-foreground)] hover:text-orange-400 hover:border-orange-500/30 hover:bg-orange-500/5 transition-colors"
                        >
                            <EyeOff className="h-3.5 w-3.5" />
                            Hidden
                        </Link>
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
                                    className="w-full max-w-56 h-8 text-sm pl-8"
                                />
                            </div>
                            <Button type="submit" size="sm" variant="secondary" className="h-8">
                                Search
                            </Button>
                        </form>

                        <ComboboxFilter
                            multiple
                            options={genreOptions}
                            value={genreValues}
                            onChange={(vals) => handleFilter("genre", vals.join(",") || "")}
                            placeholder="All Genres"
                            triggerClassName="w-36"
                        />

                        <ComboboxFilter
                            options={energyOptions}
                            value={currentFilters.energy}
                            onChange={(val) => handleFilter("energy", val)}
                            placeholder="All Energy"
                            triggerClassName="w-32"
                        />

                        <ComboboxFilter
                            multiple
                            options={keyOptions}
                            value={keyValues}
                            onChange={(vals) => handleFilter("key", vals.join(",") || "")}
                            placeholder="All Keys"
                            triggerClassName="w-28"
                        />

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

                        {hasNonDefaultState && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs gap-1"
                                onClick={clearAllFilters}
                            >
                                <X className="h-3 w-3" />
                                Reset
                            </Button>
                        )}

                        <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                            {startIdx + 1}–{Math.min(startIdx + pageSize, total)} of{" "}
                            {formatNumber(total)}
                        </span>
                    </div>

                    {/* Advanced Filters */}
                    {showAdvanced && (
                        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[var(--border)]">
                            <ComboboxFilter
                                options={ratingOptions}
                                value={currentFilters.rating}
                                onChange={(val) => handleFilter("rating", val)}
                                placeholder="All Ratings"
                                triggerClassName="w-36"
                            />

                            <ComboboxFilter
                                multiple
                                options={tagOptions}
                                value={tagValues}
                                onChange={(vals) => handleFilter("tag", vals.join(",") || "")}
                                placeholder="All Tags"
                                triggerClassName="w-40"
                            />

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

                {/* Active Metadata Filter Badges */}
                {(currentFilters.artist || currentFilters.label || currentFilters.year || currentFilters.subgenre || currentFilters.mood) && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-[var(--muted-foreground)]">Filtered by:</span>
                        {currentFilters.artist && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                Artist: {currentFilters.artist}
                                <button onClick={() => handleFilter("artist", "")} className="ml-0.5 hover:text-destructive">
                                    <X className="h-3 w-3" />
                                </button>
                            </Badge>
                        )}
                        {currentFilters.label && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                Label: {currentFilters.label}
                                <button onClick={() => handleFilter("label", "")} className="ml-0.5 hover:text-destructive">
                                    <X className="h-3 w-3" />
                                </button>
                            </Badge>
                        )}
                        {currentFilters.year && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                Year: {currentFilters.year}
                                <button onClick={() => handleFilter("year", "")} className="ml-0.5 hover:text-destructive">
                                    <X className="h-3 w-3" />
                                </button>
                            </Badge>
                        )}
                        {currentFilters.subgenre && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                Subgenre: {currentFilters.subgenre}
                                <button onClick={() => handleFilter("subgenre", "")} className="ml-0.5 hover:text-destructive">
                                    <X className="h-3 w-3" />
                                </button>
                            </Badge>
                        )}
                        {currentFilters.mood && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                Mood: {currentFilters.mood}
                                <button onClick={() => handleFilter("mood", "")} className="ml-0.5 hover:text-destructive">
                                    <X className="h-3 w-3" />
                                </button>
                            </Badge>
                        )}
                    </div>
                )}
            </div>

            {/* Scrollable Table Area */}
            <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-4 md:px-6 py-3 sm:py-4 md:py-4 space-y-3">
                {/* Track Table */}
                <div className="flex items-center justify-end">
                    <ColumnManager
                        orderedColumns={orderedColumns}
                        visibleColumns={visibleColumns}
                        onToggle={toggleColumn}
                        onReorder={reorderColumns}
                        onReset={resetToDefaults}
                        availableColumns={["index", "play", "artwork", "favorites", "artist", "title", "album", "bpm", "key", "genre", "energy", "rating", "duration", "bitrate", "format", "sampleRate", "year", "label"]}
                    />
                </div>
                {selection.count > 0 && (
                    <BulkActionsBar onDone={() => router.refresh()} />
                )}
                <div className="rounded-lg border border-[var(--border)] overflow-x-auto">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-[var(--card)] hover:bg-[var(--card)]">
                                <TableHead className="w-8 px-2">
                                    <button
                                        onClick={() => selection.toggleAll(pageTrackIds)}
                                        className={cn(
                                            "flex h-4 w-4 items-center justify-center rounded border transition-colors cursor-pointer",
                                            allPageSelected
                                                ? "bg-purple-500 border-purple-500"
                                                : "border-[var(--border)] hover:border-purple-500/50"
                                        )}
                                    >
                                        {allPageSelected && <Check className="h-3 w-3 text-primary-foreground" />}
                                    </button>
                                </TableHead>
                                {orderedColumns.map((col) => {
                                    switch (col) {
                                        case "index": return <TableHead key={col} className="w-8 text-center">#</TableHead>;
                                        case "play": return <TableHead key={col} className="w-8"></TableHead>;
                                        case "artwork": return <TableHead key={col} className="w-10"></TableHead>;
                                        case "favorites": return <TableHead key={col} className="w-6"></TableHead>;
                                        case "artist": return (
                                            <TableHead key={col} className="cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("artist")}>
                                                Artist <SortIcon column="artist" />
                                            </TableHead>
                                        );
                                        case "title": return (
                                            <TableHead key={col} className="cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("title")}>
                                                Title <SortIcon column="title" />
                                            </TableHead>
                                        );
                                        case "album": return <TableHead key={col}>Album</TableHead>;
                                        case "bpm": return (
                                            <TableHead key={col} className="w-16 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("bpm")}>
                                                BPM <SortIcon column="bpm" />
                                            </TableHead>
                                        );
                                        case "key": return (
                                            <TableHead key={col} className="w-20 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("key")}>
                                                Key <SortIcon column="key" />
                                            </TableHead>
                                        );
                                        case "genre": return (
                                            <TableHead key={col} className="w-24 cursor-pointer select-none hover:text-[var(--foreground)]" onClick={() => handleSort("genre")}>
                                                Genre <SortIcon column="genre" />
                                            </TableHead>
                                        );
                                        case "energy": return (
                                            <TableHead key={col} className="w-14 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("energy")}>
                                                ⚡ <SortIcon column="energy" />
                                            </TableHead>
                                        );
                                        case "rating": return (
                                            <TableHead key={col} className="w-24 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("rating")}>
                                                Rating <SortIcon column="rating" />
                                            </TableHead>
                                        );
                                        case "duration": return (
                                            <TableHead key={col} className="w-16 cursor-pointer select-none text-right hover:text-[var(--foreground)]" onClick={() => handleSort("duration")}>
                                                Time <SortIcon column="duration" />
                                            </TableHead>
                                        );
                                        case "bitrate": return (
                                            <TableHead key={col} className="w-16 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("bitrate")}>
                                                Bitrate <SortIcon column="bitrate" />
                                            </TableHead>
                                        );
                                        case "format": return (
                                            <TableHead key={col} className="w-14 text-center">Format</TableHead>
                                        );
                                        case "year": return (
                                            <TableHead key={col} className="w-14 cursor-pointer select-none text-center hover:text-[var(--foreground)]" onClick={() => handleSort("year")}>
                                                Year <SortIcon column="year" />
                                            </TableHead>
                                        );
                                        case "label": return (
                                            <TableHead key={col} className="w-28">Label</TableHead>
                                        );
                                        case "sampleRate": return (
                                            <TableHead key={col} className="w-16 text-center">Sample Rate</TableHead>
                                        );
                                        default: return null;
                                    }
                                })}
                                <TableHead className="w-10"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {tracks.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={orderedColumns.length + 2} className="text-center py-12">
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
                                        <TrackContextMenu
                                            key={track.id}
                                            track={track}
                                            onOpenDetail={() => {
                                                setSelectedTrack(track);
                                                setModalOpen(true);
                                            }}
                                            onMutate={() => router.refresh()}
                                        >
                                            <TableRow
                                                {...(isCurrentTrack ? { "data-playing-track": true } : {})}
                                                className={cn(
                                                    "group cursor-pointer transition-colors",
                                                    selection.isSelected(track.id) && "bg-purple-500/5",
                                                    isCurrentTrack
                                                        ? "bg-purple-500/10 border-l-2 border-l-purple-500"
                                                        : harmonicColor
                                                )}
                                                onClick={() => {
                                                    setSelectedTrack(track);
                                                    setModalOpen(true);
                                                }}
                                            >
                                                <TableCell className="px-2" onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        onClick={() => selection.toggle(track.id)}
                                                        className={cn(
                                                            "flex h-4 w-4 items-center justify-center rounded border transition-colors cursor-pointer",
                                                            selection.isSelected(track.id)
                                                                ? "bg-purple-500 border-purple-500"
                                                                : "border-[var(--border)] hover:border-purple-500/50"
                                                        )}
                                                    >
                                                        {selection.isSelected(track.id) && <Check className="h-3 w-3 text-primary-foreground" />}
                                                    </button>
                                                </TableCell>
                                                {orderedColumns.map((col) => {
                                                    switch (col) {
                                                        case "index": return (
                                                            <TableCell key={col} className="text-center text-xs text-[var(--muted-foreground)]">
                                                                {startIdx + idx + 1}
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
                                                            <TableCell key={col} className="p-1">
                                                                <Artwork src={track.artworkUrl} size="sm" showPlaceholder={false} />
                                                            </TableCell>
                                                        );
                                                        case "favorites": return (
                                                            <TableCell key={col} className="p-0" onClick={(e) => e.stopPropagation()}>
                                                                <FavoriteButton
                                                                    isFavorite={!!track.isFavorite}
                                                                    size="sm"
                                                                    onChange={async () => { await toggleFavorite(track.id); router.refresh(); }}
                                                                />
                                                            </TableCell>
                                                        );
                                                        case "artist": return (
                                                            <TableCell key={col} className="max-w-[180px] truncate text-sm" onClick={(e) => e.stopPropagation()}>
                                                                <MetadataLink field="artist" value={track.artist} className={cn("text-sm", isCurrentTrack && "text-purple-400")}>
                                                                    {track.artist || "Unknown"}
                                                                </MetadataLink>
                                                            </TableCell>
                                                        );
                                                        case "title": return (
                                                            <TableCell key={col} className="max-w-[220px] text-sm">
                                                                <div className="truncate font-medium flex items-center gap-1">
                                                                    <span className={cn(
                                                                        isCurrentTrack && "text-purple-400",
                                                                        track.deviceId && "flex items-center gap-1"
                                                                    )}>
                                                                        {track.title || track.filename}
                                                                    </span>
                                                                    <TrackAvailability
                                                                        deviceId={track.deviceId}
                                                                        isDeviceOnline={true}
                                                                        isOfflineAvailable={track.isOfflineAvailable}
                                                                        compact
                                                                    />
                                                                </div>
                                                                <p className="truncate text-[10px] text-[var(--muted-foreground)]/50 mt-0.5" title={track.filepath}>
                                                                    {track.filepath}
                                                                </p>
                                                                {tags.length > 0 && (
                                                                    <div className="mt-0.5"><TagBadges tags={tags} /></div>
                                                                )}
                                                            </TableCell>
                                                        );
                                                        case "album": return (
                                                            <TableCell key={col} className="max-w-[150px] truncate text-sm text-[var(--muted-foreground)]" onClick={(e) => e.stopPropagation()}>
                                                                {track.album ? (
                                                                    <MetadataLink field="album" value={track.album} className="text-sm text-[var(--muted-foreground)]">
                                                                        {track.album}
                                                                    </MetadataLink>
                                                                ) : "—"}
                                                            </TableCell>
                                                        );
                                                        case "bpm": return (
                                                            <TableCell key={col} className="text-center text-sm tabular-nums">
                                                                {track.bpm ? Math.round(track.bpm) : "—"}
                                                            </TableCell>
                                                        );
                                                        case "key": return (
                                                            <TableCell key={col} className="text-center font-mono text-xs" onClick={(e) => e.stopPropagation()}>
                                                                {track.keyCamelot ? (
                                                                    <MetadataLink field="key" value={track.keyCamelot} className="font-mono text-xs">
                                                                        <span className="text-[var(--foreground)]">{formatKey(track.keyCamelot, noteNotations)}</span>
                                                                    </MetadataLink>
                                                                ) : "—"}
                                                            </TableCell>
                                                        );
                                                        case "genre": return (
                                                            <TableCell key={col} onClick={(e) => e.stopPropagation()}>
                                                                {track.genre ? (
                                                                    <MetadataLink field="genre" value={track.genre}>
                                                                        <Badge className={cn("text-[10px] px-1.5 py-0 cursor-pointer", GENRE_COLORS[track.genre] || GENRE_COLORS.Other)}>
                                                                            {track.genre}
                                                                        </Badge>
                                                                    </MetadataLink>
                                                                ) : (
                                                                    <span className="text-xs text-zinc-600">—</span>
                                                                )}
                                                            </TableCell>
                                                        );
                                                        case "energy": return (
                                                            <TableCell key={col} className="text-center">
                                                                {track.energy ? (
                                                                    <div className="flex items-center justify-center gap-1">
                                                                        <span className={cn("inline-block h-2 w-2 rounded-full", ENERGY_COLORS[track.energy])} />
                                                                        <span className="text-xs">{track.energy}</span>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-xs text-zinc-600">—</span>
                                                                )}
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
                                                        case "bitrate": return (
                                                            <TableCell key={col} className="text-center text-xs tabular-nums text-[var(--muted-foreground)]">
                                                                {track.bitrate ? `${track.bitrate}` : "—"}
                                                            </TableCell>
                                                        );
                                                        case "format": return (
                                                            <TableCell key={col} className="text-center">
                                                                {track.format ? (
                                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
                                                                        {track.format}
                                                                    </span>
                                                                ) : "—"}
                                                            </TableCell>
                                                        );
                                                        case "year": return (
                                                            <TableCell key={col} className="text-center text-xs tabular-nums text-[var(--muted-foreground)]">
                                                                {track.year || "—"}
                                                            </TableCell>
                                                        );
                                                        case "label": return (
                                                            <TableCell key={col} className="max-w-[120px] truncate text-xs text-[var(--muted-foreground)]">
                                                                {track.label || "—"}
                                                            </TableCell>
                                                        );
                                                        case "sampleRate": return (
                                                            <TableCell key={col} className="text-center text-xs tabular-nums text-[var(--muted-foreground)]">
                                                                {track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)}k` : "—"}
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
            </div>

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
