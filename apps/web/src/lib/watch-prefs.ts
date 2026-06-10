/**
 * Shared types + defaults for WatchPrefs. Kept out of the `"use server"`
 * actions file because non-async exports are forbidden there.
 */

export interface WatchPrefs {
    /** Region codes (ISO 3166-1 alpha-2). First entry is the "default". */
    regions: string[];
    /** Default region (must be one of `regions`). */
    defaultRegion: string;
    /** Preferred subtitle languages, in order (ISO 639-1: en, ro, ...). */
    subtitleLanguages: string[];
    /** Prefer SDH/CC tracks when available. */
    forceSdh: boolean;
    /** Auto-search OpenSubtitles on play if no embedded match. */
    autoSearchSubtitles: boolean;
    /** Subtitle visual style. */
    subtitleStyle: {
        fontScale: number;          // 0.5 .. 2 (1 = default)
        outline: "none" | "thin" | "thick";
        background: "none" | "soft" | "solid";
        color: string;              // hex
    };
    /** Default sync offset in seconds (positive = subs shown later). */
    subtitleOffsetSec: number;
    /** Hidden TMDB ids (downweighted from recommendations). */
    hiddenMovieTmdbIds: number[];
    hiddenShowTmdbIds: number[];
    /** Filter rows + discover to only items present in the local library. */
    localOnly: boolean;
    /** Hide already-watched items from discover rows. */
    hideWatched: boolean;
    /** Min TMDB rating filter (0..10). */
    minRating: number;
    /** Include adult content in discover/search. */
    includeAdult: boolean;
    /** Autoplay trailer (muted) in hover preview popover. */
    autoplayTrailer: boolean;
    /** Auto-advance to next episode at credits. */
    autoplayNext: boolean;
    /** Poster card size (sm/md/lg). */
    posterSize: "sm" | "md" | "lg";
    /** Reduce motion (disable parallax, hover popover, autoplay trailers). */
    reduceMotion: boolean;
}

export const DEFAULT_PREFS: WatchPrefs = {
    regions: ["RO", "US"],
    defaultRegion: "RO",
    subtitleLanguages: ["en-SDH", "en", "ro"],
    forceSdh: true,
    autoSearchSubtitles: true,
    subtitleStyle: { fontScale: 1, outline: "thin", background: "soft", color: "#ffffff" },
    subtitleOffsetSec: 0,
    hiddenMovieTmdbIds: [],
    hiddenShowTmdbIds: [],
    localOnly: false,
    hideWatched: false,
    minRating: 0,
    includeAdult: false,
    autoplayTrailer: true,
    autoplayNext: true,
    posterSize: "md",
    reduceMotion: false,
};

export function mergeWatchPrefs(raw: unknown): WatchPrefs {
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    const p = raw as Partial<WatchPrefs>;
    return {
        regions: Array.isArray(p.regions) && p.regions.length > 0 ? p.regions : DEFAULT_PREFS.regions,
        defaultRegion: typeof p.defaultRegion === "string" ? p.defaultRegion : DEFAULT_PREFS.defaultRegion,
        subtitleLanguages: Array.isArray(p.subtitleLanguages) ? p.subtitleLanguages : DEFAULT_PREFS.subtitleLanguages,
        forceSdh: typeof p.forceSdh === "boolean" ? p.forceSdh : DEFAULT_PREFS.forceSdh,
        autoSearchSubtitles: typeof p.autoSearchSubtitles === "boolean" ? p.autoSearchSubtitles : DEFAULT_PREFS.autoSearchSubtitles,
        subtitleStyle: { ...DEFAULT_PREFS.subtitleStyle, ...(p.subtitleStyle ?? {}) },
        subtitleOffsetSec: typeof p.subtitleOffsetSec === "number" ? p.subtitleOffsetSec : 0,
        hiddenMovieTmdbIds: Array.isArray(p.hiddenMovieTmdbIds) ? p.hiddenMovieTmdbIds : [],
        hiddenShowTmdbIds: Array.isArray(p.hiddenShowTmdbIds) ? p.hiddenShowTmdbIds : [],
        localOnly: typeof p.localOnly === "boolean" ? p.localOnly : DEFAULT_PREFS.localOnly,
        hideWatched: typeof p.hideWatched === "boolean" ? p.hideWatched : DEFAULT_PREFS.hideWatched,
        minRating: typeof p.minRating === "number" ? Math.max(0, Math.min(10, p.minRating)) : DEFAULT_PREFS.minRating,
        includeAdult: typeof p.includeAdult === "boolean" ? p.includeAdult : DEFAULT_PREFS.includeAdult,
        autoplayTrailer: typeof p.autoplayTrailer === "boolean" ? p.autoplayTrailer : DEFAULT_PREFS.autoplayTrailer,
        autoplayNext: typeof p.autoplayNext === "boolean" ? p.autoplayNext : DEFAULT_PREFS.autoplayNext,
        posterSize: p.posterSize === "sm" || p.posterSize === "lg" ? p.posterSize : DEFAULT_PREFS.posterSize,
        reduceMotion: typeof p.reduceMotion === "boolean" ? p.reduceMotion : DEFAULT_PREFS.reduceMotion,
    };
}
