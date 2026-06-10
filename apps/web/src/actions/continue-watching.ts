"use server";

import { db } from "@/db";
import { watchHistory, movies, tvEpisodes, tvShows } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";

export type ContinueItem = {
    kind: "movie" | "episode";
    id: number;
    title: string;
    subtitle?: string;
    posterPath: string | null;
    href: string;
    progress: number; // 0..1
    positionSec: number;
    durationSec: number | null;
    watchedAt: Date | null;
};

/**
 * Resume list for the active profile: movies + last-watched episode per show,
 * excluding completed ones, newest first.
 */
export async function getContinueWatching(limit = 20): Promise<ContinueItem[]> {
    const profileId = await getActiveProfileId();
    if (!profileId) return [];

    const rows = await db
        .select({
            h: watchHistory,
            m: movies,
            e: tvEpisodes,
            s: tvShows,
        })
        .from(watchHistory)
        .leftJoin(movies, eq(movies.id, watchHistory.movieId))
        .leftJoin(tvEpisodes, eq(tvEpisodes.id, watchHistory.episodeId))
        .leftJoin(tvShows, eq(tvShows.id, tvEpisodes.showId))
        .where(and(eq(watchHistory.profileId, profileId), eq(watchHistory.completed, false)))
        .orderBy(desc(watchHistory.watchedAt))
        .limit(limit);

    const out: ContinueItem[] = [];
    for (const { h, m, e, s } of rows) {
        const dur = h.durationSec ?? null;
        const prog = dur && dur > 0 ? h.positionSec / dur : (h.progress ?? 0);
        if (h.kind === "movie" && m) {
            out.push({
                kind: "movie", id: m.id, title: m.title,
                subtitle: m.year ? String(m.year) : undefined,
                posterPath: m.posterPath, href: `/watch/movies/${m.id}`,
                progress: prog, positionSec: h.positionSec, durationSec: dur,
                watchedAt: h.watchedAt,
            });
        } else if (h.kind === "episode" && e && s) {
            out.push({
                kind: "episode", id: e.id, title: s.title,
                subtitle: `S${String(e.seasonNumber).padStart(2, "0")}E${String(e.episodeNumber).padStart(2, "0")} · ${e.title ?? ""}`.trim(),
                posterPath: s.posterPath, href: `/watch/shows/${s.id}`,
                progress: prog, positionSec: h.positionSec, durationSec: dur,
                watchedAt: h.watchedAt,
            });
        }
    }
    return out;
}
