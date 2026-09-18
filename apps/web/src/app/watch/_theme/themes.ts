/**
 * Watch theme registry.
 *
 * Each theme is a tuple of:
 *  - identity (id, label, blurb shown in the picker)
 *  - a swatch (rendered in the picker) — CSS colour strings; use tokens so
 *    the tiles follow light/dark and the user's accent.
 *  - the skin's signature hue, mirrored in `cinematic.css` as `--watch-h`
 *    (`[data-watch-theme="<id>"].watch-shell`). Every other `--watch-*`
 *    variable derives from the shared design tokens (WP2-15), so a skin
 *    only decides hue + shape (radius, hover scale, row gap).
 *
 * Adding a theme = append an entry here + the corresponding
 * `[data-watch-theme="..."]` block in `cinematic.css`, and the id in
 * `public/watch-theme-prehydrate.js`. The picker UI derives itself from
 * this list - no other registration needed.
 */
const accent = (h: number | string) => `oklch(var(--primary-l) var(--primary-c) ${h})`;

export const WATCH_THEMES = [
    {
        id: "mmo",
        label: "MMO Cinematic",
        blurb: "Follows your app accent and theme, soft grain.",
        hue: "var(--accent-h)",
        swatch: ["var(--background)", accent("var(--accent-h)"), accent("calc(var(--accent-h) + 45)")],
    },
    {
        id: "netflix",
        label: "Netflix",
        blurb: "Pure black, signature red accent, dense rows, scale-on-hover.",
        hue: 25,
        swatch: ["oklch(from var(--background) calc(l * 0.7) 0 0)", "var(--card)", accent(25)],
    },
    {
        id: "plex",
        label: "Plex",
        blurb: "Charcoal panels, amber accent, info-dense server vibe.",
        hue: 75,
        swatch: ["oklch(from var(--background) l 0.01 250)", "oklch(from var(--card) l 0.01 250)", accent(75)],
    },
    {
        id: "disney",
        label: "Disney+",
        blurb: "Deep navy with cyan rim-light and tile mosaic feel.",
        hue: 250,
        swatch: ["oklch(from var(--background) l 0.05 250)", "oklch(from var(--card) l 0.05 250)", accent(250)],
    },
    {
        id: "hbo",
        label: "HBO Max",
        blurb: "Warm dark with violet accent and cinematic typography.",
        hue: 285,
        swatch: ["oklch(from var(--background) l 0.03 285)", "oklch(from var(--card) l 0.03 285)", accent(285)],
    },
] as const;

export type WatchThemeId = typeof WATCH_THEMES[number]["id"];
export const DEFAULT_WATCH_THEME: WatchThemeId = "netflix";

export function isWatchThemeId(v: string | null | undefined): v is WatchThemeId {
    return !!v && WATCH_THEMES.some((t) => t.id === v);
}
