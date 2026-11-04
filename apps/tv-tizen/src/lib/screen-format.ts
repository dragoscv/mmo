/**
 * Ultrawide compensation for Samsung Odyssey / ViewFinity monitors running Tizen.
 *
 * The web engine always renders a 16:9 surface (1920×1080, measured on the Odyssey OLED G8
 * LS34DG850SUXDU), and the 3440×1440 panel stretches it to 21:9: circles become ovals. We lay
 * the UI out on a wider canvas and squeeze it horizontally by 1/k (k = panel/16:9); the panel
 * stretch then restores the proportions and the whole screen is used. Video uses
 * `object-fit: fill` inside a box sized for the film's aspect on the real panel.
 */
import { useEffect, useState } from "react";

export type ScreenFormatKey = "auto" | "16:9" | "21:9" | "32:9";
const KEY = "mixai-tv:screen-format";
const EVENT = "mixai:screen-format";
const SIGNAL = 16 / 9;
const PANELS: Record<Exclude<ScreenFormatKey, "auto">, number> = { "16:9": 16 / 9, "21:9": 3440 / 1440, "32:9": 32 / 9 };

/** Samsung monitor model → panel aspect. `LS34…`/`LC34…` = 34" ultrawide (21:9),
 *  `LS49…`/`LC49…`/`LS57…` = 49"/57" super-ultrawide (32:9). TVs (`QE…`, `UE…`) stay 16:9. */
export function aspectFromModel(model: string | null | undefined): number | null {
    const m = (model ?? "").toUpperCase();
    if (/^L[SC](49|57)/.test(m)) return PANELS["32:9"];
    if (/^L[SC](34|38|40)/.test(m)) return PANELS["21:9"];
    return null;
}

function modelName(): string | null {
    try {
        const t = (globalThis as { tizen?: { systeminfo?: { getCapability(k: string): unknown } } }).tizen;
        const v = t?.systeminfo?.getCapability("http://tizen.org/system/model_name");
        return typeof v === "string" ? v : null;
    } catch {
        return null;
    }
}

export function getScreenFormat(): ScreenFormatKey {
    try {
        const v = localStorage.getItem(KEY);
        if (v === "16:9" || v === "21:9" || v === "32:9") return v;
    } catch { /* ignore */ }
    return "auto";
}

export function setScreenFormat(v: ScreenFormatKey): void {
    try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
    applySqueeze();
    window.dispatchEvent(new Event(EVENT));
}

/** Horizontal squeeze factor for the current setting (1 = none). */
export function squeezeFactor(format = getScreenFormat(), model = modelName()): number {
    const panel = format === "auto" ? aspectFromModel(model) ?? SIGNAL : PANELS[format];
    const k = panel / SIGNAL;
    return Math.abs(k - 1) < 0.02 ? 1 : k;
}

/** Writes `--squeeze` on <html>; CSS lays the root out k× wider and scales it back. */
export function applySqueeze(): number {
    const k = squeezeFactor();
    const root = document.documentElement;
    root.style.setProperty("--squeeze", String(k));
    if (k === 1) root.removeAttribute("data-squeeze"); else root.setAttribute("data-squeeze", "");
    return k;
}

export function useScreenFormat(): [ScreenFormatKey, (v: ScreenFormatKey) => void, number] {
    const [fmt, setFmt] = useState<ScreenFormatKey>(getScreenFormat);
    useEffect(() => {
        const on = () => setFmt(getScreenFormat());
        window.addEventListener(EVENT, on);
        return () => window.removeEventListener(EVENT, on);
    }, []);
    return [fmt, setScreenFormat, squeezeFactor(fmt)];
}

/** Box (fractions of the 16:9 viewport, in UNSQUEEZED layout units) for a film of
 *  `videoAspect` so it appears undistorted and maximal on a panel squeezed by `k`. */
export function videoBox(videoAspect: number, k: number): { w: number; h: number } {
    if (!(videoAspect > 0)) return { w: 1, h: 1 };
    const panel = SIGNAL * k;
    return videoAspect >= panel ? { w: 1, h: panel / videoAspect } : { w: videoAspect / panel, h: 1 };
}
