"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, DataTable, EmptyState, type DataTableColumnDef } from "@mmo/ui";
import { Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Artwork } from "@/components/artwork";
import { TrackActions } from "@/components/track-actions";
import { useSelection } from "@/components/selection-provider";
import { unhideTracks } from "@/actions/tracks";
import { formatDuration, cn, GENRE_COLORS, ENERGY_COLORS } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/relative-time";
import type { Track } from "@/db/schema";

export function HiddenTable({ tracks }: { tracks: Track[] }) {
    const t = useTranslations("tables.hidden");
    const tc = useTranslations("tables.common");
    const locale = useLocale();
    const router = useRouter();
    const selection = useSelection();
    const [isPending, startTransition] = useTransition();
    const [selectedRows, setSelectedRows] = useState<Track[]>([]);

    const handleUnhide = useCallback(
        (ids: number[]) => {
            startTransition(async () => {
                const result = await unhideTracks(ids);
                if (result.success) {
                    toast.success(t("restored", { count: result.count }));
                    selection.deselect(ids);
                    router.refresh();
                } else {
                    toast.error(t("restoreFailed"), { description: result.error });
                }
            });
        },
        [router, selection, t],
    );

    const columns = useMemo<Array<DataTableColumnDef<Track, any>>>(
        () => [
            {
                id: "artwork",
                enableSorting: false,
                enableHiding: false,
                header: "",
                cell: ({ row }) => <Artwork src={row.original.artworkUrl} size="sm" showPlaceholder={false} />,
                meta: { priority: 1, className: "w-10 p-1" },
            },
            {
                id: "title",
                accessorFn: (r) => r.title || r.filename,
                header: t("title_col"),
                cell: ({ row }) => (
                    <div className="max-w-[260px] min-w-0">
                        <div className="truncate font-medium">{row.original.title || row.original.filename}</div>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground/60" title={row.original.filepath}>
                            {row.original.filepath}
                        </p>
                    </div>
                ),
                meta: { priority: 1 },
            },
            {
                accessorKey: "artist",
                header: t("artist"),
                cell: ({ getValue }) => <span className="block max-w-[180px] truncate">{getValue<string | null>() || tc("unknown")}</span>,
                meta: { priority: 1 },
            },
            {
                accessorKey: "album",
                header: t("album"),
                cell: ({ getValue }) => <span className="block max-w-[180px] truncate text-muted-foreground">{getValue<string | null>() || "—"}</span>,
                meta: { priority: 2, hideBelow: "sm" },
            },
            {
                accessorKey: "bpm",
                header: t("bpm"),
                cell: ({ getValue }) => {
                    const v = getValue<number | null>();
                    return <span className="tabular-nums">{v ? Math.round(v) : "—"}</span>;
                },
                meta: { priority: 3, align: "center", className: "w-16" },
            },
            {
                accessorKey: "genre",
                header: t("genre"),
                cell: ({ getValue }) => {
                    const g = getValue<string | null>();
                    return g ? <Badge variant="outline" className={cn("px-1.5 py-0 text-[10px]", GENRE_COLORS[g] || GENRE_COLORS.Other)}>{g}</Badge> : "—";
                },
                meta: { priority: 3, className: "w-24" },
            },
            {
                accessorKey: "energy",
                header: t("energy"),
                cell: ({ getValue }) => {
                    const e = getValue<number | null>();
                    return e ? (
                        <span className="inline-flex items-center gap-1">
                            <span className={cn("inline-block h-2 w-2 rounded-full", ENERGY_COLORS[e])} />
                            <span className="text-xs">{e}</span>
                        </span>
                    ) : (
                        "—"
                    );
                },
                meta: { priority: 3, align: "center", className: "w-16" },
            },
            {
                accessorKey: "duration",
                header: t("duration"),
                cell: ({ getValue }) => <span className="text-xs tabular-nums text-muted-foreground">{formatDuration(getValue<number | null>())}</span>,
                meta: { priority: 2, align: "right", className: "w-16" },
            },
            {
                id: "addedAt",
                accessorFn: (r) => (r.addedAt ? new Date(r.addedAt).getTime() : 0),
                header: t("addedAt"),
                cell: ({ row }) => {
                    const d = row.original.addedAt;
                    return <span className="text-xs text-muted-foreground" title={d ? new Date(d).toLocaleString(locale) : undefined}>{formatRelativeTime(d ? new Date(d) : null, locale) ?? "—"}</span>;
                },
                meta: { priority: 3, hideBelow: "md", className: "w-28" },
            },
            {
                id: "actions",
                enableSorting: false,
                enableHiding: false,
                header: "",
                cell: ({ row }) => (
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="sm" disabled={isPending} onClick={() => handleUnhide([row.original.id])}>
                            <Eye />
                            {t("unhide")}
                        </Button>
                        <TrackActions track={row.original} variant="icon" hideDeckActions onMutate={() => router.refresh()} />
                    </div>
                ),
                meta: { priority: 1, align: "right", className: "w-36" },
            },
        ],
        [t, tc, locale, isPending, handleUnhide, router],
    );

    const onSelectionChange = useCallback(
        (rows: Track[]) => {
            setSelectedRows(rows);
            const ids = rows.map((r) => r.id);
            // Mirror into the global selection provider so the player/bulk bar stays in sync.
            const current = selection.selectedIds;
            const toAdd = ids.filter((id) => !current.has(id));
            const toRemove = Array.from(current).filter((id) => !ids.includes(id) && tracks.some((tr) => tr.id === id));
            if (toAdd.length) selection.toggleAll(toAdd);
            if (toRemove.length) selection.deselect(toRemove);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tracks],
    );

    const selectedIds = selectedRows.map((r) => r.id);

    return (
        <DataTable
            columns={columns}
            data={tracks}
            getRowId={(r) => String(r.id)}
            enableSelection
            enableColumnVisibility
            pagination={false}
            onSelectionChange={onSelectionChange}
            emptyState={<EmptyState variant="inline" icon={<EyeOff aria-hidden />} title={t("empty")} description={t("emptyDetail")} />}
            toolbar={
                selectedIds.length > 0 ? (
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{t("selected", { count: selectedIds.length })}</span>
                        <Button size="sm" variant="secondary" loading={isPending} onClick={() => handleUnhide(selectedIds)}>
                            <Eye />
                            {t("unhideSelected", { count: selectedIds.length })}
                        </Button>
                    </div>
                ) : null
            }
            mobileCard={(row) => (
                <div className="flex items-center gap-3">
                    <Artwork src={row.artworkUrl} size="sm" showPlaceholder={false} />
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{row.title || row.filename}</div>
                        <div className="truncate text-xs text-muted-foreground">
                            {row.artist || "—"} · {formatDuration(row.duration)}
                        </div>
                    </div>
                    <Button variant="ghost" size="icon-sm" aria-label={t("unhide")} disabled={isPending} onClick={(e) => { e.stopPropagation(); handleUnhide([row.id]); }}>
                        <Eye />
                    </Button>
                </div>
            )}
        />
    );
}
