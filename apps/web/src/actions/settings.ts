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
import { z } from "zod";

const SETTINGS_NS = "setting:";

// Settings keys are application-controlled (UI dropdowns, not free-form),
// so we whitelist the character class rather than enumerate every key.
const settingKeySchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
const settingValueSchema = z.string().max(8192);

function failedValidation(err: z.ZodError): { success: false; error: string } {
    return { success: false, error: err.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
}

export async function getSettings(): Promise<Record<string, string>> {
    const session = await auth();
    if (!session?.user?.id) return {};
    const rows = await db.select({ key: userPreferences.key, value: userPreferences.value })
        .from(userPreferences)
        .where(eq(userPreferences.userId, session.user.id));
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
    const rows = await db.select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(
            eq(userPreferences.userId, session.user.id),
            eq(userPreferences.key, SETTINGS_NS + key),
        ))
        .limit(1);
    return rows[0]?.value ?? null;
}

export async function updateSetting(
    key: string,
    value: string,
): Promise<{ success: boolean; error?: string }> {
    const keyCheck = settingKeySchema.safeParse(key);
    if (!keyCheck.success) return failedValidation(keyCheck.error);
    const valCheck = settingValueSchema.safeParse(value);
    if (!valCheck.success) return failedValidation(valCheck.error);

    const session = await auth();
    if (!session?.user?.id) return { success: false, error: "Not signed in" };
    const ns = SETTINGS_NS + key;
    const existingRows = await db.select({ id: userPreferences.id }).from(userPreferences)
        .where(and(
            eq(userPreferences.userId, session.user.id),
            eq(userPreferences.key, ns),
        ))
        .limit(1);
    const existing = existingRows[0];
    if (existing) {
        await db.update(userPreferences).set({ value, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing.id));
    } else {
        await db.insert(userPreferences).values({
            userId: session.user.id, key: ns, value,
        });
    }
    revalidatePath("/settings");
    return { success: true };
}
