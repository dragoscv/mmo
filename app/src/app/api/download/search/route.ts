import { NextRequest, NextResponse } from "next/server";
import { requireSessionWithRate } from "@/lib/api-guard";
import { spawn } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────

export interface SearchResult {
    id: string;
    title: string;
    duration: number;
    thumbnail: string;
    uploader: string;
    url: string;
    /** For metadata providers (Deezer/iTunes/Spotify), the yt-dlp search query to download via YouTube */
    downloadUrl?: string;
    extractor: string;
    album?: string;
    viewCount?: number;
    /** ISO 8601 date string (YYYY-MM-DD or full ISO). Best-effort across providers. */
    publishedAt?: string;
    /** Playlist results only */
    isPlaylist?: boolean;
    trackCount?: number;
}

export interface ProviderSearchResult {
    provider: string;
    results: SearchResult[];
    error?: string;
}

export type SearchType = "tracks" | "playlists";

/** Which providers support playlist search */
const PLAYLIST_PROVIDERS = new Set(["youtube", "youtubeMusic", "soundcloud", "deezer", "spotify"]);

// ─── All known providers ─────────────────────────────────────────────────

type ProviderType = "ytdlp" | "api";

interface ProviderDef {
    type: ProviderType;
    label: string;
}

const ALL_PROVIDERS: Record<string, ProviderDef> = {
    youtube: { type: "ytdlp", label: "YouTube" },
    youtubeMusic: { type: "ytdlp", label: "YouTube Music" },
    soundcloud: { type: "ytdlp", label: "SoundCloud" },
    deezer: { type: "api", label: "Deezer" },
    appleMusic: { type: "api", label: "Apple Music" },
    spotify: { type: "api", label: "Spotify" },
};

// ─── yt-dlp helpers ──────────────────────────────────────────────────────

function runYtDlpSearch(args: string[], timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn("yt-dlp", args, { windowsHide: true });
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

        proc.on("close", (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(0, 300)}`));
        });

        proc.on("error", (err) => {
            reject(new Error(`Failed to run yt-dlp: ${err.message}`));
        });

        const timer = setTimeout(() => {
            proc.kill("SIGTERM");
            reject(new Error("Search timed out"));
        }, timeoutMs);

        proc.on("close", () => clearTimeout(timer));
    });
}

function parseYtDlpResult(data: Record<string, unknown>): SearchResult {
    return {
        id: String(data.id || ""),
        title: String(data.title || data.fulltitle || "Unknown"),
        duration: Number(data.duration || 0),
        thumbnail: String(
            data.thumbnail ||
            ((data.thumbnails as Record<string, unknown>[] | undefined)?.at(-1) as Record<string, unknown>)?.url ||
            ""
        ),
        uploader: String(data.uploader || data.channel || ""),
        url: String(data.webpage_url || data.url || ""),
        extractor: String(data.extractor_key || data.extractor || ""),
        viewCount: typeof data.view_count === "number" ? data.view_count : undefined,
        publishedAt: ytDlpDate(data),
    };
}

/** Extract a published / upload date from a yt-dlp record.
 *  yt-dlp exposes several candidate fields depending on the extractor:
 *    - `upload_date`  / `release_date`  (string "YYYYMMDD")
 *    - `timestamp`    / `release_timestamp` (unix seconds) */
function ytDlpDate(data: Record<string, unknown>): string | undefined {
    const dateStr = (data.release_date || data.upload_date) as string | undefined;
    if (typeof dateStr === "string" && /^\d{8}$/.test(dateStr)) {
        return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
    }
    const ts = (data.release_timestamp || data.timestamp) as number | undefined;
    if (typeof ts === "number" && ts > 0) {
        return new Date(ts * 1000).toISOString().slice(0, 10);
    }
    return undefined;
}

// ─── yt-dlp provider search ─────────────────────────────────────────────

async function searchYtDlpProvider(
    provider: string,
    query: string,
    limit: number,
    searchType: SearchType = "tracks",
): Promise<ProviderSearchResult> {
    try {
        // Playlist search mode for YouTube
        if (searchType === "playlists" && provider === "youtube") {
            // yt-dlp doesn't have a native playlist search prefix,
            // but we can search YouTube playlists via URL
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAw%3D%3D`;
            const raw = await runYtDlpSearch([
                "--flat-playlist", "-J", "--no-download", "--no-warnings",
                "--playlist-end", String(limit),
                searchUrl,
            ], 25_000);
            const data = JSON.parse(raw);

            if (data._type === "playlist" && Array.isArray(data.entries)) {
                const results = (data.entries as Record<string, unknown>[])
                    .filter(e => e && (e.id || e.url))
                    .map(e => ({
                        id: String(e.id || ""),
                        title: String(e.title || "Unknown"),
                        duration: 0,
                        thumbnail: String(
                            (e.thumbnails as Record<string, unknown>[] | undefined)?.at(-1)?.url ||
                            e.thumbnail || ""
                        ),
                        uploader: String(e.uploader || e.channel || ""),
                        url: String(e.url?.toString().startsWith("http") ? e.url : e.webpage_url || `https://www.youtube.com/playlist?list=${e.id}`),
                        extractor: "YouTube",
                        isPlaylist: true,
                        trackCount: typeof e.playlist_count === "number" ? e.playlist_count : undefined,
                    }));
                return { provider, results };
            }
            return { provider, results: [] };
        }

        // YouTube Music uses URL-based search
        if (provider === "youtubeMusic") {
            const suffix = searchType === "playlists" ? "&filter=playlists" : "";
            const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(query)}${suffix}`;
            const raw = await runYtDlpSearch([
                "--flat-playlist", "-J", "--no-download", "--no-warnings",
                "--playlist-end", String(limit),
                searchUrl,
            ], 25_000);
            const data = JSON.parse(raw);

            if (data._type === "playlist" && Array.isArray(data.entries)) {
                const isPlaylistMode = searchType === "playlists";
                const results = (data.entries as Record<string, unknown>[])
                    .filter(e => e && (e.id || e.url))
                    .map(e => ({
                        id: String(e.id || ""),
                        title: String(e.title || "Unknown"),
                        duration: isPlaylistMode ? 0 : Number(e.duration || 0),
                        thumbnail: String(
                            (e.thumbnails as Record<string, unknown>[] | undefined)?.at(-1)?.url ||
                            e.thumbnail || ""
                        ),
                        uploader: String(e.uploader || e.channel || data.uploader || ""),
                        url: String(e.url || e.webpage_url || ""),
                        extractor: "YoutubeMusic",
                        viewCount: typeof e.view_count === "number" ? e.view_count : undefined,
                        publishedAt: ytDlpDate(e),
                        ...(isPlaylistMode ? { isPlaylist: true, trackCount: typeof e.playlist_count === "number" ? e.playlist_count : undefined } : {}),
                    }));
                return { provider, results };
            }
            return { provider, results: [] };
        }

        // SoundCloud playlist search
        if (searchType === "playlists" && provider === "soundcloud") {
            // SoundCloud playlists/sets can be searched via URL
            const searchUrl = `https://soundcloud.com/search/sets?q=${encodeURIComponent(query)}`;
            const raw = await runYtDlpSearch([
                "--flat-playlist", "-J", "--no-download", "--no-warnings",
                "--playlist-end", String(limit),
                searchUrl,
            ], 25_000);
            const data = JSON.parse(raw);

            if (data._type === "playlist" && Array.isArray(data.entries)) {
                const results = (data.entries as Record<string, unknown>[])
                    .filter(e => e && (e.id || e.url))
                    .map(e => ({
                        id: String(e.id || ""),
                        title: String(e.title || "Unknown"),
                        duration: 0,
                        thumbnail: String(
                            (e.thumbnails as Record<string, unknown>[] | undefined)?.at(-1)?.url ||
                            e.thumbnail || ""
                        ),
                        uploader: String(e.uploader || e.channel || ""),
                        url: String(e.url || e.webpage_url || ""),
                        extractor: "SoundCloud",
                        isPlaylist: true,
                        trackCount: typeof e.playlist_count === "number" ? e.playlist_count : undefined,
                    }));
                return { provider, results };
            }
            return { provider, results: [] };
        }

        // Standard yt-dlp track search (ytsearch, scsearch)
        const prefix = provider === "soundcloud" ? "scsearch" : "ytsearch";
        const searchQuery = `${prefix}${limit}:${query}`;
        const raw = await runYtDlpSearch([
            "-j", "--no-download", "--no-warnings",
            "--flat-playlist",
            searchQuery,
        ]);

        const results = raw
            .trim()
            .split("\n")
            .filter(line => line.trim())
            .map(line => {
                try { return parseYtDlpResult(JSON.parse(line)); }
                catch { return null; }
            })
            .filter((r): r is SearchResult => r !== null);

        return { provider, results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "Search failed";
        return { provider, results: [], error: message };
    }
}

// ─── Deezer Search (free public API, no auth) ───────────────────────────

async function searchDeezer(query: string, limit: number, searchType: SearchType = "tracks"): Promise<ProviderSearchResult> {
    try {
        const q = encodeURIComponent(query);

        // Playlist search
        if (searchType === "playlists") {
            const res = await fetch(`https://api.deezer.com/search/playlist?q=${q}&limit=${limit}`, {
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`Deezer API returned ${res.status}`);

            const data = await res.json();
            if (!data.data || !Array.isArray(data.data)) return { provider: "deezer", results: [] };

            const results: SearchResult[] = data.data.map((p: Record<string, unknown>) => ({
                id: String(p.id || ""),
                title: String(p.title || "Unknown"),
                duration: 0,
                thumbnail: String(p.picture_big || p.picture_medium || p.picture || ""),
                uploader: String((p.user as Record<string, unknown>)?.name || ""),
                url: String(p.link || `https://www.deezer.com/playlist/${p.id}`),
                extractor: "Deezer",
                isPlaylist: true,
                trackCount: typeof p.nb_tracks === "number" ? p.nb_tracks : undefined,
            }));

            return { provider: "deezer", results };
        }

        // Track search
        const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=${limit}`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Deezer API returned ${res.status}`);

        const data = await res.json();
        if (!data.data || !Array.isArray(data.data)) return { provider: "deezer", results: [] };

        const results: SearchResult[] = data.data.map((t: Record<string, unknown>) => {
            const artist = (t.artist as Record<string, unknown>)?.name as string || "";
            const album = t.album as Record<string, unknown> | undefined;
            const title = String(t.title || "Unknown");
            return {
                id: String(t.id || ""),
                title,
                duration: Number(t.duration || 0),
                thumbnail: String(album?.cover_big || album?.cover_medium || album?.cover || ""),
                uploader: artist,
                url: String(t.link || ""),
                // yt-dlp search query to find this track on YouTube for downloading
                downloadUrl: `ytsearch1:${artist} - ${title}`,
                extractor: "Deezer",
                album: String(album?.title || ""),
                publishedAt: typeof album?.release_date === "string" ? album.release_date as string : undefined,
            };
        });

        return { provider: "deezer", results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "Deezer search failed";
        return { provider: "deezer", results: [], error: message };
    }
}

// ─── Apple Music / iTunes Search (free public API, no auth) ──────────────

async function searchAppleMusic(query: string, limit: number, searchType: SearchType = "tracks"): Promise<ProviderSearchResult> {
    // Apple Music / iTunes API doesn't support playlist search without auth
    if (searchType === "playlists") {
        return { provider: "appleMusic", results: [], error: "Apple Music doesn't support playlist search" };
    }

    try {
        const term = encodeURIComponent(query);
        const res = await fetch(
            `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=${limit}`,
            { signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) throw new Error(`iTunes API returned ${res.status}`);

        const data = await res.json();
        if (!data.results || !Array.isArray(data.results)) return { provider: "appleMusic", results: [] };

        const results: SearchResult[] = data.results.map((t: Record<string, unknown>) => {
            const artist = String(t.artistName || "");
            const title = String(t.trackName || "Unknown");
            const artworkUrl = String(t.artworkUrl100 || "").replace("100x100bb", "400x400bb");
            return {
                id: String(t.trackId || ""),
                title,
                duration: Math.round(Number(t.trackTimeMillis || 0) / 1000),
                thumbnail: artworkUrl,
                uploader: artist,
                url: String(t.trackViewUrl || ""),
                downloadUrl: `ytsearch1:${artist} - ${title}`,
                extractor: "AppleMusic",
                album: String(t.collectionName || ""),
                publishedAt: typeof t.releaseDate === "string" ? (t.releaseDate as string).slice(0, 10) : undefined,
            };
        });

        return { provider: "appleMusic", results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "Apple Music search failed";
        return { provider: "appleMusic", results: [], error: message };
    }
}

// ─── Spotify Search ──────────────────────────────────────────────────────
// Two-tier approach:
//  1. Try Spotify's internal web API (anonymous, no env vars needed)
//  2. Fall back to official API with SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET

// --- Tier 1: Spotify internal web API (anonymous) ---
// The Spotify web player uses an internal partner API with a client token.
// We replicate this flow: get a client token, then use the internal search.

let spotifyClientToken: string | null = null;
let spotifyClientTokenExpiry = 0;

async function getSpotifyClientToken(): Promise<string | null> {
    // Reuse cached token
    if (spotifyClientToken && Date.now() < spotifyClientTokenExpiry - 30_000) {
        return spotifyClientToken;
    }

    try {
        // Spotify's web player client ID (public, embedded in the web player JS)
        const res = await fetch("https://clienttoken.spotify.com/v1/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_data: {
                    client_version: "1.2.52.442.g0f1fed36",
                    client_id: "d8a5ed958d274c2e8ee717e6a4b0971d",
                    js_sdk_data: {},
                },
            }),
            signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) return null;

        const data = await res.json();
        const token = data.granted_token?.token;
        const expiresAfterSeconds = data.granted_token?.refresh_after_seconds || 3600;

        if (!token) return null;

        spotifyClientToken = token;
        spotifyClientTokenExpiry = Date.now() + expiresAfterSeconds * 1000;
        return token;
    } catch {
        return null;
    }
}

// Spotify's internal anonymous access token (obtained via web player flow)
let spotifyAnonToken: string | null = null;
let spotifyAnonTokenExpiry = 0;

async function getSpotifyAnonAccessToken(): Promise<string | null> {
    if (spotifyAnonToken && Date.now() < spotifyAnonTokenExpiry - 30_000) {
        return spotifyAnonToken;
    }

    try {
        // Try to get an anonymous access token via the web player's internal endpoint
        const res = await fetch("https://open.spotify.com/get_access_token?reason=transport&productType=web_player", {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "application/json",
            },
            signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) return null;

        const data = await res.json();
        if (!data.accessToken) return null;

        spotifyAnonToken = data.accessToken;
        spotifyAnonTokenExpiry = data.accessTokenExpirationTimestampMs || (Date.now() + 3600_000);
        return spotifyAnonToken;
    } catch {
        return null;
    }
}

// --- Tier 2: Official API with Client Credentials ---

let spotifyOAuthToken: string | null = null;
let spotifyOAuthTokenExpiry = 0;

async function getSpotifyOAuthToken(): Promise<string | null> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;

    if (spotifyOAuthToken && Date.now() < spotifyOAuthTokenExpiry - 60_000) return spotifyOAuthToken;

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Authorization": `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    spotifyOAuthToken = data.access_token;
    spotifyOAuthTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
    return spotifyOAuthToken;
}

// --- Combined Spotify search ---

async function searchSpotifyViaAPI(token: string, query: string, limit: number, searchType: SearchType = "tracks"): Promise<SearchResult[]> {
    const q = encodeURIComponent(query);
    const type = searchType === "playlists" ? "playlist" : "track";
    const res = await fetch(
        `https://api.spotify.com/v1/search?q=${q}&type=${type}&limit=${limit}`,
        {
            headers: { "Authorization": `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        },
    );
    if (!res.ok) throw new Error(`Spotify API returned ${res.status}`);

    const data = await res.json();

    // Playlist results
    if (searchType === "playlists") {
        const items = data.playlists?.items;
        if (!Array.isArray(items)) return [];
        return items.filter(Boolean).map((p: Record<string, unknown>) => {
            const images = p.images as Record<string, unknown>[] | undefined;
            const owner = p.owner as Record<string, unknown> | undefined;
            return {
                id: String(p.id || ""),
                title: String(p.name || "Unknown"),
                duration: 0,
                thumbnail: String(images?.[0]?.url || ""),
                uploader: String(owner?.display_name || ""),
                url: String((p.external_urls as Record<string, unknown>)?.spotify || ""),
                extractor: "Spotify",
                isPlaylist: true,
                trackCount: typeof (p.tracks as Record<string, unknown>)?.total === "number"
                    ? (p.tracks as Record<string, unknown>).total as number
                    : undefined,
            };
        });
    }

    // Track results
    const items = data.tracks?.items;
    if (!Array.isArray(items)) return [];

    return items.map((t: Record<string, unknown>) => {
        const artists = t.artists as Record<string, unknown>[] | undefined;
        const albumData = t.album as Record<string, unknown> | undefined;
        const images = albumData?.images as Record<string, unknown>[] | undefined;
        const artist = artists?.map(a => String(a.name || "")).join(", ") || "";
        const title = String(t.name || "Unknown");
        return {
            id: String(t.id || ""),
            title,
            duration: Math.round(Number(t.duration_ms || 0) / 1000),
            thumbnail: String(images?.[0]?.url || ""),
            uploader: artist,
            url: String((t.external_urls as Record<string, unknown>)?.spotify || ""),
            downloadUrl: `ytsearch1:${artist} - ${title}`,
            extractor: "Spotify",
            album: String(albumData?.name || ""),
            publishedAt: typeof albumData?.release_date === "string" ? albumData.release_date as string : undefined,
        };
    });
}

async function searchSpotify(query: string, limit: number, searchType: SearchType = "tracks"): Promise<ProviderSearchResult> {
    // Tier 1: Try anonymous access token (may work in some regions/configurations)
    try {
        const anonToken = await getSpotifyAnonAccessToken();
        if (anonToken) {
            const results = await searchSpotifyViaAPI(anonToken, query, limit, searchType);
            return { provider: "spotify", results };
        }
    } catch {
        // Anonymous token didn't work, try next tier
        spotifyAnonToken = null;
    }

    // Tier 2: Try official Client Credentials (env vars)
    try {
        const oauthToken = await getSpotifyOAuthToken();
        if (oauthToken) {
            const results = await searchSpotifyViaAPI(oauthToken, query, limit, searchType);
            return { provider: "spotify", results };
        }
    } catch {
        spotifyOAuthToken = null;
    }

    // No token available
    return {
        provider: "spotify",
        results: [],
        error: "Spotify search requires setup: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env file (free at developer.spotify.com → Create App → Client Credentials)",
    };
}

// ─── Dispatch search to the right provider ───────────────────────────────

async function searchProvider(provider: string, query: string, limit: number, searchType: SearchType = "tracks"): Promise<ProviderSearchResult> {
    const def = ALL_PROVIDERS[provider];
    if (!def) return { provider, results: [], error: `Unknown provider: ${provider}` };

    // Check if this provider supports playlist search
    if (searchType === "playlists" && !PLAYLIST_PROVIDERS.has(provider)) {
        return { provider, results: [], error: `${def.label} doesn't support playlist search` };
    }

    switch (provider) {
        case "deezer": return searchDeezer(query, limit, searchType);
        case "appleMusic": return searchAppleMusic(query, limit, searchType);
        case "spotify": return searchSpotify(query, limit, searchType);
        default: return searchYtDlpProvider(provider, query, limit, searchType);
    }
}

// ─── Route Handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    const guard = await requireSessionWithRate(request, { bucket: "download-search", windowMs: 60_000, max: 30 });
    if (guard.response) return guard.response;
    try {
        const body = await request.json();
        const query = body?.query;
        const providers: string[] = body?.providers || ["youtube"];
        const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 50);
        const searchType: SearchType = body?.searchType === "playlists" ? "playlists" : "tracks";

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return NextResponse.json({ error: "Query must be at least 2 characters" }, { status: 400 });
        }

        const validProviders = providers.filter((p: string) => p in ALL_PROVIDERS);
        if (validProviders.length === 0) {
            return NextResponse.json({ error: "No valid providers specified" }, { status: 400 });
        }

        // Search all providers in parallel
        const results = await Promise.all(
            validProviders.map(p => searchProvider(p, query.trim(), limit, searchType))
        );

        return NextResponse.json({ results });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
