/**
 * External streaming-source scrapers.
 *
 * Resolves TMDB id + (kind, season?, episode?) into a list of embed
 * iframe URLs across known providers. The companion is the only place
 * we run cheerio against these — it lives on the user's machine so
 * we keep their IP off our infra.
 *
 * Disabled by default — gated by `video.externalEmbed.vidsrc.enabled`
 * via {@link isVidsrcEnabled}. Per provider TOS, the user must opt in.
 */

import { isVidsrcEnabled } from "./vidsrc-flag";

export type ScrapeKind = "movie" | "tv";

export interface EmbedOption {
    provider: string;
    iframeUrl: string;
    language?: string;
    quality?: string;
    notes?: string;
}

interface ResolveInput {
    tmdbId: number;
    imdbId?: string;
    kind: ScrapeKind;
    season?: number;
    episode?: number;
}

function vidsrcTo({ tmdbId, kind, season, episode }: ResolveInput): EmbedOption[] {
    const base = "https://vidsrc.to/embed";
    if (kind === "movie") return [{ provider: "vidsrc.to", iframeUrl: `${base}/movie/${tmdbId}` }];
    if (season != null && episode != null)
        return [{ provider: "vidsrc.to", iframeUrl: `${base}/tv/${tmdbId}/${season}/${episode}` }];
    return [];
}

function vidsrcMe({ tmdbId, imdbId, kind, season, episode }: ResolveInput): EmbedOption[] {
    const id = imdbId ?? `tmdb:${tmdbId}`;
    if (kind === "movie") return [{ provider: "vidsrc.me", iframeUrl: `https://vidsrc.xyz/embed/movie/${id}` }];
    if (season != null && episode != null)
        return [{ provider: "vidsrc.me", iframeUrl: `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}` }];
    return [];
}

function twoEmbed({ tmdbId, kind, season, episode }: ResolveInput): EmbedOption[] {
    if (kind === "movie") return [{ provider: "2embed.cc", iframeUrl: `https://www.2embed.cc/embed/${tmdbId}` }];
    if (season != null && episode != null)
        return [{ provider: "2embed.cc", iframeUrl: `https://www.2embed.cc/embedtv/${tmdbId}&s=${season}&e=${episode}` }];
    return [];
}

function multiEmbed({ tmdbId, imdbId, kind, season, episode }: ResolveInput): EmbedOption[] {
    const id = imdbId ?? tmdbId;
    const tmdbFlag = imdbId ? "" : "&tmdb=1";
    if (kind === "movie") return [{ provider: "multiembed.mov", iframeUrl: `https://multiembed.mov/?video_id=${id}${tmdbFlag}` }];
    if (season != null && episode != null)
        return [{ provider: "multiembed.mov", iframeUrl: `https://multiembed.mov/?video_id=${id}${tmdbFlag}&s=${season}&e=${episode}` }];
    return [];
}

function smashy({ tmdbId, kind, season, episode }: ResolveInput): EmbedOption[] {
    if (kind === "movie") return [{ provider: "smashystream", iframeUrl: `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}` }];
    if (season != null && episode != null)
        return [{ provider: "smashystream", iframeUrl: `https://embed.smashystream.com/playere.php?tmdb=${tmdbId}&season=${season}&episode=${episode}` }];
    return [];
}

const resolvers = [vidsrcTo, vidsrcMe, twoEmbed, multiEmbed, smashy];

/** Resolve all available embed sources. Returns [] when the feature flag is off. */
export function resolveStreamingEmbeds(input: ResolveInput): EmbedOption[] {
    if (!isVidsrcEnabled()) return [];
    const opts: EmbedOption[] = [];
    for (const fn of resolvers) {
        try {
            opts.push(...fn(input));
        } catch {
            // Resolver failed — skip silently; we never want to crash the request.
        }
    }
    return opts;
}
