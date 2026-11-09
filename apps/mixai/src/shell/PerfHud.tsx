/**
 * Frame-budget governor + tiny HUD in the title bar. Samples requestAnimationFrame
 * deltas, feeds the pure governor, writes `data-motion-governor` on <html> and
 * shows fps (only when the user enabled the HUD in Settings → Appearance, or the
 * governor is currently reducing animations).
 */
import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { fpsOf, initialGovernor, stepGovernor } from "./governor";
import { useShellPrefs } from "./shell-prefs";
import { useT } from "@/i18n";

export function PerfHud() {
    const t = useT();
    const showHud = useShellPrefs((s) => s.hud);
    const governor = useShellPrefs((s) => s.governor);
    const [view, setView] = useState({ fps: 60, reduced: false });

    useEffect(() => {
        // Nothing to measure when the HUD is hidden and the governor is off.
        if (!governor && !showHud) return;
        let s = initialGovernor;
        let last = performance.now();
        let raf = 0;
        let lastPaint = 0;
        const root = document.documentElement;
        const loop = (now: number) => {
            s = stepGovernor(s, now - last);
            last = now;
            const reduced = governor && s.reduced;
            if ((root.dataset.motionGovernor === "reduced") !== reduced) {
                if (reduced) root.dataset.motionGovernor = "reduced";
                else delete root.dataset.motionGovernor;
            }
            // Update the HUD text at most twice a second.
            if (now - lastPaint > 500) {
                lastPaint = now;
                setView((v) => (v.fps === fpsOf(s.avgMs) && v.reduced === reduced ? v : { fps: fpsOf(s.avgMs), reduced }));
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => {
            cancelAnimationFrame(raf);
            delete root.dataset.motionGovernor;
        };
    }, [governor, showHud]);

    if (!showHud && !view.reduced) return null;
    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <span
                        className={"mono inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] " + (view.reduced ? "bg-warning/20 text-warning" : "text-muted-foreground")}
                        aria-label={t("shell.hud")}
                    >
                        <Gauge className="size-3" aria-hidden />
                        {t("shell.hudFps", { fps: view.fps })}
                    </span>
                }
            />
            <TooltipContent>{view.reduced ? t("shell.hudReduced") : t("shell.hud")}</TooltipContent>
        </Tooltip>
    );
}
