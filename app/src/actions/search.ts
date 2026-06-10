"use server";

import { log } from "@/lib/logger";
import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows } from "@/db/schema";
import { dawProjects, editorProjects, liveSessions } from "@/db/schema-projects";
import { and, desc, eq, ilike, sql } from "drizzle-orm";

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
    movies: {
        id: number;
        title: string;
        year: number | null;
        posterPath: string | null;
        rating: number | null;
    }[];
    shows: {
        id: number;
        title: string;
        firstAirYear: number | null;
        posterPath: string | null;
        rating: number | null;
    }[];
    projects: {
        id: number;
        name: string;
        kind: "daw" | "editor" | "live";
        href: string;
        updatedAt: Date | null;
    }[];
}

const EMPTY: SearchResult = {
    tracks: [], artists: [], albums: [], genres: [], playlists: [],
    movies: [], shows: [], projects: [],
};

// 200 chars is well over any realistic search; longer values are either
// a mistake (paste of an entire row) or a slow-LIKE DoS attempt against
// the companion's SQL full-text index.
const MAX_QUERY_CHARS = 200;

export async function globalSearch(query: string): Promise<SearchResult> {
    if (typeof query !== "string") return EMPTY;
    const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
    if (!trimmed) return EMPTY;

    const session = await auth();
    const userId = session?.user?.id;
    const like = `%${trimmed}%`;

    // Video + project lookups run in parallel with the companion call; the
    // music side may legitimately return empty (no companion linked) and we
    // still want to surface films/series/projects.
    const localPromises = userId
        ? [
            db.select({ id: movies.id, title: movies.title, year: movies.year, posterPath: movies.posterPath, rating: movies.rating })
                .from(movies)
                .where(and(eq(movies.userId, userId), ilike(movies.title, like)))
                .orderBy(desc(movies.addedAt))
                .limit(6),
            db.select({ id: tvShows.id, title: tvShows.title, firstAirYear: tvShows.firstAirYear, posterPath: tvShows.posterPath, rating: tvShows.rating })
                .from(tvShows)
                .where(and(eq(tvShows.userId, userId), ilike(tvShows.title, like)))
                .orderBy(desc(tvShows.addedAt))
                .limit(6),
            db.select({ id: dawProjects.id, name: dawProjects.name, updatedAt: dawProjects.updatedAt })
                .from(dawProjects)
                .where(and(eq(dawProjects.userId, userId), ilike(dawProjects.name, like), sql`${dawProjects.deletedAt} IS NULL`))
                .orderBy(desc(dawProjects.updatedAt))
                .limit(4),
            db.select({ id: editorProjects.id, name: editorProjects.name, updatedAt: editorProjects.updatedAt })
                .from(editorProjects)
                .where(and(eq(editorProjects.userId, userId), ilike(editorProjects.name, like), sql`${editorProjects.deletedAt} IS NULL`))
                .orderBy(desc(editorProjects.updatedAt))
                .limit(4),
            db.select({ id: liveSessions.id, name: liveSessions.name, updatedAt: liveSessions.updatedAt })
                .from(liveSessions)
                .where(and(eq(liveSessions.userId, userId), ilike(liveSessions.name, like), sql`${liveSessions.deletedAt} IS NULL`))
                .orderBy(desc(liveSessions.updatedAt))
                .limit(4),
        ] as const
        : ([Promise.resolve([]), Promise.resolve([]), Promise.resolve([]), Promise.resolve([]), Promise.resolve([])] as const);

    const link = await getCompanionLink();
    let musicResult: Pick<SearchResult, "tracks" | "artists" | "albums" | "genres" | "playlists"> = {
        tracks: [], artists: [], albums: [], genres: [], playlists: [],
    };

    if (link) {
        try {
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

            musicResult = {
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
            log.warn("search.globalSearch (music) failed", undefined, err);
        }
    }

    try {
        const [movieRows, showRows, dawRows, editorRows, liveRows] = await Promise.all(localPromises);

        const projects: SearchResult["projects"] = [
            ...dawRows.map((p) => ({ id: p.id, name: p.name, kind: "daw" as const, href: `/daw?project=${p.id}`, updatedAt: p.updatedAt })),
            ...editorRows.map((p) => ({ id: p.id, name: p.name, kind: "editor" as const, href: `/editor?project=${p.id}`, updatedAt: p.updatedAt })),
            ...liveRows.map((p) => ({ id: p.id, name: p.name, kind: "live" as const, href: `/live?session=${p.id}`, updatedAt: p.updatedAt })),
        ]
            .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
            .slice(0, 6);

        return {
            ...musicResult,
            movies: movieRows.map((m) => ({ id: m.id, title: m.title, year: m.year, posterPath: m.posterPath, rating: m.rating })),
            shows: showRows.map((s) => ({ id: s.id, title: s.title, firstAirYear: s.firstAirYear, posterPath: s.posterPath, rating: s.rating })),
            projects,
        };
    } catch (err) {
        log.warn("search.globalSearch (local) failed", undefined, err);
        return { ...musicResult, movies: [], shows: [], projects: [] };
    }
}
