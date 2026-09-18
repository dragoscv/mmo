"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tv, Loader2 } from "lucide-react";
import { approvePairingOnDevice, listPendingPairings, type PendingPairing } from "@/actions/pair";

const POLL_MS = 5_000;

/** Small panel for the Devices page: lists pending TV / mobile pairing
 *  requests across the user's online companions and approves them.
 *  Polls every 5 s while the tab is visible. */
export function PendingPairingsPanel() {
    const t = useTranslations("pair");
    const [rows, setRows] = useState<PendingPairing[]>([]);
    const [busy, setBusy] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    const refresh = useCallback(async () => {
        try { setRows(await listPendingPairings()); } catch { /* transient; keep last */ }
    }, []);

    useEffect(() => {
        let handle: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (handle) return;
            void refresh();
            handle = setInterval(() => { void refresh(); }, POLL_MS);
        };
        const stop = () => { if (handle) { clearInterval(handle); handle = null; } };
        const onVis = () => { if (document.visibilityState === "visible") start(); else stop(); };
        onVis();
        document.addEventListener("visibilitychange", onVis);
        return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
    }, [refresh]);

    function approve(row: PendingPairing) {
        const key = `${row.deviceId}:${row.code}`;
        setBusy(key);
        startTransition(async () => {
            const r = await approvePairingOnDevice({ deviceId: row.deviceId, code: row.code });
            if (r.ok) {
                toast.success(t("approved", { requester: row.requester, server: row.deviceName }));
                setRows((p) => p.filter((x) => !(x.deviceId === row.deviceId && x.code === row.code)));
            } else {
                toast.error(t(`errors.${r.error}`));
            }
            setBusy(null);
        });
    }

    if (rows.length === 0) return null;

    return (
        <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                    <Tv className="h-4 w-4" aria-hidden />
                    {t("panelTitle")}
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
                {rows.map((row) => {
                    const key = `${row.deviceId}:${row.code}`;
                    const exp = new Date(row.expiresAt);
                    return (
                        <div key={key} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background/60 p-3">
                            <div className="min-w-0 text-sm">
                                <p className="truncate font-medium">
                                    {t("panelRow", { requester: row.requester, platform: row.platform, server: row.deviceName })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    <span className="font-mono text-base tracking-widest">{row.code}</span>
                                    {" · "}
                                    {t("expiresAt", { time: Number.isNaN(exp.getTime()) ? row.expiresAt : exp.toLocaleTimeString() })}
                                </p>
                            </div>
                            <Button size="lg" className="h-11 min-w-28" onClick={() => approve(row)} disabled={busy === key}>
                                {busy === key ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                                {t("approve")}
                            </Button>
                        </div>
                    );
                })}
            </CardContent>
        </Card>
    );
}
