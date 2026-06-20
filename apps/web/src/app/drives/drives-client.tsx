"use client";

import { useState, useEffect, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { detectDrives, cleanRekordboxDrive, type DetectedDrive } from "@/actions/drives";
import { RekordboxExportDialog } from "@/components/rekordbox-export-dialog";
import { useRenderCount } from "@/lib/dev-debugger";
import { formatBytes } from "@/lib/utils";
import { HardDrive, RefreshCw, Loader2, Usb, Disc3, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export function DrivesClient() {
    useRenderCount("Page:/drives");
    const [drives, setDrives] = useState<DetectedDrive[]>([]);
    const [isPending, startTransition] = useTransition();
    const [loaded, setLoaded] = useState(false);
    const [live, setLive] = useState(false);
    const [exportPath, setExportPath] = useState<string | null>(null);
    const [cleanTarget, setCleanTarget] = useState<DetectedDrive | null>(null);

    function loadDrives() {
        startTransition(async () => {
            const result = await detectDrives();
            setDrives(result);
            setLoaded(true);
        });
    }

    useEffect(() => {
        loadDrives();
    }, []);

    // Live auto-detect via the companion's drive-watch SSE stream. Falls back
    // silently to manual Refresh if the stream can't be opened.
    useEffect(() => {
        const es = new EventSource("/api/drives-watch");
        es.addEventListener("drives", (ev) => {
            try {
                const next = JSON.parse((ev as MessageEvent).data) as DetectedDrive[];
                setDrives(next);
                setLoaded(true);
                setLive(true);
            } catch {
                // ignore malformed payloads
            }
        });
        es.onerror = () => setLive(false);
        return () => es.close();
    }, []);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <p className="text-sm text-[var(--muted-foreground)]">
                    {drives.length} drive{drives.length !== 1 ? "-uri" : ""} detectate
                    {live && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs text-emerald-500">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            live
                        </span>
                    )}
                </p>
                <Button variant="outline" size="sm" onClick={loadDrives} disabled={isPending}>
                    {isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    Refresh
                </Button>
            </div>

            {!loaded && isPending ? (
                <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--muted-foreground)]" />
                </div>
            ) : drives.length === 0 ? (
                <p className="text-sm text-[var(--muted-foreground)]">
                    Niciun drive detectat.
                </p>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {drives.map((drive) => (
                        <DriveCard
                            key={drive.path}
                            drive={drive}
                            onExport={() => setExportPath(drive.path)}
                            onClean={() => setCleanTarget(drive)}
                        />
                    ))}
                </div>
            )}

            <RekordboxExportDialog
                open={exportPath !== null}
                onOpenChange={(o) => !o && setExportPath(null)}
                initialDestination={exportPath ?? undefined}
            />

            <CleanDialog
                key={cleanTarget?.path ?? "none"}
                drive={cleanTarget}
                onOpenChange={(o) => !o && setCleanTarget(null)}
                onDone={() => {
                    setCleanTarget(null);
                    loadDrives();
                }}
            />
        </div>
    );
}

function DriveCard({
    drive,
    onExport,
    onClean,
}: {
    drive: DetectedDrive;
    onExport: () => void;
    onClean: () => void;
}) {
    const usagePercent =
        drive.totalSize > 0 ? Math.round((drive.usedSpace / drive.totalSize) * 100) : 0;
    const fmt = drive.format?.toUpperCase();
    const cdjFriendly = fmt === "FAT32" || fmt === "EXFAT";
    const isNearFull = usagePercent > 90;
    const rb = drive.rekordbox ?? null;
    const hasLibrary = !!rb && (rb.hasClassic || rb.hasDeviceLibraryPlus || rb.hasOneLibrary);

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <HardDrive className="h-5 w-5" />
                        {drive.label || drive.path}
                    </div>
                    <Badge variant={cdjFriendly ? "default" : "secondary"} className="text-xs">
                        {drive.format || "Unknown"}
                    </Badge>
                </CardTitle>
                <p className="text-sm text-[var(--muted-foreground)]">{drive.path}</p>
            </CardHeader>
            <CardContent className="space-y-3">
                <Progress value={usagePercent} className={isNearFull ? "[&>div]:bg-red-500" : ""} />
                <div className="flex justify-between text-xs text-[var(--muted-foreground)]">
                    <span>{formatBytes(drive.usedSpace)} used</span>
                    <span>{formatBytes(drive.freeSpace)} free</span>
                </div>

                <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-xs">
                    <div className="mb-1 flex items-center gap-1.5 font-medium">
                        <Disc3 className="size-3.5" />
                        Rekordbox library
                    </div>
                    {hasLibrary ? (
                        <div className="space-y-1 text-[var(--muted-foreground)]">
                            <div>
                                {rb!.trackCount} track{rb!.trackCount !== 1 ? "s" : ""} ·{" "}
                                {formatBytes(rb!.dbBytes)} db
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {rb!.hasClassic && <Badge variant="secondary" className="text-[10px]">Classic</Badge>}
                                {rb!.hasDeviceLibraryPlus && <Badge variant="secondary" className="text-[10px]">Device Library Plus</Badge>}
                                {rb!.hasOneLibrary && <Badge variant="secondary" className="text-[10px]">OneLibrary</Badge>}
                            </div>
                        </div>
                    ) : (
                        <p className="text-[var(--muted-foreground)]">No rekordbox library on this drive.</p>
                    )}
                </div>

                {!cdjFriendly && (
                    <p className="flex items-center gap-1 text-xs text-amber-500">
                        <AlertTriangle className="size-3.5" />
                        CDJs prefer FAT32 / exFAT formatting.
                    </p>
                )}

                <div className="flex gap-2 pt-1">
                    <Button size="sm" className="flex-1" onClick={onExport}>
                        <Usb className="mr-1 size-4" />
                        Export here
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={onClean}
                        disabled={!hasLibrary}
                        title="Remove the rekordbox library from this drive"
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function CleanDialog({
    drive,
    onOpenChange,
    onDone,
}: {
    drive: DetectedDrive | null;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [includeOneLibrary, setIncludeOneLibrary] = useState(false);
    const [includeContents, setIncludeContents] = useState(false);
    const [busy, setBusy] = useState(false);

    async function run() {
        if (!drive) return;
        setBusy(true);
        const r = await cleanRekordboxDrive({ drive: drive.path, includeOneLibrary, includeContents });
        setBusy(false);
        if (r.success) {
            toast.success(`Cleaned rekordbox library (${r.removed ?? 0} item${r.removed === 1 ? "" : "s"} removed)`);
            onDone();
        } else {
            toast.error(r.error ?? "Failed to clean drive");
        }
    }

    return (
        <Dialog open={drive !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Trash2 className="size-5" />
                        Clean rekordbox library
                    </DialogTitle>
                    <DialogDescription>
                        Removes the rekordbox database + analysis files from{" "}
                        <span className="font-mono">{drive?.path}</span>. Audio under{" "}
                        <span className="font-mono">Contents/</span> is kept unless you tick the option below.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 py-2 text-sm">
                    <label className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            checked={includeOneLibrary}
                            disabled={busy}
                            onChange={(e) => setIncludeOneLibrary(e.target.checked)}
                        />
                        Also delete encrypted OneLibrary (<span className="font-mono">exportLibrary.db</span>)
                    </label>
                    <label className="flex items-center gap-2 text-amber-500">
                        <input
                            type="checkbox"
                            checked={includeContents}
                            disabled={busy}
                            onChange={(e) => setIncludeContents(e.target.checked)}
                        />
                        Also delete all audio (<span className="font-mono">Contents/</span>) — irreversible
                    </label>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                        Cancel
                    </Button>
                    <Button variant="destructive" onClick={run} disabled={busy}>
                        {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
                        Clean
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
