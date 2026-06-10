"use client";

/**
 * USB audio-copy dialog.
 *
 * Pairs with the round-7 companion endpoint `POST /library/usb/copy`
 * (see `server/src/library/routes.ts`) via the SSE-proxy Route Handler
 * at `/api/usb-copy`. Lets the user pick a scope (active playlist /
 * whole library) + a destination drive path, previews how many tracks
 * will be copied, and streams per-file progress as the companion does
 * the work.
 *
 * Drive auto-detection is intentionally not wired here — the
 * companion's `/library/drives` endpoint can list mounted volumes, but
 * pasting an absolute path is the only way that works for every user
 * (including the ones whose drives don't appear because the volume
 * label is empty or the OS hides them). A future iteration can add a
 * dropdown of detected drives next to the input.
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
}

type Scope = "active" | "all";

interface ProgressItem {
    index: number;
    total: number;
    status: "copied" | "skipped" | "error";
    file?: string;
    error?: string;
    trackId?: number;
}

interface Tally {
    copied: number;
    skipped: number;
    errors: number;
    total: number;
}

function formatBytes(b: number): string {
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export function UsbCopyDialog({
    open,
    onOpenChange,
    activePlaylistId,
    activePlaylistName,
}: Props) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                {open && (
                    <UsbCopyDialogBody
                        activePlaylistId={activePlaylistId}
                        activePlaylistName={activePlaylistName}
                        onClose={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function UsbCopyDialogBody({
    activePlaylistId,
    activePlaylistName,
    onClose,
}: {
    activePlaylistId?: number;
    activePlaylistName?: string;
    onClose: () => void;
}) {
    const t = useTranslations("usbCopy");
    const [scope, setScope] = useState<Scope>(activePlaylistId ? "active" : "all");
    const [destination, setDestination] = useState("");
    const [musicSubdir, setMusicSubdir] = useState("Music");
    const [summary, setSummary] = useState<UsbScopeSummary | null>(null);
    const [resolving, startResolving] = useTransition();
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<ProgressItem[]>([]);
    const [tally, setTally] = useState<Tally | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // Resolve the scope into a track-id list whenever scope/playlist
    // changes (cheap — companion-local query).
    useEffect(() => {
        startResolving(async () => {
            const r = await summariseUsbScope(scope, activePlaylistId);
            setSummary(r);
        });
    }, [scope, activePlaylistId]);

    // Cancel any in-flight copy when the body unmounts (i.e. dialog closes).
    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    const canActive = activePlaylistId !== undefined;
    const canStart =
        !running &&
        destination.trim().length > 0 &&
        summary?.ok === true &&
        summary.trackIds.length > 0;

    async function startCopy() {
        if (!summary?.ok || summary.trackIds.length === 0) {
            toast.error(t("summaryEmpty"));
            return;
        }
        if (destination.trim().length === 0) {
            toast.error(t("destinationRequired"));
            return;
        }
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setRunning(true);
        setProgress([]);
        setTally(null);
        try {
            const res = await fetch("/api/usb-copy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    trackIds: summary.trackIds,
                    destination: destination.trim(),
                    musicSubdir: musicSubdir.trim() || undefined,
                }),
                signal: ctrl.signal,
            });
            if (!res.ok || !res.body) {
                let err = `HTTP ${res.status}`;
                try { err = (await res.json()).error ?? err; } catch { /* ignore */ }
                toast.error(err);
                setRunning(false);
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf("\n\n")) !== -1) {
                    const raw = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    let event = "message";
                    let data = "";
                    for (const line of raw.split("\n")) {
                        if (line.startsWith("event:")) event = line.slice(6).trim();
                        else if (line.startsWith("data:")) data += line.slice(5).trim();
                    }
                    if (!data) continue;
                    let payload: Record<string, unknown>;
                    try { payload = JSON.parse(data); } catch { continue; }
                    if (event === "progress") {
                        const item: ProgressItem = {
                            index: Number(payload.index ?? 0),
                            total: Number(payload.total ?? 0),
                            status: (payload.status as ProgressItem["status"]) ?? "error",
                            file: payload.file as string | undefined,
                            error: payload.error as string | undefined,
                            trackId: payload.trackId as number | undefined,
                        };
                        setProgress((prev) => [...prev, item]);
                    } else if (event === "done") {
                        setTally({
                            copied: Number(payload.copied ?? 0),
                            skipped: Number(payload.skipped ?? 0),
                            errors: Number(payload.errors ?? 0),
                            total: Number(payload.total ?? 0),
                        });
                    } else if (event === "error") {
                        toast.error(String(payload.error ?? "stream error"));
                    }
                }
            }
        } catch (err) {
            if ((err as Error).name !== "AbortError") {
                toast.error(err instanceof Error ? err.message : String(err));
            }
        } finally {
            setRunning(false);
            abortRef.current = null;
        }
    }

    function cancelCopy() {
        abortRef.current?.abort();
    }

    const totalEvents = progress.length;
    const totalExpected = summary?.trackIds.length ?? 0;
    const pct = totalExpected > 0 ? (totalEvents / totalExpected) * 100 : 0;

    const errorItems = progress.filter((p) => p.status === "error");

    return (
        <>
            <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                    <Usb className="h-5 w-5 text-primary" />
                    {t("title")}
                </DialogTitle>
                <DialogDescription>{t("subtitle")}</DialogDescription>
            </DialogHeader>

            {/* Scope picker */}
            <div className="space-y-2">
                <Label>{t("scope")}</Label>
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        disabled={!canActive || running}
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
                        disabled={running}
                        onClick={() => setScope("all")}
                        className={`p-3 rounded-lg border text-left text-sm transition-all ${
                            scope === "all"
                                ? "border-primary bg-primary/10"
                                : "border-[var(--border)] hover:bg-[var(--accent)]"
                        }`}
                    >
                        <div className="font-medium">{t("scopeAll")}</div>
                    </button>
                </div>
            </div>

            {/* Destination + subdir */}
            <div className="space-y-2">
                <Label htmlFor="usb-dest">{t("destination")}</Label>
                <Input
                    id="usb-dest"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    placeholder={t("destinationPlaceholder")}
                    disabled={running}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                    {t("destinationHint")}
                </p>
            </div>
            <div className="space-y-1">
                <Label htmlFor="usb-subdir">{t("musicSubdir")}</Label>
                <Input
                    id="usb-subdir"
                    value={musicSubdir}
                    onChange={(e) => setMusicSubdir(e.target.value)}
                    placeholder="Music"
                    disabled={running}
                />
                <p className="text-xs text-[var(--muted-foreground)]">
                    {t("musicSubdirHint")}
                </p>
            </div>

            {/* Summary */}
            <div className="rounded-md border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-sm">
                {resolving && !summary ? (
                    <span className="flex items-center gap-2 text-[var(--muted-foreground)]">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> …
                    </span>
                ) : !summary?.ok ? (
                    <span className="text-amber-500">
                        {summary?.error === "no companion"
                            ? t("noCompanion")
                            : (summary?.error ?? t("summaryEmpty"))}
                    </span>
                ) : summary.trackIds.length === 0 ? (
                    <span className="text-[var(--muted-foreground)]">
                        {t("summaryEmpty")}
                    </span>
                ) : summary.unknownSizeCount > 0 && summary.totalBytes === 0 ? (
                    t("summaryUnknown", {
                        count: summary.trackIds.length,
                        unknown: summary.unknownSizeCount,
                    })
                ) : (
                    t("summary", {
                        count: summary.trackIds.length,
                        size: formatBytes(summary.totalBytes),
                    })
                )}
            </div>

            {/* Progress (only while running or after done) */}
            {(running || tally) && (
                <div className="space-y-2">
                    <Progress value={pct} />
                    <div className="text-xs text-[var(--muted-foreground)]">
                        {totalEvents} / {totalExpected}
                    </div>
                    {tally && (
                        <div className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
                            <div className="font-medium">{t("doneTitle")}</div>
                            <div className="text-[var(--muted-foreground)]">
                                {t("doneSummary", tally as unknown as Record<string, number>)}
                            </div>
                        </div>
                    )}
                    {errorItems.length > 0 && (
                        <details className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                            <summary className="cursor-pointer font-medium text-amber-500">
                                {t("errorsTitle")} ({errorItems.length})
                            </summary>
                            <ul className="mt-2 space-y-1 text-xs text-[var(--muted-foreground)]">
                                {errorItems.slice(0, 50).map((p) => (
                                    <li key={`err-${p.index}-${p.trackId ?? 0}`} className="flex items-start gap-2">
                                        <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-500 shrink-0" />
                                        <span className="truncate">
                                            #{p.trackId ?? "?"} — {p.error ?? "unknown error"}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}

            <DialogFooter>
                {running ? (
                    <Button variant="outline" onClick={cancelCopy}>
                        <X className="h-4 w-4 mr-2" />
                        {t("cancel")}
                    </Button>
                ) : (
                    <Button variant="outline" onClick={onClose}>
                        {tally ? t("close") : t("cancel")}
                    </Button>
                )}
                {!tally && (
                    <Button onClick={startCopy} disabled={!canStart}>
                        {running ? (
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        ) : (
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                        )}
                        {running ? t("copying") : t("start")}
                    </Button>
                )}
            </DialogFooter>
        </>
    );
}
