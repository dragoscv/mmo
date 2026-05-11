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

import { useState, useTransition } from "react";
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
import { Loader2, Usb, Download, FileText, Disc3 } from "lucide-react";
import { toast } from "sonner";
import {
    exportPlaylistToCrate,
    exportAllPlaylistsToCrates,
    exportPlaylistToXml,
    exportAllPlaylistsToXml,
} from "@/actions/playlists";

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

    const canActive = activePlaylistId !== undefined;

    function handleExport() {
        if (!emitXml && !emitCrate) {
            toast.error("Pick at least one format");
            return;
        }
        if (scope === "active" && !canActive) {
            toast.error("No active playlist selected");
            return;
        }

        startTransition(async () => {
            try {
                if (scope === "active") {
                    const name = activePlaylistName ?? "playlist";
                    if (emitXml) {
                        const xml = await exportPlaylistToXml(activePlaylistId!);
                        downloadBlob(new Blob([xml], { type: "application/xml" }), `${name}.xml`);
                    }
                    if (emitCrate) {
                        const r = await exportPlaylistToCrate(activePlaylistId!, musicSubdir);
                        if (!r.success) {
                            toast.error(r.error);
                            return;
                        }
                        downloadBlob(base64ToBlob(r.base64), r.filename);
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
                        USB Export Wizard
                    </DialogTitle>
                    <DialogDescription>
                        Export your library or a single playlist to formats Rekordbox
                        and Serato can read directly from a USB drive.
                    </DialogDescription>
                </DialogHeader>

                {/* Scope */}
                <div className="space-y-3">
                    <Label>What to export</Label>
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
                            <div className="font-medium">Active playlist</div>
                            <div className="text-xs text-[var(--muted-foreground)] truncate">
                                {activePlaylistName ?? "(none selected)"}
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
                            <div className="font-medium">All playlists</div>
                            <div className="text-xs text-[var(--muted-foreground)]">
                                Full library
                            </div>
                        </button>
                    </div>
                </div>

                {/* Formats */}
                <div className="space-y-2">
                    <Label>Formats</Label>
                    <div className="space-y-2">
                        <label className="flex items-center gap-3 p-2 rounded-md border border-[var(--border)] hover:bg-[var(--accent)] cursor-pointer">
                            <Checkbox
                                checked={emitXml}
                                onChange={(e) => setEmitXml(e.target.checked)}
                            />
                            <FileText className="h-4 w-4 text-blue-400" />
                            <div className="flex-1">
                                <div className="text-sm font-medium">Rekordbox XML</div>
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
                                <div className="text-sm font-medium">Serato .crate</div>
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
                        <Label htmlFor="music-subdir">Music folder on USB</Label>
                        <Input
                            id="music-subdir"
                            value={musicSubdir}
                            onChange={(e) => setMusicSubdir(e.target.value)}
                            placeholder="Music"
                        />
                        <p className="text-xs text-[var(--muted-foreground)]">
                            Crates will reference paths like
                            {" "}<code>{musicSubdir || "Music"}/&lt;file&gt;.mp3</code>.
                            Copy your audio files to that folder on the USB drive.
                        </p>
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={pending}
                    >
                        Cancel
                    </Button>
                    <Button onClick={handleExport} disabled={pending}>
                        {pending ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <Download className="h-4 w-4 mr-2" />
                        )}
                        Export
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
