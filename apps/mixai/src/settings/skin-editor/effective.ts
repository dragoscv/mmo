/**
 * The colour a custom property has RIGHT NOW in the running app, as `#rrggbb`: what a colour
 * field of the skin editor shows while the draft does not set that colour, and what the contrast
 * check compares against.
 *
 * A custom property is not resolved by `getPropertyValue` (it returns the declared text, e.g.
 * `oklch(0.8 0.19 var(--accent-h))`), so the value goes through a hidden element's computed
 * `color` and then through a 1×1 canvas, which turns any CSS colour into sRGB bytes.
 *
 * The probe sits in <body> (outside the editor, which pins its own palette) and is deck-scoped
 * like a deck A waveform, so `--play` and `--wave-low|mid|high` resolve the way they do there.
 */
import { subscribeLook } from "@/look/look";
import { rgbToHex } from "./color";

let probe: HTMLElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, string | null>();
let listening = false;

function ensure(): boolean {
    if (typeof document === "undefined") return false;
    if (!probe || !probe.isConnected) {
        probe = document.createElement("span");
        probe.className = "dk-wave";
        probe.setAttribute("data-deck-scope", "");
        probe.setAttribute("aria-hidden", "true");
        probe.style.setProperty("--deck", "var(--deck-a)");
        probe.style.display = "none";
        document.body.appendChild(probe);
    }
    if (!ctx) {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        ctx = c.getContext("2d", { willReadFrequently: true });
    }
    if (!listening) {
        listening = true;
        subscribeLook(() => cache.clear());
    }
    return !!ctx;
}

/** `#rrggbb` of `var(<prop>)`, or null when the property is not set where the probe sits. */
export function effectiveColor(prop: string): string | null {
    const hit = cache.get(prop);
    if (hit !== undefined) return hit;
    if (!ensure() || !probe || !ctx) return null;
    const cs = getComputedStyle(probe);
    let out: string | null = null;
    if (cs.getPropertyValue(prop).trim()) {
        probe.style.color = `var(${prop})`;
        const resolved = getComputedStyle(probe).color;
        probe.style.color = "";
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = resolved;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        // A fully transparent result means the canvas refused the colour string.
        if (d[3]! > 0) out = rgbToHex([d[0]! / 255, d[1]! / 255, d[2]! / 255]);
    }
    cache.set(prop, out);
    return out;
}

/** Drop cached values (the editor calls it after it re-rendered the preview). */
export function clearEffective(): void {
    cache.clear();
}
