"use client";

/**
 * PWA install prompt — captures the browser's `beforeinstallprompt`
 * event so we can surface a single, well-placed "Install MMO" button
 * instead of letting Chrome decide when to show its own banner. The
 * captured event is the only way to programmatically trigger the
 * install dialog; if we miss it (page already loaded once and user
 * dismissed), the button silently hides.
 *
 * No-op on:
 *   - iOS Safari (Safari doesn't fire `beforeinstallprompt`; users
 *     install via Share → Add to Home Screen, which we can't trigger).
 *   - Already-installed PWA (display-mode: standalone or minimal-ui).
 *   - SSR (the whole component is `"use client"` + mount-gated).
 */

import { useEffect, useState, useCallback } from "react";
import { Download } from "lucide-react";

// `beforeinstallprompt` isn't in lib.dom.d.ts yet (still a Web App
// Manifest WG draft). Narrow type rather than `any`.
interface BeforeInstallPromptEvent extends Event {
    readonly platforms: readonly string[];
    readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
    prompt(): Promise<void>;
}

const DISMISS_KEY = "mmo.pwa.installDismissedAt";
const DISMISS_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export function PwaInstallButton({ className }: { className?: string }) {
    const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
    // Lazy initial computation avoids a setState-in-effect cascade: the
    // standalone check only depends on the initial mount environment.
    // The post-install case is then handled by the `appinstalled` event.
    const [installed, setInstalled] = useState<boolean>(() => {
        if (typeof window === "undefined") return false;
        return (
            window.matchMedia?.("(display-mode: standalone)").matches === true ||
            (window.navigator as Navigator & { standalone?: boolean }).standalone === true
        );
    });

    useEffect(() => {
        if (typeof window === "undefined" || installed) return;

        // Respect a recent dismissal so we don't nag.
        const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || "0");
        if (dismissedAt && Date.now() - dismissedAt < DISMISS_TTL_MS) return;

        const onPrompt = (e: Event) => {
            e.preventDefault();
            setEvt(e as BeforeInstallPromptEvent);
        };
        const onInstalled = () => {
            setInstalled(true);
            setEvt(null);
        };

        window.addEventListener("beforeinstallprompt", onPrompt);
        window.addEventListener("appinstalled", onInstalled);
        return () => {
            window.removeEventListener("beforeinstallprompt", onPrompt);
            window.removeEventListener("appinstalled", onInstalled);
        };
    }, [installed]);

    const onClick = useCallback(async () => {
        if (!evt) return;
        await evt.prompt();
        const choice = await evt.userChoice;
        if (choice.outcome === "dismissed") {
            try {
                localStorage.setItem(DISMISS_KEY, String(Date.now()));
            } catch {
                // Storage may be full / disabled — fine.
            }
        }
        setEvt(null);
    }, [evt]);

    if (installed || !evt) return null;

    return (
        <button
            type="button"
            onClick={onClick}
            className={className ??
                "inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-white/10 transition-colors"
            }
            aria-label="Install MuzicAI as an app"
        >
            <Download className="h-3.5 w-3.5" aria-hidden />
            Install app
        </button>
    );
}
