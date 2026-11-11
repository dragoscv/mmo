/**
 * Frame-budget governor + tiny HUD in the title bar. Samples requestAnimationFrame
 * deltas, feeds the pure governor, writes `data-motion-governor` on <html> and
 * shows fps (only when the user enabled the HUD in Settings → Appearance, or the
 * governor is currently reducing animations).
 *
 * Idle is free:
 * - the frame loop runs only while someone needs it: the HUD is on, or the governor is on
 *   AND a deck is playing (nothing animates with every deck stopped, so there is no frame
 *   budget to protect); it also stops while the window is hidden;
 * - no React state per frame: the fps text is written straight into its text node, at most
 *   twice a second and only when the number changed. React renders only when the governor
 *   switches between normal and reduced.
 */
import { useEffect, useRef, useState } from "react";
import { Gauge, TriangleAlert } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@mmo/ui";
import { useMixerStore } from "@/state/mixer-store";
import { fpsOf, initialGovernor, stepGovernor } from "./governor";
import { useShellPrefs } from "./shell-prefs";
import { useT } from "@/i18n";

/** The window is visible (a hidden window gets no frames: nothing to measure). */
function useVisible(): boolean {
    const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
    useEffect(() => {
        const on = () => setVisible(!document.hidden);
        document.addEventListener("visibilitychange", on);
        return () => document.removeEventListener("visibilitychange", on);
    }, []);
    return visible;
}

export function PerfHud() {
    const t = useT();
    const showHud = useShellPrefs((s) => s.hud);
    const governor = useShellPrefs((s) => s.governor);
    // A boolean: the 30 Hz engine snapshots re-render this only when playback starts or stops.
    const playing = useMixerStore((s) => s.decks.some((d) => d.playing));
    const visible = useVisible();
    const [reduced, setReduced] = useState(false);
    const fpsRef = useRef<HTMLSpanElement>(null);
    const tRef = useRef(t);
    tRef.current = t;

    const needed = visible && (showHud || (governor && playing));

    useEffect(() => {
        if (!needed) return;
        let s = initialGovernor;
        let last = performance.now();
        let raf = 0;
        let lastText = 0;
        let shownFps = -1;
        let shownReduced = false;
        const root = document.documentElement;
        const loop = (now: number) => {
            s = stepGovernor(s, now - last);
            last = now;
            const nowReduced = governor && s.reduced;
            if (nowReduced !== shownReduced) {
                shownReduced = nowReduced;
                if (nowReduced) root.dataset.motionGovernor = "reduced";
                else delete root.dataset.motionGovernor;
                setReduced(nowReduced);
            }
            // The HUD text: at most twice a second, written without React.
            if (now - lastText > 500) {
                lastText = now;
                const fps = fpsOf(s.avgMs);
                const el = fpsRef.current;
                if (el && fps !== shownFps) {
                    shownFps = fps;
                    el.textContent = tRef.current("shell.hudFps", { fps });
                }
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => {
            cancelAnimationFrame(raf);
            // Nothing is measured from here on: do not leave the app in reduced motion.
            delete root.dataset.motionGovernor;
            setReduced(false);
        };
    }, [needed, governor]);

    if (!showHud && !reduced) return null;
    const Icon = reduced ? TriangleAlert : Gauge;
    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <span className="tb-hud dk-num dk-num-sm" data-reduced={reduced} aria-label={reduced ? t("shell.hudReduced") : t("shell.hud")}>
                        <Icon aria-hidden />
                        <span ref={fpsRef}>{t("shell.hudFps", { fps: "–" })}</span>
                    </span>
                }
            />
            <TooltipContent>{reduced ? t("shell.hudReduced") : t("shell.hud")}</TooltipContent>
        </Tooltip>
    );
}
