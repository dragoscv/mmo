/**
 * Design-token colours for the canvas widgets (level meters, pitch ribbon). Read at draw time and
 * re-read when the theme attributes change, so a skin or accent switch repaints without a reload.
 */
export interface Palette {
    track: string;
    ok: string;
    warn: string;
    hot: string;
    rms: string;
    text: string;
    border: string;
    card: string;
}

export function readPalette(el: HTMLElement): Palette {
    const cs = getComputedStyle(el);
    const v = (name: string) => cs.getPropertyValue(name).trim();
    return {
        track: v("--muted"),
        ok: v("--success"),
        warn: v("--warning"),
        hot: v("--destructive"),
        rms: v("--primary"),
        text: v("--muted-foreground"),
        border: v("--border"),
        card: v("--card"),
    };
}

/** Re-read the palette when a theme attribute changes (mode, accent, surface). */
export function onPaletteChange(el: HTMLElement, apply: (p: Palette) => void): () => void {
    apply(readPalette(el));
    const mo = new MutationObserver(() => apply(readPalette(el)));
    mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-mode", "data-accent", "data-surface"],
    });
    return () => mo.disconnect();
}
