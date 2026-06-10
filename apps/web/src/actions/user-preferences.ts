"use server";

/**
 * LEGACY FACADE — preserved so older callers keep working.
 * All preference reads/writes are now scoped to the user's *active profile*.
 * New code should use `@/actions/profiles` directly.
 */

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import {
    getActiveProfilePreferences,
    saveActiveProfilePreference,
    saveActiveProfilePreferencesBulk,
    resetActiveProfile,
} from "@/actions/profiles";

export async function getUserPreferences(): Promise<Record<string, string>> {
    return getActiveProfilePreferences();
}

export async function saveUserPreference(
    key: string,
    value: string,
): Promise<{ success: boolean }> {
    return saveActiveProfilePreference(key, value);
}

export async function saveUserPreferencesBulk(
    prefs: Array<{ key: string; value: string }>,
): Promise<{ success: boolean; saved: number }> {
    return saveActiveProfilePreferencesBulk(prefs);
}

export async function resetUserPreferences(): Promise<{ success: boolean }> {
    return resetActiveProfile();
}

export async function deleteUserAccount(): Promise<{ success: boolean }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false };
    await db.delete(users).where(eq(users.id, session.user.id));
    return { success: true };
}
