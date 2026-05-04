"use server";

/**
 * App-level settings (non-music). Stored as per-user preferences in the
 * web app DB so each signed-in user gets their own keys (e.g. rekordbox
 * library path on disk, scan defaults, etc.). Returns empty for
 * unauthenticated users.
 *
 * Music-library configuration (folders, drives, library DB) lives on
 * the companion, not here.
 */

import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

const SETTINGS_NS = "setting:";

export async function getSettings(): Promise<Record<string, string>> {
    const session = await auth();
    if (!session?.user?.id) return {};
    const rows = db.select({ key: userPreferences.key, value: userPreferences.value })
        .from(userPreferences)
        .where(eq(userPreferences.userId, session.user.id))
        .all();
    const out: Record<string, string> = {};
    for (const row of rows) {
        if (row.key.startsWith(SETTINGS_NS)) {
            out[row.key.slice(SETTINGS_NS.length)] = row.value;
        }
    }
    return out;
}

export async function getSetting(key: string): Promise<string | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const row = db.select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(
            eq(userPreferences.userId, session.user.id),
            eq(userPreferences.key, SETTINGS_NS + key),
        ))
        .get();
    return row?.value ?? null;
}

export async function updateSetting(
    key: string,
    value: string,
): Promise<{ success: boolean; error?: string }> {
    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in" };
    const ns = SETTINGS_NS + key;
    const existing = db.select({ id: userPreferences.id }).from(userPreferences)
        .where(and(
            eq(userPreferences.userId, session.user.id),
            eq(userPreferences.key, ns),
        ))
        .get();
    if (existing) {
        db.update(userPreferences).set({ value, updatedAt: new Date().toISOString() })
            .where(eq(userPreferences.id, existing.id))
            .run();
    } else {
        db.insert(userPreferences).values({
            userId: session.user.id, key: ns, value,
        }).run();
    }
    revalidatePath("/settings");
    return { success: true };
}
