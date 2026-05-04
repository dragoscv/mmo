"use server";

/**
 * Global search across the user's companion library.
 *
 * Returns empty results when not signed in or no companion is linked.
 * Implementation: queries the companion's /library/tracks endpoint with
 * the search filter (server-side LIKE), then groups locally for the
 * artists/albums/genres lists. Cheap because the companion already caps
 * the page size.
 */

import {
    companionLibrary,
    getCompanionLink,
} from "@/lib/companion-library";

export interface SearchResult {
    tracks: {
        id: number;
        title: string | null;
        artist: string | null;
        album: string | null;
        genre: string | null;
        bpm: number | null;
        keyCamelot: string | null;
        energy: number | null;
        duration: number | null;
        artworkUrl: string | null;
    }[];
    artists: { name: string; trackCount: number }[];
    albums: { name: string; artist: string | null; trackCount: number }[];
    genres: { name: string; trackCount: number }[];
    playlists: {
        id: number;
        name: string;
        description: string | null;
        trackCount: number;
    }[];
}

const EMPTY: SearchResult = {
    tracks: [], artists: [], albums: [], genres: [], playlists: [],
};

export async function globalSearch(query: string): Promise<SearchResult> {
    const trimmed = query.trim();
    if (!trimmed) return EMPTY;

    const link = await getCompanionLink();
    if (!link) return EMPTY;

    try {
        // Fetch a wider page for grouping; cap visible to 8.
        const [matches, allPlaylists] = await Promise.all([
            companionLibrary.getTracks(link, {
                search: trimmed, page: 1, pageSize: 200, sort: "addedAt", order: "desc",
            }),
            companionLibrary.getPlaylists(link),
        ]);

        const tracks = matches.tracks.slice(0, 8).map((t) => ({
            id: t.id, title: t.title, artist: t.artist, album: t.album,
            genre: t.genre, bpm: t.bpm, keyCamelot: t.keyCamelot,
            energy: t.energy, duration: t.duration, artworkUrl: t.artworkUrl,
        }));

        const lower = trimmed.toLowerCase();
        const artistCounts = new Map<string, number>();
        const albumCounts = new Map<string, { artist: string | null; count: number }>();
        const genreCounts = new Map<string, number>();

        for (const t of matches.tracks) {
            if (t.artist && t.artist.toLowerCase().includes(lower)) {
                artistCounts.set(t.artist, (artistCounts.get(t.artist) ?? 0) + 1);
            }
            if (t.album && t.album.toLowerCase().includes(lower)) {
                const cur = albumCounts.get(t.album);
                albumCounts.set(t.album, { artist: cur?.artist ?? t.artist, count: (cur?.count ?? 0) + 1 });
            }
            if (t.genre && t.genre.toLowerCase().includes(lower)) {
                genreCounts.set(t.genre, (genreCounts.get(t.genre) ?? 0) + 1);
            }
        }

        const playlistMatches = allPlaylists
            .filter((p) => p.name.toLowerCase().includes(lower))
            .slice(0, 5)
            .map((p) => ({
                id: p.id, name: p.name, description: p.description, trackCount: p.trackCount,
            }));

        return {
            tracks,
            artists: Array.from(artistCounts, ([name, trackCount]) => ({ name, trackCount }))
                .sort((a, b) => b.trackCount - a.trackCount).slice(0, 5),
            albums: Array.from(albumCounts, ([name, v]) => ({ name, artist: v.artist, trackCount: v.count }))
                .sort((a, b) => b.trackCount - a.trackCount).slice(0, 5),
            genres: Array.from(genreCounts, ([name, trackCount]) => ({ name, trackCount }))
                .sort((a, b) => b.trackCount - a.trackCount).slice(0, 5),
            playlists: playlistMatches,
        };
    } catch (err) {
        console.warn("[search] globalSearch failed:", err);
        return EMPTY;
    }
}
