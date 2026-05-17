/**
 * Subtitle search providers — OpenSubtitles + Addic7ed.
 *
 * Both run from the companion (user's machine) so the user's API key
 * stays local. Web app calls /video/subs/search → /video/subs/download
 * and renders the returned VTT in the player as a `<track>`.
 */

export interface SubtitleSearchOptions {
    title?: string;
    year?: number;
    imdbId?: string;
    tmdbId?: number;
    kind?: "movie" | "tv";
    season?: number;
    episode?: number;
    languages?: string[];
}

export interface SubtitleResult {
    provider: "opensubtitles" | "addic7ed";
    id: string;
    language: string;
    title: string;
    release?: string;
    downloads?: number;
    /** Opaque token used by `/video/subs/download?provider=&id=&lang=` */
    downloadToken: string;
}

const OS_BASE = "https://api.opensubtitles.com/api/v1";

function openSubsKey(): string | null {
    return process.env.OPENSUBTITLES_API_KEY?.trim() || null;
}

interface OpenSubsAttributes {
    language?: string;
    feature_details?: { title?: string };
    release?: string;
    download_count?: number;
    files?: Array<{ file_id?: number }>;
}

interface OpenSubsItem {
    id: string;
    attributes?: OpenSubsAttributes;
}

/** Search OpenSubtitles. Requires OPENSUBTITLES_API_KEY. */
export async function searchOpenSubtitles(opts: SubtitleSearchOptions): Promise<SubtitleResult[]> {
    const key = openSubsKey();
    if (!key) return [];
    const params = new URLSearchParams();
    if (opts.imdbId) params.set("imdb_id", opts.imdbId.replace(/^tt/, ""));
    if (opts.tmdbId) params.set("tmdb_id", String(opts.tmdbId));
    if (opts.languages?.length) params.set("languages", opts.languages.join(","));
    if (opts.kind === "tv" && opts.season != null) params.set("season_number", String(opts.season));
    if (opts.kind === "tv" && opts.episode != null) params.set("episode_number", String(opts.episode));
    if (opts.title && !opts.imdbId && !opts.tmdbId) params.set("query", opts.title);

    const r = await fetch(`${OS_BASE}/subtitles?${params}`, {
        headers: { "Api-Key": key, "User-Agent": "mmo-companion/1.0", Accept: "application/json" },
    });
    if (!r.ok) return [];
    const json = await r.json() as { data?: OpenSubsItem[] };
    return (json.data ?? []).slice(0, 25).map((item) => {
        const fileId = item.attributes?.files?.[0]?.file_id;
        return {
            provider: "opensubtitles" as const,
            id: item.id,
            language: item.attributes?.language ?? "unknown",
            title: item.attributes?.feature_details?.title ?? "",
            release: item.attributes?.release,
            downloads: item.attributes?.download_count,
            downloadToken: String(fileId ?? item.id),
        };
    });
}

/** Download a subtitle from OpenSubtitles and return WebVTT. */
export async function downloadOpenSubtitles(fileId: string): Promise<string | null> {
    const key = openSubsKey();
    if (!key) return null;
    // Step 1: ask the API for a download link
    const r = await fetch(`${OS_BASE}/download`, {
        method: "POST",
        headers: { "Api-Key": key, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "mmo-companion/1.0" },
        body: JSON.stringify({ file_id: Number(fileId) }),
    });
    if (!r.ok) return null;
    const j = await r.json() as { link?: string };
    if (!j.link) return null;
    // Step 2: download the actual file (usually .srt)
    const sub = await fetch(j.link);
    if (!sub.ok) return null;
    const text = await sub.text();
    return srtToVtt(text);
}

/**
 * Addic7ed has no official API — placeholder. A real implementation
 * would scrape with cheerio + login session, which is fragile and
 * rate-limited. We return an empty list and surface this as
 * "Addic7ed unavailable" in the UI rather than failing.
 */
export async function searchAddic7ed(_opts: SubtitleSearchOptions): Promise<SubtitleResult[]> {
    return [];
}

/** Minimal SRT → WebVTT converter (good enough for in-player rendering). */
export function srtToVtt(srt: string): string {
    const body = srt
        .replace(/\r+/g, "")
        .replace(/^\uFEFF/, "")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    return `WEBVTT\n\n${body}`;
}
