"use client";

/**
 * USB Export Wizard — bundles the existing rekordbox XML export and the
 * new Serato .crate export behind one dialog. Multi-file output goes
 * out as sequential downloads (browsers allow this after a single user
 * gesture, no zip dependency required).
 *
 * Audio file copy to the USB drive is companion-side (filesystem
 * access). This wizard only emits the metadata files; the user copies
 * tracks to `<USB>/<musicSubdir>/` themselves for now. A future batch
 * adds a one-click "copy audio" step via a companion endpoint.
 */

import { useState, useTransition, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Usb, Download, FileText, Disc3, GitCompareArrows } from "lucide-react";
import { toast } from "sonner";
import {
    exportPlaylistToCrate,
    exportAllPlaylistsToCrates,
    exportPlaylistToXml,
    exportAllPlaylistsToXml,
} from "@/actions/playlists";
import { getPlaylistTrackIds } from "@/actions/export-diff";
import {
    diffExport,
    getExportSnapshot,
    recordExportSnapshot,
    type ExportDiff,
} from "@/lib/export-history";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Optional active playlist for "current playlist" scope. */
    activePlaylistId?: number;
    activePlaylistName?: string;
}

type Scope = "active" | "all";

function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so the click had time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64ToBlob(b64: string, mime = "application/octet-stream"): Blob {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
}

export function UsbExportWizard({
    open,
    onOpenChange,
    activePlaylistId,
    activePlaylistName,
}: Props) {
    const [scope, setScope] = useState<Scope>(activePlaylistId ? "active" : "all");
    const [emitXml, setEmitXml] = useState(true);
    const [emitCrate, setEmitCrate] = useState(true);
    const [musicSubdir, setMusicSubdir] = useState("Music");
    const [pending, startTransition] = useTransition();
    const [xmlDiff, setXmlDiff] = useState<ExportDiff | null>(null);
    const [crateDiff, setCrateDiff] = useState<ExportDiff | null>(null);
    const t = useTranslations("usb");
    const tDiff = useTranslations("exportDiff");
    const tCommon = useTranslations("common");

    const canActive = activePlaylistId !== undefined;

    // Resolve a diff preview when the user has scope=active + a playlist
    // selected. The async resolver writes to state after a microtask, which
    // satisfies `react-hooks/set-state-in-effect`. Stale diffs are masked at
    // render-time by the same scope/canActive guard.
    useEffect(() => {
        if (!open || scope !== "active" || !canActive || activePlaylistId === undefined) {
            return;
        }
        let cancelled = false;
        getPlaylistTrackIds(activePlaylistId).then((r) => {
            if (cancelled || !r.ok) return;
            setXmlDiff(diffExport(getExportSnapshot("xml", activePlaylistId), r.trackIds));
            setCrateDiff(diffExport(getExportSnapshot("crate", activePlaylistId), r.trackIds));
        });
        return () => {
            cancelled = true;
        };
    }, [open, scope, canActive, activePlaylistId]);

    function handleExport() {
        if (!emitXml && !emitCrate) {
            toast.error(t("noFormatSelected"));
            return;
        }
        if (scope === "active" && !canActive) {
            toast.error(t("noFormatSelected"));
            return;
        }

        startTransition(async () => {
            try {
                if (scope === "active") {
                    const name = activePlaylistName ?? "playlist";
                    // Resolve the current track-id set once so we can both
                    // export and snapshot from the same source of truth.
                    const idsResult = await getPlaylistTrackIds(activePlaylistId!);
                    const currentIds = idsResult.ok ? idsResult.trackIds : null;
                    if (emitXml) {
                        const xml = await exportPlaylistToXml(activePlaylistId!);
                        downloadBlob(new Blob([xml], { type: "application/xml" }), `${name}.xml`);
                        if (currentIds) recordExportSnapshot("xml", activePlaylistId!, currentIds);
                    }
                    if (emitCrate) {
                        const r = await exportPlaylistToCrate(activePlaylistId!, musicSubdir);
                        if (!r.success) {
                            toast.error(r.error);
                            return;
                        }
                        downloadBlob(base64ToBlob(r.base64), r.filename);
                        if (currentIds) recordExportSnapshot("crate", activePlaylistId!, currentIds);
                    }
                    toast.success(`Exported "${name}"`);
                } else {
                    if (emitXml) {
                        const xml = await exportAllPlaylistsToXml();
                        downloadBlob(new Blob([xml], { type: "application/xml" }), "MMO-library.xml");
                    }
                    if (emitCrate) {
                        const r = await exportAllPlaylistsToCrates(musicSubdir);
                        if (!r.success) {
                            toast.error(r.error);
                            return;
                        }
                        // Browsers throttle bulk downloads; stagger lightly.
                        for (let i = 0; i < r.crates.length; i++) {
                            const c = r.crates[i];
                            downloadBlob(base64ToBlob(c.base64), c.filename);
                            if (i < r.crates.length - 1) {
                                await new Promise((res) => setTimeout(res, 100));
                            }
                        }
                        toast.success(`Exported ${r.crates.length} crates`);
                    } else {
                        toast.success("Exported library XML");
                    }
                }
                onOpenChange(false);
            } catch (e) {
                toast.error(e instanceof Error ? e.message : "Export failed");
            }
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Usb className="h-5 w-5 text-primary" />
                        {t("title")}
                    </DialogTitle>
                    <DialogDescription>
                        {t("subtitle")}
                    </DialogDescription>
                </DialogHeader>

                {/* Scope */}
                <div className="space-y-3">
                    <Label>{t("scope")}</Label>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            disabled={!canActive}
                            onClick={() => setScope("active")}
                            className={`p-3 rounded-lg border text-left text-sm transition-all ${
                                scope === "active"
                                    ? "border-primary bg-primary/10"
                                    : "border-[var(--border)] hover:bg-[var(--accent)]"
                            } ${!canActive ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                            <div className="font-medium">{t("scopeActive")}</div>
                            <div className="text-xs text-[var(--muted-foreground)] truncate">
                                {activePlaylistName ?? "—"}
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={() => setScope("all")}
                            className={`p-3 rounded-lg border text-left text-sm transition-all ${
                                scope === "all"
                                    ? "border-primary bg-primary/10"
                                    : "border-[var(--border)] hover:bg-[var(--accent)]"
                            }`}
                        >
                            <div className="font-medium">{t("scopeAll")}</div>
                            <div className="text-xs text-[var(--muted-foreground)]">
                                {tCommon("all")}
                            </div>
                        </button>
                    </div>
                </div>

                {/* Formats */}
                <div className="space-y-2">
                    <Label>{t("format")}</Label>
                    <div className="space-y-2">
                        <label className="flex items-center gap-3 p-2 rounded-md border border-[var(--border)] hover:bg-[var(--accent)] cursor-pointer">
                            <Checkbox
                                checked={emitXml}
                                onChange={(e) => setEmitXml(e.target.checked)}
                            />
                            <FileText className="h-4 w-4 text-blue-400" />
                            <div className="flex-1">
                                <div className="text-sm font-medium">{t("formatRekordbox")}</div>
                                <div className="text-xs text-[var(--muted-foreground)]">
                                    Import via File → Library → Import library
                                </div>
                            </div>
                        </label>
                        <label className="flex items-center gap-3 p-2 rounded-md border border-[var(--border)] hover:bg-[var(--accent)] cursor-pointer">
                            <Checkbox
                                checked={emitCrate}
                                onChange={(e) => setEmitCrate(e.target.checked)}
                            />
                            <Disc3 className="h-4 w-4 text-purple-400" />
                            <div className="flex-1">
                                <div className="text-sm font-medium">{t("formatSerato")}</div>
                                <div className="text-xs text-[var(--muted-foreground)]">
                                    Drop into <code>_Serato_/Subcrates/</code> on the USB
                                </div>
                            </div>
                        </label>
                    </div>
                </div>

                {/* Music subdir */}
                {emitCrate && (
                    <div className="space-y-1">
                        <Label htmlFor="music-subdir">{t("musicSubdir")}</Label>
                        <Input
                            id="music-subdir"
                            value={musicSubdir}
                            onChange={(e) => setMusicSubdir(e.target.value)}
                            placeholder="Music"
                        />
                        <p className="text-xs text-[var(--muted-foreground)]">
                            {t("musicSubdirHint")}
                        </p>
                    </div>
                )}

                {/* Diff preview (only for active-playlist scope with a snapshot to compare) */}
                {scope === "active" && canActive && (xmlDiff || crateDiff) && (
                    <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-sm space-y-2">
                        <div className="flex items-center gap-2 font-medium text-xs text-[var(--muted-foreground)]">
                            <GitCompareArrows className="h-3.5 w-3.5" />
                            {tDiff("title")}
                        </div>
                        {emitXml && xmlDiff && (
                            <DiffRow
                                label={tDiff("xmlLabel")}
                                diff={xmlDiff}
                                tDiff={tDiff}
                            />
                        )}
                        {emitCrate && crateDiff && (
                            <DiffRow
                                label={tDiff("crateLabel")}
                                diff={crateDiff}
                                tDiff={tDiff}
                            />
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={pending}
                    >
                        {tCommon("cancel")}
                    </Button>
                    <Button onClick={handleExport} disabled={pending}>
                        {pending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Download className="h-4 w-4 mr-2" />
                        )}
                        {pending ? t("exporting") : t("exportButton")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DiffRow({
    label,
    diff,
    tDiff,
}: {
    label: string;
    diff: ExportDiff;
    tDiff: ReturnType<typeof useTranslations>;
}) {
    if (!diff.hasPrevious) {
        return (
            <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">{label}</span>
                <span className="text-[var(--muted-foreground)]">{tDiff("firstExport")}</span>
            </div>
        );
    }
    const sinceDate = diff.previousAt ? new Date(diff.previousAt).toLocaleDateString() : "";
    return (
        <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="font-medium">{label}</span>
            <span className="text-emerald-400">+{diff.added.length}</span>
            <span className="text-rose-400">-{diff.removed.length}</span>
            <span className="text-[var(--muted-foreground)]">
                {tDiff("unchanged", { count: diff.unchanged.length })}
            </span>
            <span className="text-[var(--muted-foreground)] ml-auto">
                {tDiff("since", { date: sinceDate })}
            </span>
        </div>
    );
}
