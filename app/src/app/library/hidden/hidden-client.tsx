"use client";

import { useState, useMemo, useTransition } from "react";
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
import { Artwork } from "@/components/artwork";
import { TrackContextMenu } from "@/components/track-actions";
import { useSelection } from "@/components/selection-provider";
import { unhideTracks } from "@/actions/tracks";
import { formatDuration, formatNumber, cn, GENRE_COLORS, ENERGY_COLORS } from "@/lib/utils";
import {
    Eye,
    Search,
    X,
    Check,
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    ArrowLeft,
    EyeOff,
    CheckSquare,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import type { Track } from "@/db/schema";

interface HiddenClientProps {
    tracks: Track[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    search: string;
}

export function HiddenClient({
    tracks,
    total,
    page,
    pageSize,
    totalPages,
    search,
}: HiddenClientProps) {
    const router = useRouter();
    const searchParams = useSearchParams();
    const [searchInput, setSearchInput] = useState(search);
    const selection = useSelection();
    const [isPending, startTransition] = useTransition();

    const pageTrackIds = useMemo(() => tracks.map((t) => t.id), [tracks]);
    const allPageSelected = pageTrackIds.length > 0 && pageTrackIds.every((id) => selection.isSelected(id));
    const selectedIds = Array.from(selection.selectedIds);

    function navigate(updates: Record<string, string | undefined>) {
        const params = new URLSearchParams(searchParams.toString());
        for (const [key, value] of Object.entries(updates)) {
            if (value) params.set(key, value);
            else params.delete(key);
        }
        router.push(`/library/hidden?${params.toString()}`);
    }

    function handleSearch() {
        navigate({ search: searchInput || undefined, page: "1" });
    }

    function handlePageChange(newPage: number) {
        navigate({ page: String(newPage) });
    }

    async function handleUnhide(ids: number[]) {
        startTransition(async () => {
            const result = await unhideTracks(ids);
            if (result.success) {
                toast.success(`Restored ${result.count} track${result.count !== 1 ? "s" : ""}`);
                selection.deselect(ids);
                router.refresh();
            }
        });
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-4">
                <Link
                    href="/library"
                    className="flex items-center gap-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                >
                    <ArrowLeft className="h-4 w-4" />
                    Library
                </Link>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                        <EyeOff className="h-6 w-6 text-orange-400" />
                        Hidden Tracks
                    </h1>
                    <p className="text-sm text-[var(--muted-foreground)]">
                        {formatNumber(total)} hidden track{total !== 1 ? "s" : ""}
                    </p>
                </div>
            </div>

            {/* Search + Bulk Actions */}
            <div className="flex flex-wrap items-center gap-2">
                <form
                    onSubmit={(e) => { e.preventDefault(); handleSearch(); }}
                    className="flex items-center gap-2"
                >
                    <Input
                        placeholder="Search hidden tracks..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="w-full max-w-64 h-8"
                    />
                    <Button type="submit" size="sm" variant="outline" className="h-8">
                        <Search className="h-3.5 w-3.5" />
                    </Button>
                    {search && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs gap-1"
                            onClick={() => { setSearchInput(""); navigate({ search: undefined, page: "1" }); }}
                        >
                            <X className="h-3 w-3" />
                            Clear
                        </Button>
                    )}
                </form>

                {selection.count > 0 && (
                    <div className="flex items-center gap-2 ml-4 rounded-lg border border-purple-500/30 bg-purple-500/5 px-3 py-1.5">
                        <span className="text-xs font-medium text-purple-400 flex items-center gap-1">
                            <CheckSquare className="h-3.5 w-3.5" />
                            {selection.count} selected
                        </span>
                        <button
                            onClick={() => handleUnhide(selectedIds)}
                            disabled={isPending}
                            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-[var(--foreground)] hover:bg-green-500/10 hover:text-green-400 transition-colors cursor-pointer disabled:opacity-50"
                        >
                            <Eye className="h-3.5 w-3.5" />
                            Restore
                        </button>
                        <button
                            onClick={() => selection.clear()}
                            className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                        >
                            <X className="h-3 w-3" />
                        </button>
                    </div>
                )}

                <span className="ml-auto text-xs text-[var(--muted-foreground)]">
                    {total > 0
                        ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${formatNumber(total)}`
                        : "No hidden tracks"}
                </span>
            </div>

            {/* Table */}
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
                            <TableHead className="w-10"></TableHead>
                            <TableHead>Artist</TableHead>
                            <TableHead>Title</TableHead>
                            <TableHead className="w-16 text-center">BPM</TableHead>
                            <TableHead className="w-20">Genre</TableHead>
                            <TableHead className="w-14 text-center">⚡</TableHead>
                            <TableHead className="w-16 text-right">Time</TableHead>
                            <TableHead className="w-20"></TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {tracks.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={9} className="text-center py-12">
                                    <p className="text-[var(--muted-foreground)]">
                                        No hidden tracks.
                                    </p>
                                </TableCell>
                            </TableRow>
                        ) : (
                            tracks.map((track, idx) => (
                                <TrackContextMenu key={track.id} track={track} onMutate={() => router.refresh()}>
                                    <TableRow
                                        className={cn(
                                            "group",
                                            selection.isSelected(track.id) && "bg-purple-500/5"
                                        )}
                                    >
                                        <TableCell className="px-2">
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
                                        <TableCell className="p-1">
                                            <Artwork src={track.artworkUrl} size="sm" showPlaceholder={false} />
                                        </TableCell>
                                        <TableCell className="max-w-[180px] truncate text-sm">
                                            {track.artist || "Unknown"}
                                        </TableCell>
                                        <TableCell className="max-w-[220px] text-sm font-medium">
                                            <div className="truncate">{track.title || track.filename}</div>
                                            <p className="truncate text-[10px] text-[var(--muted-foreground)]/50 mt-0.5" title={track.filepath}>
                                                {track.filepath}
                                            </p>
                                        </TableCell>
                                        <TableCell className="text-center text-sm tabular-nums">
                                            {track.bpm ? Math.round(track.bpm) : "—"}
                                        </TableCell>
                                        <TableCell>
                                            {track.genre ? (
                                                <Badge className={cn("text-[10px] px-1.5 py-0", GENRE_COLORS[track.genre] || GENRE_COLORS.Other)}>
                                                    {track.genre}
                                                </Badge>
                                            ) : "—"}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {track.energy ? (
                                                <div className="flex items-center justify-center gap-1">
                                                    <span className={cn("inline-block h-2 w-2 rounded-full", ENERGY_COLORS[track.energy])} />
                                                    <span className="text-xs">{track.energy}</span>
                                                </div>
                                            ) : "—"}
                                        </TableCell>
                                        <TableCell className="text-right text-xs tabular-nums text-[var(--muted-foreground)]">
                                            {formatDuration(track.duration)}
                                        </TableCell>
                                        <TableCell className="p-0">
                                            <button
                                                onClick={() => handleUnhide([track.id])}
                                                disabled={isPending}
                                                className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-green-400 hover:bg-green-500/10 transition-colors cursor-pointer opacity-0 group-hover:opacity-100 disabled:opacity-50"
                                            >
                                                <Eye className="h-3.5 w-3.5" />
                                                Restore
                                            </button>
                                        </TableCell>
                                    </TableRow>
                                </TrackContextMenu>
                            ))
                        )}
                    </TableBody>
                </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--muted-foreground)]">
                        Page {page} of {totalPages}
                    </span>
                    <div className="flex items-center gap-1">
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => handlePageChange(1)}>
                            <ChevronsLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => handlePageChange(page - 1)}>
                            <ChevronLeft className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => handlePageChange(page + 1)}>
                            <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => handlePageChange(totalPages)}>
                            <ChevronsRight className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
