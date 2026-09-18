import { useEffect, useRef, useState } from "react";
import { Button, Progress, Tooltip, TooltipContent, TooltipTrigger, cn } from "@mmo/ui";
import { Download, RefreshCw } from "lucide-react";
import { useT } from "../i18n";
import { errorMessage, mmo, type CompanionStatus, type UpdateStatusEvent } from "../lib/ipc";

type Banner = { text: string; tone: "muted" | "accent" | "success" | "error"; percent?: number };

/**
 * Version line + manual "check for updates" + one-click install. Ported from the
 * legacy `onUpdateStatus` / `btn-check-update` / `install-update-btn` handlers:
 *   checking → spinner; current → green for 4 s then back to the version line;
 *   available/downloading → accent text (+ progress); ready → install button;
 *   error → red for 5 s, last error in the tooltip.
 */
export function UpdaterBar({ status }: { status: CompanionStatus }) {
    const t = useT();
    const [banner, setBanner] = useState<Banner | null>(null);
    const [checking, setChecking] = useState(false);
    const [ready, setReady] = useState(false);
    const [installing, setInstalling] = useState(false);
    const [lastError, setLastError] = useState<string | null>(null);
    const resetTimer = useRef<number | null>(null);

    const scheduleReset = (ms: number) => {
        if (resetTimer.current) window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setBanner(null), ms);
    };

    useEffect(() => {
        if (!mmo) return;
        // NOTE: preload's onUpdateStatus has no unsubscribe; subscribe once per mount.
        // The component is mounted for the app lifetime (MainView), so this is fine.
        let disposed = false;
        mmo.onUpdateStatus((data: UpdateStatusEvent) => {
            if (disposed) return;
            switch (data.status) {
                case "checking":
                    setChecking(true);
                    setBanner({ text: t("version.checking"), tone: "accent" });
                    break;
                case "current":
                    setChecking(false);
                    setBanner({ text: t("version.current", { version: data.version }), tone: "success" });
                    scheduleReset(4000);
                    break;
                case "available":
                    setChecking(false);
                    setReady(false);
                    setBanner({ text: t("version.available", { version: data.version }), tone: "accent", percent: 0 });
                    break;
                case "downloading":
                    setReady(false);
                    setBanner({ text: t("version.downloading", { percent: Math.round(data.percent) }), tone: "accent", percent: data.percent });
                    break;
                case "ready":
                    setReady(true);
                    setBanner({ text: t("version.ready", { version: data.version }), tone: "success" });
                    break;
                case "error":
                    setChecking(false);
                    setLastError(data.error ?? "unknown");
                    setBanner({ text: t("version.error"), tone: "error" });
                    scheduleReset(5000);
                    break;
            }
        });
        return () => {
            disposed = true;
            if (resetTimer.current) window.clearTimeout(resetTimer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function check() {
        if (checking || !mmo) return;
        setChecking(true);
        setBanner({ text: t("version.checking"), tone: "accent" });
        try {
            const result = await mmo.checkForUpdates();
            // The event stream drives the text; only surface swallowed errors.
            if (result && result.ok === false) {
                setLastError(result.error ?? "unknown");
                setBanner({ text: t("version.error"), tone: "error" });
                scheduleReset(5000);
            }
        } catch (err) {
            setLastError(errorMessage(err));
            setBanner({ text: t("version.error"), tone: "error" });
            scheduleReset(5000);
        } finally {
            setChecking(false);
        }
    }

    async function install() {
        if (!mmo) return;
        setInstalling(true);
        try {
            await mmo.installUpdateNow();
        } catch (err) {
            console.warn("installUpdateNow failed:", err);
            setInstalling(false);
        }
    }

    const appV = status.appVersion || "?";
    const srvV = status.serverVersion || appV;
    const toneClass =
        banner?.tone === "success" ? "text-success" : banner?.tone === "error" ? "text-destructive" : banner?.tone === "accent" ? "text-primary" : "text-muted-foreground";

    return (
        <footer className="shrink-0 border-t px-4 py-2">
            <div className="flex items-center justify-center gap-2 text-[11px]">
                <span className={cn("tabular-nums", toneClass)}>{banner ? banner.text : t("version.app", { app: appV, server: srvV })}</span>
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button variant="ghost" size="icon-xs" onClick={check} disabled={checking} aria-label={t("version.check")}>
                                <RefreshCw className={cn("size-3.5", checking && "animate-spin")} aria-hidden />
                            </Button>
                        }
                    />
                    <TooltipContent>
                        {t("version.check")}
                        {lastError ? ` — ${t("version.errorDetail", { error: lastError })}` : ""}
                    </TooltipContent>
                </Tooltip>
            </div>
            {banner?.percent !== undefined && !ready && (
                <Progress value={banner.percent} className="mx-auto mt-1.5 h-1 max-w-xs" aria-label={banner.text} />
            )}
            {ready && (
                <div className="mt-2 flex justify-center">
                    <Button variant="default" size="sm" onClick={install} loading={installing}>
                        {!installing && <Download className="size-4" aria-hidden />}
                        {installing ? t("version.installing") : t("version.install")}
                    </Button>
                </div>
            )}
        </footer>
    );
}
