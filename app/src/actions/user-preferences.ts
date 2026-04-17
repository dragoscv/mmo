"use server";

import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { auth } from "@/auth";
import { SYNCABLE_KEYS } from "@/lib/syncable-keys";

// ─── Get all preferences for authenticated user ─────────────────────────────

export async function getUserPreferences(): Promise<Record<string, string>> {
    const session = await auth();
    if (!session?.user?.id) return {};

    const rows = await db
        .select({ key: userPreferences.key, value: userPreferences.value })
        .from(userPreferences)
        .where(eq(userPreferences.userId, session.user.id));

    const result: Record<string, string> = {};
    for (const row of rows) {
        result[row.key] = row.value;
    }
    return result;
}

// ─── Save a single preference ───────────────────────────────────────────────

export async function saveUserPreference(key: string, value: string): Promise<{ success: boolean }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false };

    const existing = await db
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, key)))
        .limit(1);

    if (existing.length > 0) {
        await db
            .update(userPreferences)
            .set({ value, updatedAt: new Date().toISOString() })
            .where(eq(userPreferences.id, existing[0].id));
    } else {
        await db.insert(userPreferences).values({
            userId: session.user.id,
            key,
            value,
        });
    }

    return { success: true };
}

// ─── Save multiple preferences at once (for initial sync from localStorage) ─

export async function saveUserPreferencesBulk(
    prefs: Array<{ key: string; value: string }>
): Promise<{ success: boolean; saved: number }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false, saved: 0 };

    let saved = 0;
    for (const { key, value } of prefs) {
        const existing = await db
            .select({ id: userPreferences.id })
            .from(userPreferences)
            .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, key)))
            .limit(1);

        if (existing.length > 0) {
            await db
                .update(userPreferences)
                .set({ value, updatedAt: new Date().toISOString() })
                .where(eq(userPreferences.id, existing[0].id));
        } else {
            await db.insert(userPreferences).values({
                userId: session.user.id,
                key,
                value,
            });
        }
        saved++;
    }

    return { success: true, saved };
}

// ─── Delete all preferences (reset to defaults) ────────────────────────────

export async function resetUserPreferences(): Promise<{ success: boolean }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false };

    await db
        .delete(userPreferences)
        .where(eq(userPreferences.userId, session.user.id));

    return { success: true };
}

// ─── Delete user account ────────────────────────────────────────────────────

export async function deleteUserAccount(): Promise<{ success: boolean }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false };

    // Cascade delete will remove accounts, sessions, and preferences
    const { users } = await import("@/db/schema");
    await db.delete(users).where(eq(users.id, session.user.id));

    return { success: true };
}
