/**
 * Image helpers: TMDB size picker by rendered width, `preload()` through `new Image()` with async decode,
 * and a small LRU of URLs already decoded (so a card can skip its fade-in when the image is warm).
 */

export type TmdbSize = "w185" | "w342" | "w500" | "w780";

/** Device pixel ratio the TV actually renders at (Tizen reports 1; desktop dev may be 2). */
function dpr(): number {
    try { return Math.max(1, Math.min(2, window.devicePixelRatio || 1)); } catch { return 1; }
}

/** Smallest TMDB width ≥ the rendered width in device px. */
export function tmdbSize(renderedWidthPx: number): TmdbSize {
    const w = renderedWidthPx * dpr();
    if (w <= 185) return "w185";
    if (w <= 342) return "w342";
    if (w <= 500) return "w500";
    return "w780";
}

/** px value of `rem` on this page (TV root font-size is 24 px). */
export function remPx(rem: number): number {
    try {
        const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        return rem * fs;
    } catch {
        return rem * 16;
    }
}

const LRU_MAX = 300;
const loaded = new Map<string, true>();

function touch(url: string): void {
    loaded.delete(url);
    loaded.set(url, true);
    if (loaded.size > LRU_MAX) {
        const first = loaded.keys().next().value;
        if (first !== undefined) loaded.delete(first);
    }
}

/** True when `url` finished loading earlier in this session. */
export function isLoaded(url: string | null | undefined): boolean {
    return !!url && loaded.has(url);
}

/** Mark as loaded (call from an <img onLoad>). */
export function markLoaded(url: string | null | undefined): void {
    if (url) touch(url);
}

/** Forget every "already loaded" URL (Settings › Cache). */
export function clearLoaded(): void {
    loaded.clear();
}

const inflight = new Map<string, Promise<void>>();

/** Preload + decode off the main thread where supported. Resolves (never rejects) when done or failed. */
export function preloadOne(url: string): Promise<void> {
    if (loaded.has(url)) return Promise.resolve();
    const cur = inflight.get(url);
    if (cur) return cur;
    const p = new Promise<void>((resolve) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => { touch(url); inflight.delete(url); resolve(); };
        img.onerror = () => { inflight.delete(url); resolve(); };
        img.src = url;
    });
    inflight.set(url, p);
    return p;
}

/** Preload many (max 4 in parallel so the TV's network/decoder is not flooded). */
export async function preload(urls: Array<string | null | undefined>): Promise<void> {
    const list = urls.filter((u): u is string => !!u && !loaded.has(u));
    let i = 0;
    const worker = async () => {
        while (i < list.length) {
            const u = list[i++]!;
            await preloadOne(u);
        }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
}
