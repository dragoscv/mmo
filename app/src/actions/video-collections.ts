"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { videoCollections, videoCollectionItems, watchProfiles } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getActiveProfileId, ensureDefaultWatchProfile } from "@/lib/active-profile";

async function activeProfileOrCreate(): Promise<number | null> {
    let id = await getActiveProfileId();
    if (!id) id = await ensureDefaultWatchProfile();
    return id;
}

/** Ensure the active profile's wishlist exists. Returns its id. */
export async function ensureWishlist(): Promise<number | null> {
    const profileId = await activeProfileOrCreate();
    if (!profileId) return null;
    const existing = await db.select().from(videoCollections)
        .where(and(eq(videoCollections.profileId, profileId), eq(videoCollections.kind, "wishlist")))
        .limit(1);
    if (existing[0]) return existing[0].id;
    const inserted = await db.insert(videoCollections).values({
        profileId, name: "Wishlist", kind: "wishlist", sortOrder: 0,
    }).returning({ id: videoCollections.id });
    return inserted[0]?.id ?? null;
}

export async function toggleWishlist(input: { movieId?: number; tvShowId?: number }) {
    const session = await auth();
    if (!session?.user?.id) return { error: "unauthorized" as const };
    if (!input.movieId && !input.tvShowId) return { error: "missing target" as const };
    const wlId = await ensureWishlist();
    if (!wlId) return { error: "no wishlist" as const };
    const existing = await db.select().from(videoCollectionItems)
        .where(and(
            eq(videoCollectionItems.collectionId, wlId),
            input.movieId ? eq(videoCollectionItems.movieId, input.movieId) : eq(videoCollectionItems.showId, input.tvShowId!),
        )).limit(1);
    if (existing[0]) {
        await db.delete(videoCollectionItems).where(eq(videoCollectionItems.id, existing[0].id));
        revalidatePath("/watch");
        return { added: false as const };
    }
    await db.insert(videoCollectionItems).values({
        collectionId: wlId,
        kind: input.movieId ? "movie" : "tv",
        movieId: input.movieId ?? null,
        showId: input.tvShowId ?? null,
    });
    revalidatePath("/watch");
    return { added: true as const };
}

export async function createCollection(input: { name: string; description?: string }) {
    const profileId = await activeProfileOrCreate();
    if (!profileId) return { error: "unauthorized" as const };
    const inserted = await db.insert(videoCollections).values({
        profileId, name: input.name.trim(), kind: "custom", description: input.description ?? null,
    }).returning();
    revalidatePath("/watch");
    return { collection: inserted[0] };
}

async function ownsCollection(collectionId: number): Promise<boolean> {
    const session = await auth();
    if (!session?.user?.id) return false;
    const row = await db.select({ userId: watchProfiles.userId })
        .from(videoCollections)
        .innerJoin(watchProfiles, eq(watchProfiles.id, videoCollections.profileId))
        .where(eq(videoCollections.id, collectionId))
        .limit(1);
    return row[0]?.userId === session.user.id;
}

export async function addToCollection(input: { collectionId: number; movieId?: number; tvShowId?: number }) {
    if (!input.movieId && !input.tvShowId) return { error: "missing target" as const };
    if (!(await ownsCollection(input.collectionId))) return { error: "forbidden" as const };
    await db.insert(videoCollectionItems).values({
        collectionId: input.collectionId,
        kind: input.movieId ? "movie" : "tv",
        movieId: input.movieId ?? null,
        showId: input.tvShowId ?? null,
    });
    revalidatePath("/watch");
    return { ok: true };
}

export async function removeFromCollection(itemId: number) {
    const session = await auth();
    if (!session?.user?.id) return { error: "unauthorized" as const };
    const row = await db.select({
        id: videoCollectionItems.id,
        userId: watchProfiles.userId,
    })
        .from(videoCollectionItems)
        .innerJoin(videoCollections, eq(videoCollections.id, videoCollectionItems.collectionId))
        .innerJoin(watchProfiles, eq(watchProfiles.id, videoCollections.profileId))
        .where(eq(videoCollectionItems.id, itemId))
        .limit(1);
    if (!row[0] || row[0].userId !== session.user.id) return { error: "forbidden" as const };
    await db.delete(videoCollectionItems).where(eq(videoCollectionItems.id, itemId));
    revalidatePath("/watch");
    return { ok: true };
}

/** List the active profile's collections in display order. */
export async function listCollections() {
    const profileId = await getActiveProfileId();
    if (!profileId) return [];
    return db.select().from(videoCollections)
        .where(eq(videoCollections.profileId, profileId))
        .orderBy(asc(videoCollections.sortOrder), asc(videoCollections.id));
}
