/**
 * Colours for <canvas> drawing. A canvas cannot read a CSS variable, so each colour is
 * resolved through an element's computed `color` (which also resolves `var()`, `oklch()` and
 * `color-mix()`), cached, and dropped whenever the look changes (skin, mode, accent, palette).
 *
 * Always pass a token expression (`var(--…)`): no colour literal belongs in canvas code.
 */
import { subscribeLook } from "./look.ts";

export interface ColorResolver {
    /** Resolved colour string usable as `fillStyle` / `strokeStyle`. */
    (css: string): string;
    /** Stop listening for look changes. */
    dispose(): void;
}

export function makeColorResolver(el: HTMLElement): ColorResolver {
    const cache = new Map<string, string>();
    const resolve = ((css: string): string => {
        const hit = cache.get(css);
        if (hit !== undefined) return hit;
        const before = el.style.color;
        el.style.color = css;
        const value = getComputedStyle(el).color || css;
        el.style.color = before;
        cache.set(css, value);
        return value;
    }) as ColorResolver;
    const off = subscribeLook(() => cache.clear());
    resolve.dispose = off;
    return resolve;
}
