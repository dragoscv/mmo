"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Laptop, PencilIcon, QrCode, Radio, Trash2Icon } from "lucide-react";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    Badge,
    Button,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    DataTable,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    type DataTableColumnDef,
} from "@mmo/ui";
import { toast } from "sonner";
import { formatRelativeTime } from "@/lib/relative-time";
import { removeDevice, renameDevice } from "@/actions/devices";
import { QUALITY_PROFILES, type StreamQuality } from "@/lib/webrtc-audio-bridge";

/** Serialised `devices` row (dates as ISO strings). */
export interface DeviceRow {
    id: string;
    name: string;
    os: string | null;
    hostname: string | null;
    lanUrl: string | null;
    lastSeenAt: string | null;
    status: string;
    version: string | null;
}

// Same key `use-webrtc-audio-stream.ts` reads on connect.
const QUALITY_KEY = "webrtc-quality";
const QUALITIES = Object.keys(QUALITY_PROFILES) as StreamQuality[];

function readQuality(): StreamQuality {
    try {
        const v = localStorage.getItem(QUALITY_KEY) as StreamQuality | null;
        return v && v in QUALITY_PROFILES ? v : "balanced";
    } catch { return "balanced"; }
}

function StatusBadge({ status }: { status: string }) {
    const t = useTranslations("settings.devices");
    if (status === "online") return <Badge variant="success">{t("status.online")}</Badge>;
    if (status === "offline") return <Badge variant="secondary">{t("status.offline")}</Badge>;
    return <Badge variant="destructive">{status}</Badge>;
}

function RowActions({ row, onRename, onRemove }: { row: DeviceRow; onRename: (r: DeviceRow) => void; onRemove: (r: DeviceRow) => void }) {
    const t = useTranslations("settings.devices");
    return (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon-sm" aria-label={t("actions.rename")} onClick={() => onRename(row)}><PencilIcon /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={t("actions.remove")} onClick={() => onRemove(row)}><Trash2Icon /></Button>
        </div>
    );
}

export function DevicesSettingsPanel({ rows }: { rows: DeviceRow[] }) {
    const t = useTranslations("settings.devices");
    const locale = useLocale();
    const router = useRouter();
    const [pending, start] = useTransition();
    const [renaming, setRenaming] = useState<DeviceRow | null>(null);
    const [newName, setNewName] = useState("");
    const [removing, setRemoving] = useState<DeviceRow | null>(null);
    const [quality, setQuality] = useState<StreamQuality>(readQuality);

    const openRename = useCallback((r: DeviceRow) => { setRenaming(r); setNewName(r.name); }, []);

    const submitRename = () => {
        if (!renaming) return;
        const name = newName.trim();
        if (!name) return;
        const id = renaming.id;
        start(async () => {
            const res = await renameDevice(id, name);
            if ("error" in res) toast.error(res.error);
            else { toast.success(t("actions.renamed")); router.refresh(); }
            setRenaming(null);
        });
    };

    const submitRemove = () => {
        if (!removing) return;
        const id = removing.id;
        start(async () => {
            const res = await removeDevice(id);
            if ("error" in res) toast.error(res.error);
            else { toast.success(t("actions.removed")); router.refresh(); }
            setRemoving(null);
        });
    };

    const columns = useMemo<Array<DataTableColumnDef<DeviceRow, any>>>(
        () => [
            { accessorKey: "name", header: t("columns.name"), cell: ({ row }) => <span className="font-medium">{row.original.name}</span>, meta: { priority: 1 } },
            {
                accessorKey: "os",
                header: t("columns.platform"),
                cell: ({ row }) => row.original.os ?? row.original.hostname ?? "—",
                meta: { priority: 2 },
            },
            {
                accessorKey: "lanUrl",
                header: t("columns.lanUrl"),
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue<string | null>() ?? "—"}</span>,
                meta: { priority: 2, hideBelow: "md" },
            },
            {
                accessorKey: "lastSeenAt",
                header: t("columns.lastSeen"),
                cell: ({ getValue }) => {
                    const iso = getValue<string | null>();
                    return <span title={iso ? new Date(iso).toLocaleString(locale) : undefined}>{formatRelativeTime(iso, locale) ?? t("never")}</span>;
                },
                sortingFn: "datetime",
                meta: { priority: 1 },
            },
            { accessorKey: "status", header: t("columns.status"), cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />, meta: { priority: 1 } },
            { id: "actions", header: t("columns.actions"), enableSorting: false, cell: ({ row }) => <RowActions row={row.original} onRename={openRename} onRemove={setRemoving} />, meta: { priority: 1, align: "right" } },
        ],
        [t, locale, openRename],
    );

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>{t("list.title")}</CardTitle>
                    <CardDescription>{t("list.description")}</CardDescription>
                </CardHeader>
                <CardContent>
                    <DataTable
                        columns={columns}
                        data={rows}
                        getRowId={(r) => r.id}
                        pagination={rows.length > 25}
                        emptyState={<EmptyState variant="inline" icon={<Laptop aria-hidden />} title={t("list.empty")} description={t("list.emptyDetail")} />}
                        mobileCard={(row) => (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate font-medium">{row.name}</div>
                                        <div className="text-xs text-muted-foreground">{row.os ?? row.hostname ?? "—"}</div>
                                    </div>
                                    <StatusBadge status={row.status} />
                                </div>
                                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                                    <span>{formatRelativeTime(row.lastSeenAt, locale) ?? t("never")}</span>
                                    <RowActions row={row} onRename={openRename} onRemove={setRemoving} />
                                </div>
                            </div>
                        )}
                    />
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("remote.title")}</CardTitle>
                    <CardDescription>{t("remote.description")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="webrtc-quality">{t("remote.quality")}</Label>
                        <Select value={quality} onValueChange={(v) => { const q = v as StreamQuality; setQuality(q); try { localStorage.setItem(QUALITY_KEY, q); } catch { /* ignore */ } }}>
                            <SelectTrigger id="webrtc-quality" className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {QUALITIES.map((q) => (
                                    <SelectItem key={q} value={q}>{QUALITY_PROFILES[q].label} · {QUALITY_PROFILES[q].description}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{t("remote.qualityHint")}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" render={<Link href="/pair" />}><QrCode aria-hidden />{t("remote.pair")}</Button>
                        <Button variant="outline" render={<Link href="/remote" />}><Radio aria-hidden />{t("remote.open")}</Button>
                    </div>
                </CardContent>
            </Card>

            <Dialog open={renaming !== null} onOpenChange={(o) => { if (!o) setRenaming(null); }}>
                <DialogContent size="sm">
                    <DialogHeader>
                        <DialogTitle>{t("rename.title")}</DialogTitle>
                        <DialogDescription>{t("rename.description")}</DialogDescription>
                    </DialogHeader>
                    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); submitRename(); }}>
                        <Label htmlFor="device-rename">{t("rename.label")}</Label>
                        <Input id="device-rename" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} autoFocus />
                        <DialogFooter className="mt-2">
                            <Button type="button" variant="outline" onClick={() => setRenaming(null)}>{t("rename.cancel")}</Button>
                            <Button type="submit" loading={pending} disabled={!newName.trim()}>{t("rename.save")}</Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>

            <AlertDialog open={removing !== null} onOpenChange={(o) => { if (!o) setRemoving(null); }}>
                <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                        <AlertDialogTitle>{t("remove.title")}</AlertDialogTitle>
                        <AlertDialogDescription>{t("remove.body", { name: removing?.name ?? "" })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>{t("remove.cancel")}</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" loading={pending} onClick={submitRemove}>{t("remove.confirm")}</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
