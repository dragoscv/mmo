"use server";

/** Tiny KV-style server actions over user_preferences for AI settings.
 *  Values are JSON-encoded strings. Keys are namespaced `ai.<tab>.<field>`.
 *  Constants/types live in lib/ai-prefs-types.ts because "use server" files
 *  can only export async functions. */

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { AI_PREFS_DEFAULTS, AI_PREF_KEYS, type AiPrefs } from "@/lib/ai-prefs-types";

async function uid(): Promise<string> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("Not signed in");
    return s.user.id;
}

export async function getAiPrefs(): Promise<AiPrefs> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), inArray(userPreferences.key, AI_PREF_KEYS as string[])));
    const out = { ...AI_PREFS_DEFAULTS };
    for (const r of rows) {
        if (!(r.key in AI_PREFS_DEFAULTS)) continue;
        try {
            // @ts-expect-error — generic key/value
            out[r.key] = JSON.parse(r.value);
        } catch {
            /* ignore corrupt row */
        }
    }
    return out;
}

export async function setAiPref<K extends keyof AiPrefs>(key: K, value: AiPrefs[K]): Promise<{ ok: true }> {
    const userId = await uid();
    const payload = JSON.stringify(value);
    const existing = await db
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
        .limit(1);
    if (existing[0]) {
        await db
            .update(userPreferences)
            .set({ value: payload, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing[0].id));
    } else {
        await db.insert(userPreferences).values({ userId, key, value: payload });
    }
    revalidatePath("/settings/copilot");
    return { ok: true };
}
