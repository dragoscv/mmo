/**
 * Active watch profile resolver.
 *
 * Precedence (highest wins):
 *   1. `mmo-active-profile` cookie (per-browser override, set when the
 *      user picks a profile from the picker)
 *   2. `user_preferences.watch.activeProfileId` for the signed-in user
 *      (cross-device fallback)
 *   3. The user's first profile (or null when none exist yet)
 *
 * `setActiveProfile()` always writes both — cookie for fast reads + DB
 * column for cross-device continuity.
 */

import "server-only";
import { cookies } from "next/headers";
import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences, watchProfiles } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";

const COOKIE_NAME = "mmo-active-profile";
const PREF_KEY = "watch.activeProfileId";
// One year — cookie is just a hint, the DB pref is the source of truth.
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Returns the active profile id for the signed-in user, or null. */
export async function getActiveProfileId(): Promise<number | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;

    const jar = await cookies();
    const cookieVal = jar.get(COOKIE_NAME)?.value;
    if (cookieVal) {
        const id = Number(cookieVal);
        if (Number.isFinite(id)) {
            // Validate it actually belongs to this user — otherwise it's
            // a stale cookie from a different account on this browser.
            const ok = await db.select({ id: watchProfiles.id }).from(watchProfiles)
                .where(and(eq(watchProfiles.id, id), eq(watchProfiles.userId, userId)))
                .limit(1);
            if (ok[0]) return id;
        }
    }

    // Pref lookup
    const pref = await db.select().from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY)))
        .limit(1);
    if (pref[0]) {
        const id = Number(pref[0].value);
        if (Number.isFinite(id)) {
            const ok = await db.select({ id: watchProfiles.id }).from(watchProfiles)
                .where(and(eq(watchProfiles.id, id), eq(watchProfiles.userId, userId)))
                .limit(1);
            if (ok[0]) return id;
        }
    }

    // Fall back to the user's first profile.
    const first = await db.select({ id: watchProfiles.id }).from(watchProfiles)
        .where(eq(watchProfiles.userId, userId))
        .orderBy(asc(watchProfiles.sortOrder), asc(watchProfiles.id))
        .limit(1);
    return first[0]?.id ?? null;
}

/** Set the active profile (cookie + DB pref). */
export async function setActiveProfile(profileId: number): Promise<{ ok: boolean }> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false };

    // Validate ownership
    const owns = await db.select({ id: watchProfiles.id }).from(watchProfiles)
        .where(and(eq(watchProfiles.id, profileId), eq(watchProfiles.userId, userId)))
        .limit(1);
    if (!owns[0]) return { ok: false };

    // Cookie
    const jar = await cookies();
    jar.set({
        name: COOKIE_NAME,
        value: String(profileId),
        httpOnly: false, // intentionally readable by client for UI sync
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: COOKIE_MAX_AGE,
        path: "/",
    });

    // DB pref upsert
    const existing = await db.select().from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY)))
        .limit(1);
    if (existing[0]) {
        await db.update(userPreferences)
            .set({ value: String(profileId), updatedAt: new Date() })
            .where(eq(userPreferences.id, existing[0].id));
    } else {
        await db.insert(userPreferences).values({ userId, key: PREF_KEY, value: String(profileId) });
    }
    return { ok: true };
}

/** Ensure the user has at least one profile; create a default one if not. */
export async function ensureDefaultWatchProfile(): Promise<number | null> {
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
