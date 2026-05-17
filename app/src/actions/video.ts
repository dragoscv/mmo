"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvShows, tvEpisodes, videoFiles, companionDevices, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { scanCompanionVideos, type CompanionVideoFile } from "@/lib/companion-video";
import { tmdbSearch, tmdbMovie, tmdbTv, tmdbMovieCredits, tmdbTvCredits, tmdbMovieVideos, tmdbTvVideos, pickTrailer } from "@/lib/tmdb";
import { revalidatePath } from "next/cache";

interface ImportResult {
    moviesAdded: number;
    moviesUpdated: number;
    showsAdded: number;
    showsUpdated: number;
    filesIndexed: number;
    rootsScanned: number;
    skipped: number;
}

/** Scan the companion, match each file against TMDB, write to DB. */
export async function importLocalVideoLibrary(roots?: string[]): Promise<ImportResult | { error: string }> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" };

    const scan = await scanCompanionVideos(roots);
    if (!scan) return { error: "no companion reachable" };

    const result: ImportResult = {
        moviesAdded: 0, moviesUpdated: 0, showsAdded: 0, showsUpdated: 0,
        filesIndexed: 0, rootsScanned: scan.rootsScanned, skipped: 0,
    };

    // Make sure user has a default companion device row (best-effort, we
    // don't have machineId here without an extra round-trip — leave null).
    let deviceId: number | null = null;
    const devRows = await db.select().from(companionDevices).where(eq(companionDevices.userId, userId)).limit(1);
    if (devRows[0]) deviceId = devRows[0].id;

    for (const f of scan.files) {
        if (f.parsed.season !== null && f.parsed.episode !== null) {
            const r = await upsertTvFile(userId, deviceId, f);
            if (r === "added") result.showsAdded++;
            else if (r === "updated") result.showsUpdated++;
            else if (r === "skipped") result.skipped++;
        } else {
            const r = await upsertMovieFile(userId, deviceId, f);
            if (r === "added") result.moviesAdded++;
            else if (r === "updated") result.moviesUpdated++;
            else if (r === "skipped") result.skipped++;
        }
        result.filesIndexed++;
    }
    revalidatePath("/watch");
    revalidatePath("/watch/movies");
    revalidatePath("/watch/shows");
    return result;
}

async function upsertMovieFile(userId: string, deviceId: number | null, f: CompanionVideoFile): Promise<"added" | "updated" | "skipped"> {
    // Match against TMDB
    const hits = await tmdbSearch(f.parsed.title, "movie");
    const best = pickBestMovie(hits, f.parsed.year);
    if (!best || !best.id) return "skipped";
    const tmdb = await tmdbMovie(best.id);
    if (!tmdb) return "skipped";
    const credits = await tmdbMovieCredits(best.id);
    const videos = await tmdbMovieVideos(best.id);
    const trailer = pickTrailer(videos);

    const existing = await db.select().from(movies).where(and(eq(movies.userId, userId), eq(movies.tmdbId, tmdb.id))).limit(1);
    let movieId: number;
    let resultStatus: "added" | "updated";
    if (existing[0]) {
        movieId = existing[0].id;
        await db.update(movies).set({
            title: tmdb.title,
            overview: tmdb.overview,
            tagline: tmdb.tagline ?? null,
            year: tmdb.release_date ? parseInt(tmdb.release_date.slice(0, 4), 10) : null,
            runtimeMinutes: tmdb.runtime,
            posterPath: tmdb.poster_path,
            backdropPath: tmdb.backdrop_path,
            trailerYoutubeId: trailer?.key ?? null,
            genres: tmdb.genres,
            cast: (credits?.cast ?? []).slice(0, 20),
            crew: (credits?.crew ?? []).filter((c) => ["Director", "Writer", "Producer"].includes(c.job)).slice(0, 10),
            rating: tmdb.vote_average,
            ratingCount: tmdb.vote_count,
            updatedAt: new Date(),
        }).where(eq(movies.id, movieId));
        resultStatus = "updated";
    } else {
        const inserted = await db.insert(movies).values({
            userId,
            tmdbId: tmdb.id,
            imdbId: tmdb.imdb_id ?? null,
            title: tmdb.title,
            originalTitle: tmdb.original_title,
            year: tmdb.release_date ? parseInt(tmdb.release_date.slice(0, 4), 10) : null,
            overview: tmdb.overview,
            tagline: tmdb.tagline ?? null,
            runtimeMinutes: tmdb.runtime,
            posterPath: tmdb.poster_path,
            backdropPath: tmdb.backdrop_path,
            trailerYoutubeId: trailer?.key ?? null,
            genres: tmdb.genres,
            cast: (credits?.cast ?? []).slice(0, 20),
            crew: (credits?.crew ?? []).filter((c) => ["Director", "Writer", "Producer"].includes(c.job)).slice(0, 10),
            rating: tmdb.vote_average,
            ratingCount: tmdb.vote_count,
        }).returning({ id: movies.id });
        movieId = inserted[0].id;
        resultStatus = "added";
    }

    // Upsert the file
    await upsertVideoFile(userId, deviceId, f, { kind: "movie", movieId });
    return resultStatus;
}

async function upsertTvFile(userId: string, deviceId: number | null, f: CompanionVideoFile): Promise<"added" | "updated" | "skipped"> {
    if (f.parsed.season === null || f.parsed.episode === null) return "skipped";
    const hits = await tmdbSearch(f.parsed.title, "tv");
    const best = hits[0];
    if (!best || !best.id) return "skipped";
    const tmdb = await tmdbTv(best.id);
    if (!tmdb) return "skipped";
    const credits = await tmdbTvCredits(best.id);
    const videos = await tmdbTvVideos(best.id);
    const trailer = pickTrailer(videos);

    const existing = await db.select().from(tvShows).where(and(eq(tvShows.userId, userId), eq(tvShows.tmdbId, tmdb.id))).limit(1);
    let showId: number;
    let resultStatus: "added" | "updated";
    if (existing[0]) {
        showId = existing[0].id;
        await db.update(tvShows).set({
            title: tmdb.name,
            overview: tmdb.overview,
            posterPath: tmdb.poster_path,
            backdropPath: tmdb.backdrop_path,
            trailerYoutubeId: trailer?.key ?? null,
            genres: tmdb.genres,
            cast: (credits?.cast ?? []).slice(0, 20),
            rating: tmdb.vote_average,
            ratingCount: tmdb.vote_count,
            status: tmdb.status,
            updatedAt: new Date(),
        }).where(eq(tvShows.id, showId));
        resultStatus = "updated";
    } else {
        const inserted = await db.insert(tvShows).values({
            userId,
            tmdbId: tmdb.id,
            title: tmdb.name,
            originalTitle: tmdb.original_name,
            firstAirYear: tmdb.first_air_date ? parseInt(tmdb.first_air_date.slice(0, 4), 10) : null,
            overview: tmdb.overview,
            posterPath: tmdb.poster_path,
            backdropPath: tmdb.backdrop_path,
            trailerYoutubeId: trailer?.key ?? null,
            genres: tmdb.genres,
            cast: (credits?.cast ?? []).slice(0, 20),
            rating: tmdb.vote_average,
            ratingCount: tmdb.vote_count,
            status: tmdb.status,
        }).returning({ id: tvShows.id });
        showId = inserted[0].id;
        resultStatus = "added";
    }

    // Upsert the episode row (minimal — full season-scrape can come later)
    const epExisting = await db.select().from(tvEpisodes)
        .where(and(eq(tvEpisodes.showId, showId), eq(tvEpisodes.seasonNumber, f.parsed.season), eq(tvEpisodes.episodeNumber, f.parsed.episode)))
        .limit(1);
    let episodeId: number;
    if (epExisting[0]) {
        episodeId = epExisting[0].id;
    } else {
        const inserted = await db.insert(tvEpisodes).values({
            showId,
            seasonNumber: f.parsed.season,
            episodeNumber: f.parsed.episode,
            runtimeMinutes: f.durationSec ? Math.round(f.durationSec / 60) : null,
        }).returning({ id: tvEpisodes.id });
        episodeId = inserted[0].id;
    }

    await upsertVideoFile(userId, deviceId, f, { kind: "episode", episodeId });
    return resultStatus;
}

async function upsertVideoFile(
    userId: string,
    deviceId: number | null,
    f: CompanionVideoFile,
    rel: { kind: "movie"; movieId: number } | { kind: "episode"; episodeId: number },
) {
    // Match on (deviceId, path) — when no deviceId yet, fall back to (userId, path).
    const where = deviceId
        ? and(eq(videoFiles.deviceId, deviceId), eq(videoFiles.path, f.path))
        : and(eq(videoFiles.userId, userId), eq(videoFiles.path, f.path));
    const existing = await db.select().from(videoFiles).where(where).limit(1);
    const base = {
        sizeBytes: f.sizeBytes,
        container: f.container,
        videoCodec: f.videoCodec,
        audioCodec: f.audioCodec,
        width: f.width,
        height: f.height,
        durationSec: f.durationSec,
        bitrateKbps: f.bitrateKbps,
        hdr: f.hdr,
        audioTracks: f.audioTracks,
        subtitleTracks: f.subtitleTracks,
        scannedAt: new Date(),
    };
    if (existing[0]) {
        await db.update(videoFiles).set(base).where(eq(videoFiles.id, existing[0].id));
    } else {
        await db.insert(videoFiles).values({
            userId,
            deviceId,
            kind: rel.kind,
            movieId: rel.kind === "movie" ? rel.movieId : null,
            episodeId: rel.kind === "episode" ? rel.episodeId : null,
            path: f.path,
            ...base,
        });
    }
}

function pickBestMovie(hits: Awaited<ReturnType<typeof tmdbSearch>>, year: number | null) {
    if (hits.length === 0) return null;
    if (year !== null) {
        const exact = hits.find((h) => h.release_date?.startsWith(String(year)));
        if (exact) return exact;
    }
    return hits[0];
}

// ─── Profile management ────────────────────────────────────────────────────

export async function ensureDefaultProfile(): Promise<number | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const existing = await db.select().from(watchProfiles).where(eq(watchProfiles.userId, userId)).limit(1);
    if (existing[0]) return existing[0].id;
    const inserted = await db.insert(watchProfiles).values({
        userId,
        name: session.user?.name ?? "Eu",
        color: "#7c3aed",
        sortOrder: 0,
    }).returning({ id: watchProfiles.id });
    return inserted[0]?.id ?? null;
}

export async function createProfile(input: { name: string; color?: string; avatar?: string; isKid?: boolean }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;
    const inserted = await db.insert(watchProfiles).values({
        userId, name: input.name, color: input.color ?? "#7c3aed",
        avatar: input.avatar ?? null, isKid: !!input.isKid,
    }).returning({ id: watchProfiles.id });
    revalidatePath("/watch");
    return { id: inserted[0]?.id ?? null } as const;
}
