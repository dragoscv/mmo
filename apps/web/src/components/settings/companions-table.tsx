"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, DataTable, EmptyState, type DataTableColumnDef } from "@mmo/ui";
import { CopyIcon, ExternalLinkIcon, Laptop } from "lucide-react";
import { toast } from "sonner";
import { formatRelativeTime } from "@/lib/relative-time";

/** Serialised `devices` row (dates as ISO strings) — safe to pass from a server page. */
export interface CompanionRow {
    id: string;
    name: string;
    platform: string | null;
    version: string | null;
    lanUrl: string | null;
    lastSeenAt: string | null;
    status: string;
}

/** Serialised `companion_devices` row. */
export interface CompanionConfigRow {
    id: number;
    machineId: string;
    hostname: string | null;
    platform: string | null;
    friendlyName: string | null;
    publicIp: string | null;
    lastSeen: string | null;
    capabilities: Record<string, unknown>;
}

function StatusBadge({ status }: { status: string }) {
    const t = useTranslations("tables.companions");
    if (status === "online") return <Badge variant="success">{t("online")}</Badge>;
    if (status === "offline") return <Badge variant="secondary">{t("offline")}</Badge>;
    if (status === "error" || status === "revoked") return <Badge variant="destructive">{status}</Badge>;
    return <Badge variant="secondary">{status}</Badge>;
}

function RowActions({ row }: { row: CompanionRow }) {
    const tc = useTranslations("tables.common");
    if (!row.lanUrl) return <span className="text-muted-foreground">—</span>;
    return (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon-sm" aria-label={tc("open")} render={<a href={row.lanUrl} target="_blank" rel="noreferrer" />}>
                <ExternalLinkIcon />
            </Button>
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label={tc("copy")}
                onClick={async () => {
                    await navigator.clipboard.writeText(row.lanUrl!);
                    toast.success(tc("copied"));
                }}
            >
                <CopyIcon />
            </Button>
        </div>
    );
}

export function CompanionsTable({ rows }: { rows: CompanionRow[] }) {
    const t = useTranslations("tables.companions");
    const tc = useTranslations("tables.common");
    const locale = useLocale();

    const columns = useMemo<Array<DataTableColumnDef<CompanionRow, any>>>(
        () => [
            { accessorKey: "name", header: t("name"), cell: ({ row }) => <span className="font-medium">{row.original.name}</span>, meta: { priority: 1 } },
            { accessorKey: "platform", header: t("platform"), cell: ({ getValue }) => getValue<string | null>() ?? "—", meta: { priority: 2 } },
            { accessorKey: "version", header: t("version"), cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string | null>() ?? "—"}</span>, meta: { priority: 3 } },
            {
                accessorKey: "lanUrl",
                header: t("lanUrl"),
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue<string | null>() ?? "—"}</span>,
                meta: { priority: 2, hideBelow: "md" },
            },
            {
                accessorKey: "lastSeenAt",
                header: t("lastSeen"),
                cell: ({ getValue }) => {
                    const iso = getValue<string | null>();
                    return <span title={iso ? new Date(iso).toLocaleString(locale) : undefined}>{formatRelativeTime(iso, locale) ?? tc("never")}</span>;
                },
                sortingFn: "datetime",
                meta: { priority: 1 },
            },
            { accessorKey: "status", header: t("status"), cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />, meta: { priority: 1 } },
            { id: "actions", header: tc("actions"), enableSorting: false, cell: ({ row }) => <RowActions row={row.original} />, meta: { priority: 1, align: "right" } },
        ],
        [t, tc, locale],
    );

    return (
        <DataTable
            columns={columns}
            data={rows}
            getRowId={(r) => r.id}
            pagination={rows.length > 25}
            emptyState={<EmptyState variant="inline" icon={<Laptop aria-hidden />} title={t("empty")} description={t("emptyDetail")} />}
            mobileCard={(row) => (
                <div className="flex flex-col gap-2">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <div className="truncate font-medium">{row.name}</div>
                            <div className="text-xs text-muted-foreground">
                                {row.platform ?? "—"}
                                {row.version ? ` · ${row.version}` : ""}
                            </div>
                        </div>
                        <StatusBadge status={row.status} />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>{formatRelativeTime(row.lastSeenAt, locale) ?? tc("never")}</span>
                        <RowActions row={row} />
                    </div>
                </div>
            )}
        />
    );
}

export function CompanionConfigsTable({ rows }: { rows: CompanionConfigRow[] }) {
    const t = useTranslations("tables.companions");
    const tc = useTranslations("tables.common");
    const locale = useLocale();

    const columns = useMemo<Array<DataTableColumnDef<CompanionConfigRow, any>>>(
        () => [
            {
                id: "name",
                accessorFn: (r) => r.friendlyName ?? r.hostname ?? r.machineId,
                header: t("name"),
                cell: ({ row }) => (
                    <div className="min-w-0">
                        <div className="truncate font-medium">{row.original.friendlyName ?? row.original.hostname ?? row.original.machineId}</div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground">{row.original.machineId}</div>
                    </div>
                ),
                meta: { priority: 1 },
            },
            { accessorKey: "platform", header: t("configPlatform"), cell: ({ getValue }) => getValue<string | null>() ?? "—", meta: { priority: 2 } },
            {
                accessorKey: "publicIp",
                header: "IP",
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue<string | null>() ?? "—"}</span>,
                meta: { priority: 3, hideBelow: "md" },
            },
            {
                accessorKey: "lastSeen",
                header: t("configUpdated"),
                cell: ({ getValue }) => formatRelativeTime(getValue<string | null>(), locale) ?? tc("never"),
                sortingFn: "datetime",
                meta: { priority: 2 },
            },
        ],
        [t, tc, locale],
    );

    return (
        <DataTable
            columns={columns}
            data={rows}
            getRowId={(r) => String(r.id)}
            pagination={rows.length > 25}
            mobileCard={(row) => (
                <div className="flex flex-col gap-1">
                    <div className="truncate font-medium">{row.friendlyName ?? row.hostname ?? row.machineId}</div>
                    <div className="text-xs text-muted-foreground">
                        {row.platform ?? "—"} · {formatRelativeTime(row.lastSeen, locale) ?? tc("never")}
                    </div>
                </div>
            )}
        />
    );
}
