"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { watchHistory, watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getCompanionLink } from "@/lib/companion-library";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";

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
    return { ok: true } as const;
}

/** Push Discord rich-presence via the local companion. */
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
