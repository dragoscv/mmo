"use server";

import { db } from "@/db";
import { watchProfiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getActiveProfileId } from "@/lib/active-profile";

/** Stored cinema settings for the active profile. Returns null when there
 *  is no active profile or nothing has been saved yet. */
export async function getCinemaSettingsForProfile(): Promise<Record<string, unknown> | null> {
    const id = await getActiveProfileId();
    if (!id) return null;
    const row = await db.select({ prefs: watchProfiles.prefs })
        .from(watchProfiles).where(eq(watchProfiles.id, id)).limit(1).then((r) => r[0]);
    const prefs = row?.prefs as { cinema?: Record<string, unknown> } | undefined;
    return prefs?.cinema ?? null;
}

/** Persist cinema settings on the active profile. Last-write-wins. */
export async function saveCinemaSettingsForProfile(cinema: Record<string, unknown>) {
    const id = await getActiveProfileId();
    if (!id) return { error: "no profile" } as const;
    const row = await db.select({ prefs: watchProfiles.prefs })
        .from(watchProfiles).where(eq(watchProfiles.id, id)).limit(1).then((r) => r[0]);
    const merged = { ...(row?.prefs as Record<string, unknown> | undefined ?? {}), cinema };
    await db.update(watchProfiles).set({ prefs: merged }).where(eq(watchProfiles.id, id));
    return { ok: true } as const;
}
