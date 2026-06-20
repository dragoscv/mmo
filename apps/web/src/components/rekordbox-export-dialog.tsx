"use client";

/**
 * Rekordbox plug-and-play USB export dialog.
 *
 * Pairs with the companion endpoint `POST /library/rekordbox/export` via
 * the SSE-proxy Route Handler at `/api/rekordbox-export`. Writes a true
 * rekordbox USB (Contents/ audio + export.pdb + exportExt.pdb + USBANLZ
 * analysis) that plays standalone on CDJ/XDJ consoles with no re-import.
 *
 * The user picks a scope (active playlist / whole library), a destination
 * drive, a transcode policy, and optional auto-crates (By Genre/BPM/Key).
 * Progress streams in over SSE while the native sidecar does the work.
 */

import { useEffect, useRef, useState, useTransition } from "react";
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
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, AlertTriangle, Loader2, Usb, X } from "lucide-react";
import { toast } from "sonner";
import { summariseUsbScope, type UsbScopeSummary } from "@/actions/usb-copy";

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    activePlaylistId?: number;
    activePlaylistName?: string;
    /** Pre-fill the destination drive path (e.g. from the Drives manager). */
    initialDestination?: string;
}

type Scope = "active" | "all";
type Transcode = "none" | "incompatible" | "all";
type AutoCrate = "genre" | "bpm" | "key";

interface ProgressEvent {
    type: string;
    stage?: string;
    index?: number;
    total?: number;
    file?: string;
    error?: string;
    tracks?: number;
    playlists?: number;
    message?: string;
}

export function RekordboxExportDialog({
    open,
    onOpenChange,
    activePlaylistId,
    activePlaylistName,
    initialDestination,
}: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                {open && (
                    <RekordboxExportBody
                        activePlaylistId={activePlaylistId}
                        activePlaylistName={activePlaylistName}
                        initialDestination={initialDestination}
                        onClose={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function RekordboxExportBody({
    activePlaylistId,
    activePlaylistName,
    initialDestination,
    onClose,
}: {
    activePlaylistId?: number;
    activePlaylistName?: string;
    initialDestination?: string;
    onClose: () => void;
}) {
    const t = useTranslations("rekordboxExport");
    const [scope, setScope] = useState<Scope>(activePlaylistId ? "active" : "all");
    const [destination, setDestination] = useState(initialDestination ?? "");
    const [transcode, setTranscode] = useState<Transcode>("incompatible");
    const [autoCrates, setAutoCrates] = useState<AutoCrate[]>([]);
    const [writeAnlz, setWriteAnlz] = useState(true);
    const [summary, setSummary] = useState<UsbScopeSummary | null>(null);
    const [, startResolving] = useTransition();
    const [running, setRunning] = useState(false);
    const [events, setEvents] = useState<ProgressEvent[]>([]);
    const [stage, setStage] = useState<string>("");
    const [done, setDone] = useState<{ tracks: number; playlists: number } | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    const canActive = activePlaylistId !== undefined;

    useEffect(() => {
        startResolving(async () => {
            const r = await summariseUsbScope(
                scope === "active" ? "active" : "all",
                activePlaylistId,
            );
            setSummary(r);
        });
    }, [scope, activePlaylistId]);

    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    const trackCount = summary?.ok ? summary.trackIds.length : 0;
    const canStart =
        !running && destination.trim().length > 0 && trackCount > 0;

    function toggleCrate(c: AutoCrate) {
        setAutoCrates((prev) =>
            prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c],
        );
    }

    async function startExport() {
        if (destination.trim().length === 0) {
            toast.error(t("destinationRequired"));
            return;
        }
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setRunning(true);
        setEvents([]);
        setStage("");
        setDone(null);
        try {
            const res = await fetch("/api/rekordbox-export", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    trackIds: scope === "active" && summary?.ok ? summary.trackIds : undefined,
                    destination: destination.trim(),
                    autoCrates,
                    transcode,
                    writeAnlz,
                }),
                signal: ctrl.signal,
            });
            if (!res.ok || !res.body) {
                let detail = "";
                try { detail = (await res.json()).error ?? ""; } catch { /* ignore */ }
                toast.error(detail || `Export failed (${res.status})`);
                setRunning(false);
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (; ;) {
                const { value, done: streamDone } = await reader.read();
                if (streamDone) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    const raw = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    let data = "";
                    for (const line of raw.split("\n")) {
                        if (line.startsWith("data:")) data += line.slice(5).trim();
                    }
                    if (!data) continue;
                    let ev: ProgressEvent;
                    try { ev = JSON.parse(data) as ProgressEvent; } catch { continue; }
                    handleEvent(ev);
                }
            }
        } catch (e) {
            if ((e as Error).name !== "AbortError") {
                toast.error((e as Error).message);
            }
        } finally {
            setRunning(false);
            abortRef.current = null;
        }
    }

    function handleEvent(ev: ProgressEvent) {
        if (ev.type === "stage" && ev.stage) setStage(ev.stage);
        if (ev.type === "error" && ev.error) {
            setEvents((p) => [...p, ev]);
            toast.error(ev.error);
        }
        if (ev.type === "done") {
            setDone({ tracks: ev.tracks ?? trackCount, playlists: ev.playlists ?? 0 });
        }
        if (ev.type === "progress" || ev.type === "log") {
            setEvents((p) => [...p.slice(-200), ev]);
        }
    }

    function cancel() {
        abortRef.current?.abort();
        setRunning(false);
    }

    const lastProgress = [...events].reverse().find((e) => e.type === "progress");
    const pct =
        lastProgress?.index && lastProgress?.total
            ? Math.round((lastProgress.index / lastProgress.total) * 100)
            : running
                ? undefined
                : 0;
    const errorItems = events.filter((e) => e.type === "error" && e.error);

    return (
        <>
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Usb className="size-5" />
                    {t("title")}
                </DialogTitle>
                <DialogDescription>{t("subtitle")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
                {/* Scope */}
                <div className="space-y-2">
                    <Label>{t("scope")}</Label>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant={scope === "active" ? "default" : "outline"}
                            size="sm"
                            disabled={!canActive || running}
                            onClick={() => setScope("active")}
                        >
                            {t("scopeActive")}
                            {activePlaylistName ? ` · ${activePlaylistName}` : ""}
                        </Button>
                        <Button
                            type="button"
                            variant={scope === "all" ? "default" : "outline"}
                            size="sm"
                            disabled={running}
                            onClick={() => setScope("all")}
                        >
                            {t("scopeAll")}
                        </Button>
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)]">
                        {trackCount} tracks
                    </p>
                </div>

                {/* Destination */}
                <div className="space-y-2">
                    <Label htmlFor="rb-dest">{t("destination")}</Label>
                    <Input
                        id="rb-dest"
                        value={destination}
                        disabled={running}
                        onChange={(e) => setDestination(e.target.value)}
                        placeholder={t("destinationPlaceholder")}
                    />
                    <p className="text-xs text-[var(--muted-foreground)]">
                        {t("destinationHint")}
                    </p>
                </div>

                {/* Transcode */}
                <div className="space-y-2">
                    <Label>{t("transcode")}</Label>
                    <div className="flex gap-2">
                        {(["none", "incompatible", "all"] as const).map((m) => (
                            <Button
                                key={m}
                                type="button"
                                variant={transcode === m ? "default" : "outline"}
                                size="sm"
                                disabled={running}
                                onClick={() => setTranscode(m)}
                            >
                                {m === "none"
                                    ? t("transcodeNone")
                                    : m === "incompatible"
                                        ? t("transcodeIncompatible")
                                        : t("transcodeAll")}
                            </Button>
                        ))}
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)]">
                        {t("transcodeHint")}
                    </p>
                </div>

                {/* Auto-crates */}
                <div className="space-y-2">
                    <Label>{t("autoCrates")}</Label>
                    <div className="flex gap-2">
                        {(
                            [
                                ["genre", t("autoGenre")],
                                ["bpm", t("autoBpm")],
                                ["key", t("autoKey")],
                            ] as const
                        ).map(([c, label]) => (
                            <Button
                                key={c}
                                type="button"
                                variant={autoCrates.includes(c) ? "default" : "outline"}
                                size="sm"
                                disabled={running}
                                onClick={() => toggleCrate(c)}
                            >
                                {label}
                            </Button>
                        ))}
                    </div>
                </div>

                {/* Write analysis toggle */}
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={writeAnlz}
                        disabled={running}
                        onChange={(e) => setWriteAnlz(e.target.checked)}
                    />
                    {t("writeAnlz")}
                </label>

                {/* Progress */}
                {running && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm">
                            <Loader2 className="size-4 animate-spin" />
                            {stage || t("exporting")}
                        </div>
                        <Progress value={pct} />
                        {lastProgress?.file && (
                            <p className="truncate text-xs text-[var(--muted-foreground)]">
                                {lastProgress.file}
                            </p>
                        )}
                    </div>
                )}

                {done && (
                    <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-500">
                        <CheckCircle2 className="size-4" />
                        {t("doneSummary", { tracks: done.tracks, playlists: done.playlists })}
                    </div>
                )}

                {errorItems.length > 0 && (
                    <details className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                        <summary className="cursor-pointer font-medium text-amber-500">
                            <AlertTriangle className="mr-1 inline size-4" />
                            {t("errorsTitle")} ({errorItems.length})
                        </summary>
                        <ul className="mt-2 space-y-1 text-xs text-[var(--muted-foreground)]">
                            {errorItems.map((e, i) => (
                                <li key={i}>{e.error}</li>
                            ))}
                        </ul>
                    </details>
                )}
            </div>

            <DialogFooter>
                {running ? (
                    <Button type="button" variant="outline" onClick={cancel}>
                        <X className="mr-1 size-4" />
                        {t("cancel")}
                    </Button>
                ) : (
                    <>
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("close")}
                        </Button>
                        <Button type="button" disabled={!canStart} onClick={startExport}>
                            <Usb className="mr-1 size-4" />
                            {t("start")}
                        </Button>
                    </>
                )}
            </DialogFooter>
        </>
    );
}
