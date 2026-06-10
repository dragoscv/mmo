"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { and, eq } from "drizzle-orm";

const KEY_PREFIX = "show.prefs.";

export interface ShowPrefs {
    audioLang?: string;
    audioIndex?: number;
    subLang?: string;
    eqPreset?: string;
    loudnessNormalization?: boolean;
    skipIntro?: boolean;
    skipRecap?: boolean;
}

export async function getShowPrefs(showId: number): Promise<ShowPrefs | null> {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return null;
    const row = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, KEY_PREFIX + showId)),
    ).limit(1).then(r => r[0]);
    if (!row) return null;
    try { return JSON.parse(row.value) as ShowPrefs; } catch { return null; }
}

export async function setShowPrefs(showId: number, patch: Partial<ShowPrefs>) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { error: "unauthorized" } as const;
    const key = KEY_PREFIX + showId;
    const existing = await db.select().from(userPreferences).where(
        and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)),
    ).limit(1).then(r => r[0]);
    let next: ShowPrefs = {};
    if (existing) {
        try { next = JSON.parse(existing.value) as ShowPrefs; } catch { /* ignore */ }
    }
    next = { ...next, ...patch };
    const value = JSON.stringify(next);
    if (existing) {
        await db.update(userPreferences).set({ value, updatedAt: new Date() }).where(eq(userPreferences.id, existing.id));
    } else {
        await db.insert(userPreferences).values({ userId, key, value });
    }
    return { ok: true } as const;
}
