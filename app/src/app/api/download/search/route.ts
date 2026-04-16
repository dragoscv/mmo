import { NextRequest, NextResponse } from "next/server";
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
}

export interface ProviderSearchResult {
    provider: string;
    results: SearchResult[];
    error?: string;
}

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
    };
}

// ─── yt-dlp provider search ─────────────────────────────────────────────

async function searchYtDlpProvider(
    provider: string,
    query: string,
    limit: number,
): Promise<ProviderSearchResult> {
    try {
        // YouTube Music uses URL-based search
        if (provider === "youtubeMusic") {
            const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
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
                        duration: Number(e.duration || 0),
                        thumbnail: String(
                            (e.thumbnails as Record<string, unknown>[] | undefined)?.at(-1)?.url ||
                            e.thumbnail || ""
                        ),
                        uploader: String(e.uploader || e.channel || data.uploader || ""),
                        url: String(e.url || e.webpage_url || ""),
                        extractor: "YoutubeMusic",
                        viewCount: typeof e.view_count === "number" ? e.view_count : undefined,
                    }));
                return { provider, results };
            }
            return { provider, results: [] };
        }

        // Standard yt-dlp search prefix (ytsearch, scsearch)
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

async function searchDeezer(query: string, limit: number): Promise<ProviderSearchResult> {
    try {
        const q = encodeURIComponent(query);
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
            };
        });

        return { provider: "deezer", results };
    } catch (err) {
        const message = err instanceof Error ? err.message : "Deezer search failed";
        return { provider: "deezer", results: [], error: message };
    }
}

// ─── Apple Music / iTunes Search (free public API, no auth) ──────────────

async function searchAppleMusic(query: string, limit: number): Promise<ProviderSearchResult> {
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

async function searchSpotifyViaAPI(token: string, query: string, limit: number): Promise<SearchResult[]> {
    const q = encodeURIComponent(query);
    const res = await fetch(
        `https://api.spotify.com/v1/search?q=${q}&type=track&limit=${limit}`,
        {
            headers: { "Authorization": `Bearer ${token}` },
            signal: AbortSignal.timeout(10_000),
        },
    );
    if (!res.ok) throw new Error(`Spotify API returned ${res.status}`);

    const data = await res.json();
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
        };
    });
}

async function searchSpotify(query: string, limit: number): Promise<ProviderSearchResult> {
    // Tier 1: Try anonymous access token (may work in some regions/configurations)
    try {
        const anonToken = await getSpotifyAnonAccessToken();
        if (anonToken) {
            const results = await searchSpotifyViaAPI(anonToken, query, limit);
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
            const results = await searchSpotifyViaAPI(oauthToken, query, limit);
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

async function searchProvider(provider: string, query: string, limit: number): Promise<ProviderSearchResult> {
    const def = ALL_PROVIDERS[provider];
    if (!def) return { provider, results: [], error: `Unknown provider: ${provider}` };

    switch (provider) {
        case "deezer": return searchDeezer(query, limit);
        case "appleMusic": return searchAppleMusic(query, limit);
        case "spotify": return searchSpotify(query, limit);
        default: return searchYtDlpProvider(provider, query, limit);
    }
}

// ─── Route Handler ───────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const query = body?.query;
        const providers: string[] = body?.providers || ["youtube"];
        const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), 25);

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return NextResponse.json({ error: "Query must be at least 2 characters" }, { status: 400 });
        }

        const validProviders = providers.filter((p: string) => p in ALL_PROVIDERS);
        if (validProviders.length === 0) {
            return NextResponse.json({ error: "No valid providers specified" }, { status: 400 });
        }

        // Search all providers in parallel
        const results = await Promise.all(
            validProviders.map(p => searchProvider(p, query.trim(), limit))
        );

        return NextResponse.json({ results });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
