"use server";

/**
 * Typed read/write over `watch_profiles.prefs` (jsonb) for the user's
 * currently-active profile. One JSON blob keeps the schema migration-free
 * while letting us evolve the shape with code-only changes.
 *
 * Defaults live here so unset values still render sensibly in settings UI.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { watchProfiles } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";
import { revalidatePath } from "next/cache";
import { DEFAULT_PREFS, mergeWatchPrefs, type WatchPrefs } from "@/lib/watch-prefs";

async function getActiveOwnedProfileId(): Promise<{ userId: string; profileId: number } | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const profileId = await getActiveProfileId();
    if (!profileId) return null;
    return { userId, profileId };
}

export async function getWatchPrefs(): Promise<WatchPrefs> {
    const ctx = await getActiveOwnedProfileId();
    if (!ctx) return DEFAULT_PREFS;
    const row = await db.select({ prefs: watchProfiles.prefs }).from(watchProfiles)
        .where(and(eq(watchProfiles.userId, ctx.userId), eq(watchProfiles.id, ctx.profileId)))
        .limit(1);
    return mergeWatchPrefs(row[0]?.prefs);
}

export async function saveWatchPrefs(next: Partial<WatchPrefs>): Promise<{ ok: boolean; prefs: WatchPrefs }> {
    const ctx = await getActiveOwnedProfileId();
    if (!ctx) return { ok: false, prefs: DEFAULT_PREFS };
    const current = await getWatchPrefs();
    const merged: WatchPrefs = {
        ...current,
        ...next,
        subtitleStyle: { ...current.subtitleStyle, ...(next.subtitleStyle ?? {}) },
    };
    // Sanitize default region — must be in regions
    if (!merged.regions.includes(merged.defaultRegion)) merged.defaultRegion = merged.regions[0];
    await db.update(watchProfiles).set({ prefs: merged })
        .where(and(eq(watchProfiles.userId, ctx.userId), eq(watchProfiles.id, ctx.profileId)));
    revalidatePath("/watch");
    revalidatePath("/watch/settings");
    revalidatePath("/settings/video");
    return { ok: true, prefs: merged };
}

export async function toggleHidden(kind: "movie" | "tv", tmdbId: number): Promise<{ ok: boolean; hidden: boolean }> {
    const current = await getWatchPrefs();
    const key = kind === "movie" ? "hiddenMovieTmdbIds" : "hiddenShowTmdbIds";
    const list = current[key];
    const isHidden = list.includes(tmdbId);
    const next = isHidden ? list.filter((x) => x !== tmdbId) : [...list, tmdbId];
    await saveWatchPrefs({ [key]: next } as Partial<WatchPrefs>);
    return { ok: true, hidden: !isHidden };
}
