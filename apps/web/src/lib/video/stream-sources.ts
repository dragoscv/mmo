/**
 * External embed providers for movies and TV episodes.
 *
 * These are third-party iframe embed services that serve copies of movies
 * and shows by TMDB / IMDB id. They are ad-supported, occasionally break,
 * and must be opted-in by the user via the companion `vidsrc` flag.
 *
 * The companion-side toggle remains the master switch; this module only
 * decides WHICH providers we try once embedding is enabled.
 */

export type StreamSourceKind = "movie" | "tv";

export interface StreamSource {
    /** Stable identifier — used as the cookie value for "last used provider". */
    id: string;
    /** Display label in the picker. */
    label: string;
    /** Short hint shown next to the label. */
    hint?: string;
    /** Whether this provider has a relatively clean player (low/no pop-ups). */
    clean?: boolean;
    /** Build the embed URL for a movie (by TMDB id). */
    movie(tmdbId: number, imdbId?: string | null): string;
    /** Build the embed URL for a TV episode (by TMDB id + S/E). */
    tv(tmdbId: number, season: number, episode: number, imdbId?: string | null): string;
}

/**
 * Provider list. Order matters — the first available provider is the
 * default. Most providers accept either TMDB or IMDB ids; we prefer TMDB
 * because we always have it after the TMDB sync.
 */
export const STREAM_SOURCES: StreamSource[] = [
    {
        id: "vidsrc-me",
        label: "VidSrc.me",
        hint: "primary",
        movie: (id) => `https://vidsrc.me/embed/movie?tmdb=${id}`,
        tv: (id, s, e) => `https://vidsrc.me/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
    },
    {
        id: "vidsrc-to",
        label: "VidSrc.to",
        hint: "alt mirror",
        movie: (id) => `https://vidsrc.to/embed/movie/${id}`,
        tv: (id, s, e) => `https://vidsrc.to/embed/tv/${id}/${s}/${e}`,
    },
    {
        id: "vidsrc-xyz",
        label: "VidSrc.xyz",
        hint: "alt mirror",
        movie: (id) => `https://vidsrc.xyz/embed/movie?tmdb=${id}`,
        tv: (id, s, e) => `https://vidsrc.xyz/embed/tv?tmdb=${id}&season=${s}&episode=${e}`,
    },
    {
        id: "vidlink-pro",
        label: "VidLink.pro",
        hint: "cleanest player",
        clean: true,
        movie: (id) => `https://vidlink.pro/movie/${id}`,
        tv: (id, s, e) => `https://vidlink.pro/tv/${id}/${s}/${e}`,
    },
    {
        id: "2embed",
        label: "2Embed",
        movie: (id) => `https://www.2embed.cc/embed/${id}`,
        tv: (id, s, e) => `https://www.2embed.cc/embedtv/${id}&s=${s}&e=${e}`,
    },
    {
        id: "embedsu",
        label: "Embed.su",
        movie: (id) => `https://embed.su/embed/movie/${id}`,
        tv: (id, s, e) => `https://embed.su/embed/tv/${id}/${s}/${e}`,
    },
    {
        id: "autoembed",
        label: "AutoEmbed",
        movie: (id) => `https://player.autoembed.cc/embed/movie/${id}`,
        tv: (id, s, e) => `https://player.autoembed.cc/embed/tv/${id}/${s}/${e}`,
    },
    {
        id: "multiembed",
        label: "MultiEmbed",
        movie: (id) => `https://multiembed.mov/?video_id=${id}&tmdb=1`,
        tv: (id, s, e) => `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}`,
    },
    {
        id: "smashy",
        label: "Smashy.stream",
        movie: (id) => `https://embed.smashystream.com/playere.php?tmdb=${id}`,
        tv: (id, s, e) => `https://embed.smashystream.com/playere.php?tmdb=${id}&season=${s}&episode=${e}`,
    },
    {
        id: "moviesapi",
        label: "MoviesAPI",
        movie: (id) => `https://moviesapi.club/movie/${id}`,
        tv: (id, s, e) => `https://moviesapi.club/tv/${id}-${s}-${e}`,
    },
];

/** Hostnames used in CSP `frame-src` directive. Update if you add providers. */
export const STREAM_SOURCE_HOSTS = [
    "vidsrc.me",
    "vidsrc.to",
    "vidsrc.xyz",
    "vidsrc.cc",
    "vidsrcme.ru",
    "vidlink.pro",
    "2embed.cc",
    "www.2embed.cc",
    "embed.su",
    "player.autoembed.cc",
    "autoembed.cc",
    "multiembed.mov",
    "embed.smashystream.com",
    "smashystream.com",
    "moviesapi.club",
];

export function getDefaultStreamSource(kind: StreamSourceKind): StreamSource {
    if (kind === "tv") {
        // VidLink.pro renders TV episodes cleanest in our tests; fall back to vidsrc.
        return STREAM_SOURCES.find((s) => s.id === "vidlink-pro") ?? STREAM_SOURCES[0];
    }
    return STREAM_SOURCES[0];
}

export function findStreamSource(id: string | null | undefined): StreamSource | null {
    if (!id) return null;
    return STREAM_SOURCES.find((s) => s.id === id) ?? null;
}
