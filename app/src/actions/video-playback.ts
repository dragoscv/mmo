"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { movies, tvEpisodes, tvShows, watchHistory, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCompanionLink } from "@/lib/companion-library";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";
import { scrobbleToTrakt } from "@/actions/trakt";

/** Save playback progress. Auto-creates a default profile if none exists. */
export async function saveProgress(input: {
    movieId?: number;
    episodeId?: number;
    fileId?: number;
    positionSec: number;
    durationSec: number;
    completed?: boolean;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;

    let activeId = await getActiveProfileId();
    if (!activeId) activeId = await ensureDefaultWatchProfile();
    if (!activeId) return { error: "no profile" } as const;
    const prof = await db.select().from(watchProfiles).where(eq(watchProfiles.id, activeId)).limit(1).then(r => r[0]);
    if (!prof) return { error: "no profile" } as const;

    const where = input.movieId
        ? and(eq(watchHistory.profileId, prof.id), eq(watchHistory.movieId, input.movieId))
        : input.episodeId
            ? and(eq(watchHistory.profileId, prof.id), eq(watchHistory.episodeId, input.episodeId))
            : null;
    if (!where) return { error: "no target" } as const;

    const existing = await db.select().from(watchHistory).where(where).limit(1);
    const completed = input.completed ?? (input.durationSec > 0 && input.positionSec / input.durationSec > 0.9);
    if (existing[0]) {
        await db.update(watchHistory).set({
            positionSec: Math.floor(input.positionSec),
            durationSec: Math.floor(input.durationSec),
            progress: input.durationSec > 0 ? input.positionSec / input.durationSec : 0,
            completed,
            watchedAt: new Date(),
        }).where(eq(watchHistory.id, existing[0].id));
    } else {
        await db.insert(watchHistory).values({
            profileId: prof.id,
            kind: input.movieId ? "movie" : "episode",
            movieId: input.movieId ?? null,
            episodeId: input.episodeId ?? null,
            positionSec: Math.floor(input.positionSec),
            durationSec: Math.floor(input.durationSec),
            progress: input.durationSec > 0 ? input.positionSec / input.durationSec : 0,
            completed,
        });
    }

    // Fire-and-forget Trakt scrobble. Failures are silent.
    try {
        const progressPct = input.durationSec > 0 ? Math.min(100, (input.positionSec / input.durationSec) * 100) : 0;
        const action: "start" | "pause" | "stop" = completed || input.completed ? "stop" : "start";
        if (input.movieId) {
            const m = await db.select({ tmdbId: movies.tmdbId, title: movies.title, year: movies.year })
                .from(movies).where(eq(movies.id, input.movieId)).limit(1).then(r => r[0]);
            if (m?.tmdbId) {
                await scrobbleToTrakt({
                    action, progress: progressPct,
                    movie: { tmdbId: m.tmdbId, title: m.title, year: m.year ?? undefined },
                });
            }
        } else if (input.episodeId) {
            const ep = await db.select({
                seasonNumber: tvEpisodes.seasonNumber,
                episodeNumber: tvEpisodes.episodeNumber,
                showTmdbId: tvShows.tmdbId,
            }).from(tvEpisodes)
                .innerJoin(tvShows, eq(tvShows.id, tvEpisodes.showId))
                .where(eq(tvEpisodes.id, input.episodeId)).limit(1).then(r => r[0]);
            if (ep?.showTmdbId) {
                await scrobbleToTrakt({
                    action, progress: progressPct,
                    episode: { showTmdbId: ep.showTmdbId, season: ep.seasonNumber, episode: ep.episodeNumber },
                });
            }
        }
    } catch { /* ignore scrobble failures */ }

    return { ok: true } as const;
}

/** One-shot: mark an episode or movie as fully watched without touching
 *  position/duration if a row already exists. Used by "mark as watched"
 *  buttons in episode lists. */
export async function markWatched(input: { movieId?: number; episodeId?: number }) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;

    let activeId = await getActiveProfileId();
    if (!activeId) activeId = await ensureDefaultWatchProfile();
    if (!activeId) return { error: "no profile" } as const;

    const where = input.movieId
        ? and(eq(watchHistory.profileId, activeId), eq(watchHistory.movieId, input.movieId))
        : input.episodeId
            ? and(eq(watchHistory.profileId, activeId), eq(watchHistory.episodeId, input.episodeId))
            : null;
    if (!where) return { error: "no target" } as const;

    const existing = await db.select().from(watchHistory).where(where).limit(1);
    if (existing[0]) {
        await db.update(watchHistory).set({
            completed: true,
            progress: 1,
            watchedAt: new Date(),
        }).where(eq(watchHistory.id, existing[0].id));
    } else {
        await db.insert(watchHistory).values({
            profileId: activeId,
            kind: input.movieId ? "movie" : "episode",
            movieId: input.movieId ?? null,
            episodeId: input.episodeId ?? null,
            positionSec: 0,
            durationSec: 0,
            progress: 1,
            completed: true,
        });
    }
    return { ok: true } as const;
}
export async function pushDiscordPresence(state: {
    title: string;
    subtitle?: string;
    posterUrl?: string;
    progressSec: number;
    durationSec: number;
    paused: boolean;
}) {
    const link = await getCompanionLink();
    if (!link) return { error: "no companion" } as const;
    try {
        const res = await fetch(`${link.apiUrl}/video/discord/presence`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Device-Token": link.token,
                "X-User-Id": link.userId,
            },
            body: JSON.stringify({ ...state, type: "watching" }),
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return { error: `companion ${res.status}` } as const;
        return { ok: true } as const;
    } catch {
        return { error: "unreachable" } as const;
    }
}
