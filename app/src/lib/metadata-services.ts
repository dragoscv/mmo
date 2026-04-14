/**
 * Free music metadata API clients.
 * No API keys required for any of these services.
 *
 * Services:
 * - MusicBrainz: artist, title, album, year, label, genre, ISRC
 * - Cover Art Archive: album artwork via MusicBrainz release ID
 * - iTunes Search: artwork, genre, year
 * - Deezer: artwork, BPM, album
 * - LRCLIB: plain + synced lyrics
 */

const USER_AGENT = "MusicOrganizer/0.2.0 (https://github.com/rekordbox-mwrty)";

// ─── Rate Limiting ───────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastMusicBrainzCall = 0;

async function musicBrainzThrottle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastMusicBrainzCall;
    if (elapsed < 1100) {
        await delay(1100 - elapsed);
    }
    lastMusicBrainzCall = Date.now();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MusicBrainzResult {
    mbid: string;
    title: string;
    artist: string;
    album: string | null;
    year: number | null;
    label: string | null;
    genres: string[];
    isrc: string | null;
    releaseMbid: string | null;
    duration: number | null;
    score: number;
}

export interface CoverArtResult {
    imageUrl: string;
    thumbnailUrl: string;
}

export interface ITunesResult {
    artworkUrl: string;
    genre: string | null;
    album: string | null;
    year: number | null;
    duration: number | null;
}

export interface DeezerResult {
    artworkUrl: string;
    bpm: number | null;
    album: string | null;
    duration: number | null;
    previewUrl: string | null;
}

export interface LyricsResult {
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

export interface AggregatedMetadata {
    artist: string | null;
    title: string | null;
    album: string | null;
    year: number | null;
    label: string | null;
    genre: string | null;
    bpm: number | null;
    isrc: string | null;
    artworkUrl: string | null;
    lyrics: string | null;
    syncedLyrics: string | null;
    musicbrainzId: string | null;
    releaseMbid: string | null;
    duration: number | null;
    sources: Record<string, string>; // field → source name
}

// ─── MusicBrainz ─────────────────────────────────────────────────────────────

export async function searchMusicBrainz(
    artist: string,
    title: string
): Promise<MusicBrainzResult | null> {
    await musicBrainzThrottle();

    const query = encodeURIComponent(
        `recording:"${title}" AND artist:"${artist}"`
    );
    const url = `https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=3`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        const recordings = data.recordings;
        if (!recordings || recordings.length === 0) return null;

        // Pick the best match (highest score)
        const rec = recordings[0];
        const artistCredit = rec["artist-credit"]?.[0]?.artist?.name ?? artist;
        const release = rec.releases?.[0];

        // Extract genres from tags
        const genres: string[] = (rec.tags ?? [])
            .sort((a: { count: number }, b: { count: number }) => b.count - a.count)
            .slice(0, 3)
            .map((t: { name: string }) => t.name);

        // Extract ISRC (need separate lookup)
        let isrc: string | null = null;
        if (rec.isrcs && rec.isrcs.length > 0) {
            isrc = rec.isrcs[0];
        }

        const result: MusicBrainzResult = {
            mbid: rec.id,
            title: rec.title,
            artist: artistCredit,
            album: release?.title ?? null,
            year: release?.date ? parseInt(release.date.substring(0, 4), 10) : null,
            label: null,
            genres,
            isrc,
            releaseMbid: release?.id ?? null,
            duration: rec.length ? Math.round(rec.length / 1000) : null,
            score: parseInt(rec.score ?? "0", 10),
        };

        // Try to get label info from release
        if (release?.["label-info"]?.[0]?.label?.name) {
            result.label = release["label-info"][0].label.name;
        }

        return result;
    } catch {
        return null;
    }
}

// ─── Cover Art Archive ───────────────────────────────────────────────────────

export async function getCoverArt(
    releaseMbid: string
): Promise<CoverArtResult | null> {
    const url = `https://coverartarchive.org/release/${releaseMbid}`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        const front = data.images?.find(
            (img: { front: boolean }) => img.front === true
        );
        if (!front) return null;

        return {
            imageUrl: front.image,
            thumbnailUrl: front.thumbnails?.["500"] ?? front.thumbnails?.large ?? front.image,
        };
    } catch {
        return null;
    }
}

// ─── iTunes Search ───────────────────────────────────────────────────────────

export async function searchiTunes(
    artist: string,
    title: string
): Promise<ITunesResult | null> {
    const term = encodeURIComponent(`${artist} ${title}`);
    const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=3`;

    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        if (!data.results || data.results.length === 0) return null;

        // Find best match by comparing names
        const match = data.results[0];
        const artworkUrl = (match.artworkUrl100 as string)
            ?.replace("100x100bb", "600x600bb") ?? null;

        return {
            artworkUrl: artworkUrl ?? "",
            genre: match.primaryGenreName ?? null,
            album: match.collectionName ?? null,
            year: match.releaseDate
                ? parseInt(match.releaseDate.substring(0, 4), 10)
                : null,
            duration: match.trackTimeMillis
                ? Math.round(match.trackTimeMillis / 1000)
                : null,
        };
    } catch {
        return null;
    }
}

// ─── Deezer Search ───────────────────────────────────────────────────────────

export async function searchDeezer(
    artist: string,
    title: string
): Promise<DeezerResult | null> {
    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const url = `https://api.deezer.com/search?q=${q}&limit=3`;

    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        if (!data.data || data.data.length === 0) return null;

        const match = data.data[0];
        const artworkUrl =
            match.album?.cover_xl ?? match.album?.cover_big ?? match.album?.cover ?? "";

        // Try to get BPM from track detail
        let bpm: number | null = null;
        try {
            const detailRes = await fetch(
                `https://api.deezer.com/track/${match.id}`,
                { signal: AbortSignal.timeout(8000) }
            );
            if (detailRes.ok) {
                const detail = await detailRes.json();
                if (detail.bpm && detail.bpm > 0) {
                    bpm = Math.round(detail.bpm);
                }
            }
        } catch {
            // ignore
        }

        return {
            artworkUrl,
            bpm,
            album: match.album?.title ?? null,
            duration: match.duration ?? null,
            previewUrl: match.preview ?? null,
        };
    } catch {
        return null;
    }
}

// ─── LRCLIB (Lyrics) ─────────────────────────────────────────────────────────

export async function getLyrics(
    artist: string,
    title: string,
    album?: string | null,
    durationSec?: number | null
): Promise<LyricsResult | null> {
    const params = new URLSearchParams({
        artist_name: artist,
        track_name: title,
    });
    if (album) params.set("album_name", album);
    if (durationSec && durationSec > 0) params.set("duration", String(durationSec));

    const url = `https://lrclib.net/api/get?${params.toString()}`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            // Fallback: search endpoint
            if (res.status === 404) {
                return searchLrclib(artist, title);
            }
            return null;
        }

        const data = await res.json();
        return {
            plainLyrics: data.plainLyrics ?? null,
            syncedLyrics: data.syncedLyrics ?? null,
        };
    } catch {
        return null;
    }
}

async function searchLrclib(
    artist: string,
    title: string
): Promise<LyricsResult | null> {
    const q = encodeURIComponent(`${artist} ${title}`);
    const url = `https://lrclib.net/api/search?q=${q}`;

    try {
        const res = await fetch(url, {
            headers: { "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return null;

        const best = data[0];
        return {
            plainLyrics: best.plainLyrics ?? null,
            syncedLyrics: best.syncedLyrics ?? null,
        };
    } catch {
        return null;
    }
}

// ─── Aggregator ──────────────────────────────────────────────────────────────

interface FetchOptions {
    metadata: boolean;
    artwork: boolean;
    lyrics: boolean;
    bpmKey: boolean;
}

export async function fetchAllMetadata(
    artist: string,
    title: string,
    album: string | null,
    durationSec: number | null,
    options: FetchOptions
): Promise<AggregatedMetadata> {
    const result: AggregatedMetadata = {
        artist: null,
        title: null,
        album: null,
        year: null,
        label: null,
        genre: null,
        bpm: null,
        isrc: null,
        artworkUrl: null,
        lyrics: null,
        syncedLyrics: null,
        musicbrainzId: null,
        releaseMbid: null,
        duration: null,
        sources: {},
    };

    // Launch parallel requests (except MusicBrainz which has strict rate limit)
    const promises: Promise<void>[] = [];

    // iTunes
    if (options.artwork || options.metadata) {
        promises.push(
            searchiTunes(artist, title).then((itunes) => {
                if (!itunes) return;
                if (options.artwork && itunes.artworkUrl) {
                    result.artworkUrl = itunes.artworkUrl;
                    result.sources.artworkUrl = "iTunes";
                }
                if (options.metadata) {
                    if (itunes.genre) {
                        result.genre = itunes.genre;
                        result.sources.genre = "iTunes";
                    }
                    if (itunes.album) {
                        result.album = itunes.album;
                        result.sources.album = "iTunes";
                    }
                    if (itunes.year) {
                        result.year = itunes.year;
                        result.sources.year = "iTunes";
                    }
                }
            })
        );
    }

    // Deezer
    if (options.artwork || options.bpmKey) {
        promises.push(
            searchDeezer(artist, title).then((deezer) => {
                if (!deezer) return;
                // Artwork: Deezer as fallback for iTunes
                if (options.artwork && deezer.artworkUrl && !result.artworkUrl) {
                    result.artworkUrl = deezer.artworkUrl;
                    result.sources.artworkUrl = "Deezer";
                }
                if (options.bpmKey && deezer.bpm) {
                    result.bpm = deezer.bpm;
                    result.sources.bpm = "Deezer";
                }
                if (options.metadata && deezer.album && !result.album) {
                    result.album = deezer.album;
                    result.sources.album = "Deezer";
                }
            })
        );
    }

    // Lyrics
    if (options.lyrics) {
        promises.push(
            getLyrics(artist, title, album, durationSec).then((lyr) => {
                if (!lyr) return;
                if (lyr.plainLyrics) {
                    result.lyrics = lyr.plainLyrics;
                    result.sources.lyrics = "LRCLIB";
                }
                if (lyr.syncedLyrics) {
                    result.syncedLyrics = lyr.syncedLyrics;
                    result.sources.syncedLyrics = "LRCLIB";
                }
            })
        );
    }

    // Wait for parallel requests
    await Promise.allSettled(promises);

    // MusicBrainz (rate-limited, runs after parallel batch)
    if (options.metadata) {
        const mb = await searchMusicBrainz(artist, title);
        if (mb) {
            result.musicbrainzId = mb.mbid;
            result.sources.musicbrainzId = "MusicBrainz";

            if (mb.releaseMbid) {
                result.releaseMbid = mb.releaseMbid;
                result.sources.releaseMbid = "MusicBrainz";
            }
            if (mb.isrc) {
                result.isrc = mb.isrc;
                result.sources.isrc = "MusicBrainz";
            }
            if (mb.year && !result.year) {
                result.year = mb.year;
                result.sources.year = "MusicBrainz";
            }
            if (mb.label) {
                result.label = mb.label;
                result.sources.label = "MusicBrainz";
            }
            if (mb.album && !result.album) {
                result.album = mb.album;
                result.sources.album = "MusicBrainz";
            }
            if (mb.genres.length > 0 && !result.genre) {
                // Capitalize first letter of genre
                result.genre = mb.genres[0].charAt(0).toUpperCase() + mb.genres[0].slice(1);
                result.sources.genre = "MusicBrainz";
            }
            if (mb.duration) {
                result.duration = mb.duration;
                result.sources.duration = "MusicBrainz";
            }

            // Cover Art Archive for higher quality artwork
            if (options.artwork && mb.releaseMbid) {
                const art = await getCoverArt(mb.releaseMbid);
                if (art) {
                    result.artworkUrl = art.thumbnailUrl;
                    result.sources.artworkUrl = "Cover Art Archive";
                }
            }
        }
    }

    return result;
}
