"use server";

import { db } from "@/db";
import { videoBookmarks } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";

export interface BookmarkInput {
    movieId?: number;
    episodeId?: number;
    fileId?: number;
    timeSec: number;
    label?: string;
}

export async function addBookmark(input: BookmarkInput) {
    const profileId = await getActiveProfileId();
    if (!profileId) return { error: "no profile" } as const;
    if (input.movieId == null && input.episodeId == null) return { error: "no target" } as const;
    const [row] = await db.insert(videoBookmarks).values({
        profileId,
        kind: input.movieId != null ? "movie" : "episode",
        movieId: input.movieId ?? null,
        episodeId: input.episodeId ?? null,
        fileId: input.fileId ?? null,
        timeSec: input.timeSec,
        label: input.label ?? null,
    }).returning();
    return { ok: true as const, bookmark: row };
}

export async function listBookmarks(target: { movieId?: number; episodeId?: number }) {
    const profileId = await getActiveProfileId();
    if (!profileId) return [];
    const where = target.movieId != null
        ? and(eq(videoBookmarks.profileId, profileId), eq(videoBookmarks.movieId, target.movieId))
        : target.episodeId != null
            ? and(eq(videoBookmarks.profileId, profileId), eq(videoBookmarks.episodeId, target.episodeId))
            : null;
    if (!where) return [];
    return db.select().from(videoBookmarks).where(where).orderBy(desc(videoBookmarks.createdAt));
}

export async function deleteBookmark(id: number) {
    const profileId = await getActiveProfileId();
    if (!profileId) return { error: "no profile" } as const;
    await db.delete(videoBookmarks).where(and(eq(videoBookmarks.id, id), eq(videoBookmarks.profileId, profileId)));
    return { ok: true as const };
}
