/**
 * Watch theme registry.
 *
 * Each theme is a tuple of:
 *  - identity (id, label, blurb shown in the picker)
 *  - CSS custom-property bag applied at the .watch-shell scope when
 *    that theme is active (via `data-watch-theme="<id>"`).
 *
 * Adding a theme = append an entry here + the corresponding
 * `[data-watch-theme="..."]` block in `cinematic.css`. The picker UI
 * derives itself from this list — no other registration needed.
 */
export const WATCH_THEMES = [
    {
        id: "mmo",
        label: "MMO Cinematic",
        blurb: "Default — deep indigo with rose→orange accent, soft grain.",
        swatch: ["#06070d", "#ff3366", "#ffaa66"],
    },
    {
        id: "netflix",
        label: "Netflix",
        blurb: "Pure black, signature red accent, dense rows, scale-on-hover.",
        swatch: ["#000000", "#141414", "#e50914"],
    },
    {
        id: "plex",
        label: "Plex",
        blurb: "Charcoal panels, amber accent, info-dense server vibe.",
        swatch: ["#1f2227", "#282c34", "#e5a00d"],
    },
    {
        id: "disney",
        label: "Disney+",
        blurb: "Deep navy with cyan rim-light and tile mosaic feel.",
        swatch: ["#040714", "#0e1a3d", "#1f80e0"],
    },
    {
        id: "hbo",
        label: "HBO Max",
        blurb: "Warm dark with violet accent and cinematic typography.",
        swatch: ["#0b0a13", "#1a1428", "#a36ef5"],
    },
] as const;

export type WatchThemeId = typeof WATCH_THEMES[number]["id"];
export const DEFAULT_WATCH_THEME: WatchThemeId = "netflix";

export function isWatchThemeId(v: string | null | undefined): v is WatchThemeId {
    return !!v && WATCH_THEMES.some((t) => t.id === v);
}
