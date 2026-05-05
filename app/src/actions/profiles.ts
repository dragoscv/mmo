"use server";

import { db } from "@/db";
import { userProfiles, profilePreferences, userPreferences } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProfileSummary = {
    id: string;
    name: string;
    description: string | null;
    isActive: boolean;
    createdAt: Date | null;
    updatedAt: Date | null;
    entryCount: number;
};

export type ProfileExport = {
    schema: "rekordbox-mwrty.profile";
    version: 1;
    name: string;
    description: string | null;
    exportedAt: string;
    entries: Array<{ key: string; value: string }>;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

async function requireUserId(): Promise<string | null> {
    const session = await auth();
    return session?.user?.id ?? null;
}

/**
 * Idempotent: ensures the user has at least one profile and exactly one active.
 * Migrates any rows in legacy `user_preferences` into the default profile on
 * first run. Returns the active profile id.
 */
export async function ensureDefaultProfile(): Promise<string | null> {
    const userId = await requireUserId();
    if (!userId) return null;

    const existing = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId));

    if (existing.length === 0) {
        const id = crypto.randomUUID();
        await db.insert(userProfiles).values({
            id,
            userId,
            name: "Default",
            description: "Auto-created profile",
            isActive: true,
        });

        // Migrate legacy user_preferences rows
        const legacy = await db
            .select({ key: userPreferences.key, value: userPreferences.value })
            .from(userPreferences)
            .where(eq(userPreferences.userId, userId));
        if (legacy.length > 0) {
            await db.insert(profilePreferences).values(
                legacy.map((row) => ({ profileId: id, key: row.key, value: row.value }))
            );
        }
        return id;
    }

    const active = existing.find((p) => p.isActive);
    if (active) return active.id;

    // No active profile — promote the first one.
    await db
        .update(userProfiles)
        .set({ isActive: true })
        .where(eq(userProfiles.id, existing[0].id));
    return existing[0].id;
}

async function getActiveProfileId(userId: string): Promise<string | null> {
    const rows = await db
        .select({ id: userProfiles.id })
        .from(userProfiles)
        .where(and(eq(userProfiles.userId, userId), eq(userProfiles.isActive, true)))
        .limit(1);
    return rows[0]?.id ?? null;
}

async function assertOwnership(userId: string, profileId: string): Promise<boolean> {
    const rows = await db
        .select({ id: userProfiles.id })
        .from(userProfiles)
        .where(and(eq(userProfiles.id, profileId), eq(userProfiles.userId, userId)))
        .limit(1);
    return rows.length > 0;
}

// ─── List / Read ────────────────────────────────────────────────────────────

export async function listProfiles(): Promise<ProfileSummary[]> {
    const userId = await requireUserId();
    if (!userId) return [];
    await ensureDefaultProfile();

    const profiles = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId));

    const counts = await db
        .select({
            profileId: profilePreferences.profileId,
        })
        .from(profilePreferences);
    const countMap = new Map<string, number>();
    for (const row of counts) {
        countMap.set(row.profileId, (countMap.get(row.profileId) ?? 0) + 1);
    }

    return profiles
        .map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            isActive: !!p.isActive,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            entryCount: countMap.get(p.id) ?? 0,
        }))
        .sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return a.name.localeCompare(b.name);
        });
}

export async function getActiveProfilePreferences(): Promise<Record<string, string>> {
    const userId = await requireUserId();
    if (!userId) return {};
    const profileId = (await getActiveProfileId(userId)) ?? (await ensureDefaultProfile());
    if (!profileId) return {};

    const rows = await db
        .select({ key: profilePreferences.key, value: profilePreferences.value })
        .from(profilePreferences)
        .where(eq(profilePreferences.profileId, profileId));

    const out: Record<string, string> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export async function createProfile(
    name: string,
    description?: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    const trimmed = name.trim();
    if (!trimmed) return { success: false, error: "Name required" };

    const id = crypto.randomUUID();
    await db.insert(userProfiles).values({
        id,
        userId,
        name: trimmed,
        description: description?.trim() || null,
        isActive: false,
    });
    return { success: true, id };
}

export async function renameProfile(
    profileId: string,
    name: string,
    description?: string,
): Promise<{ success: boolean; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!(await assertOwnership(userId, profileId))) return { success: false, error: "Not found" };
    const trimmed = name.trim();
    if (!trimmed) return { success: false, error: "Name required" };

    await db
        .update(userProfiles)
        .set({
            name: trimmed,
            description: description?.trim() || null,
            updatedAt: new Date(),
        })
        .where(eq(userProfiles.id, profileId));
    return { success: true };
}

export async function deleteProfile(
    profileId: string,
): Promise<{ success: boolean; error?: string; newActiveId?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!(await assertOwnership(userId, profileId))) return { success: false, error: "Not found" };

    const all = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId));

    if (all.length <= 1) {
        return { success: false, error: "Cannot delete the last remaining profile" };
    }

    const wasActive = all.find((p) => p.id === profileId)?.isActive;
    await db.delete(userProfiles).where(eq(userProfiles.id, profileId));

    let newActiveId: string | undefined;
    if (wasActive) {
        const fallback = all.find((p) => p.id !== profileId);
        if (fallback) {
            await db
                .update(userProfiles)
                .set({ isActive: true })
                .where(eq(userProfiles.id, fallback.id));
            newActiveId = fallback.id;
        }
    }
    return { success: true, newActiveId };
}

export async function activateProfile(
    profileId: string,
): Promise<{ success: boolean; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!(await assertOwnership(userId, profileId))) return { success: false, error: "Not found" };

    await db
        .update(userProfiles)
        .set({ isActive: false })
        .where(eq(userProfiles.userId, userId));
    await db
        .update(userProfiles)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(userProfiles.id, profileId));
    return { success: true };
}

export async function duplicateProfile(
    profileId: string,
    newName: string,
): Promise<{ success: boolean; id?: string; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!(await assertOwnership(userId, profileId))) return { success: false, error: "Not found" };
    const trimmed = newName.trim();
    if (!trimmed) return { success: false, error: "Name required" };

    const source = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.id, profileId))
        .limit(1);
    if (source.length === 0) return { success: false, error: "Not found" };

    const newId = crypto.randomUUID();
    await db.insert(userProfiles).values({
        id: newId,
        userId,
        name: trimmed,
        description: source[0].description,
        isActive: false,
    });

    const entries = await db
        .select({ key: profilePreferences.key, value: profilePreferences.value })
        .from(profilePreferences)
        .where(eq(profilePreferences.profileId, profileId));
    if (entries.length > 0) {
        await db.insert(profilePreferences).values(
            entries.map((e) => ({ profileId: newId, key: e.key, value: e.value }))
        );
    }
    return { success: true, id: newId };
}

export async function resetActiveProfile(): Promise<{ success: boolean }> {
    const userId = await requireUserId();
    if (!userId) return { success: false };
    const profileId = await getActiveProfileId(userId);
    if (!profileId) return { success: false };

    await db.delete(profilePreferences).where(eq(profilePreferences.profileId, profileId));
    return { success: true };
}

// ─── Preference write paths (active-profile aware) ─────────────────────────

export async function saveActiveProfilePreference(
    key: string,
    value: string,
): Promise<{ success: boolean }> {
    const userId = await requireUserId();
    if (!userId) return { success: false };
    const profileId = (await getActiveProfileId(userId)) ?? (await ensureDefaultProfile());
    if (!profileId) return { success: false };

    const existing = await db
        .select({ id: profilePreferences.id })
        .from(profilePreferences)
        .where(and(eq(profilePreferences.profileId, profileId), eq(profilePreferences.key, key)))
        .limit(1);

    if (existing.length > 0) {
        await db
            .update(profilePreferences)
            .set({ value, updatedAt: new Date() })
            .where(eq(profilePreferences.id, existing[0].id));
    } else {
        await db.insert(profilePreferences).values({ profileId, key, value });
    }
    return { success: true };
}

export async function saveActiveProfilePreferencesBulk(
    prefs: Array<{ key: string; value: string }>,
): Promise<{ success: boolean; saved: number }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, saved: 0 };
    const profileId = (await getActiveProfileId(userId)) ?? (await ensureDefaultProfile());
    if (!profileId) return { success: false, saved: 0 };
    if (prefs.length === 0) return { success: true, saved: 0 };

    let saved = 0;
    for (const { key, value } of prefs) {
        const existing = await db
            .select({ id: profilePreferences.id })
            .from(profilePreferences)
            .where(and(eq(profilePreferences.profileId, profileId), eq(profilePreferences.key, key)))
            .limit(1);

        if (existing.length > 0) {
            await db
                .update(profilePreferences)
                .set({ value, updatedAt: new Date() })
                .where(eq(profilePreferences.id, existing[0].id));
        } else {
            await db.insert(profilePreferences).values({ profileId, key, value });
        }
        saved++;
    }
    return { success: true, saved };
}

// ─── Import / Export ───────────────────────────────────────────────────────

export async function exportProfile(
    profileId: string,
): Promise<{ success: boolean; data?: ProfileExport; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!(await assertOwnership(userId, profileId))) return { success: false, error: "Not found" };

    const meta = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.id, profileId))
        .limit(1);
    if (meta.length === 0) return { success: false, error: "Not found" };

    const entries = await db
        .select({ key: profilePreferences.key, value: profilePreferences.value })
        .from(profilePreferences)
        .where(eq(profilePreferences.profileId, profileId));

    return {
        success: true,
        data: {
            schema: "rekordbox-mwrty.profile",
            version: 1,
            name: meta[0].name,
            description: meta[0].description,
            exportedAt: new Date().toISOString(),
            entries,
        },
    };
}

export async function importProfile(
    payload: unknown,
    options?: { name?: string; activate?: boolean },
): Promise<{ success: boolean; id?: string; error?: string }> {
    const userId = await requireUserId();
    if (!userId) return { success: false, error: "Not authenticated" };

    // Validate payload shape (server-side validation, do not trust client).
    if (!payload || typeof payload !== "object") return { success: false, error: "Invalid file" };
    const obj = payload as Record<string, unknown>;
    if (obj.schema !== "rekordbox-mwrty.profile") return { success: false, error: "Unrecognized schema" };
    if (obj.version !== 1) return { success: false, error: "Unsupported version" };
    if (!Array.isArray(obj.entries)) return { success: false, error: "Missing entries" };

    const name = (options?.name ?? (typeof obj.name === "string" ? obj.name : "Imported")).trim() || "Imported";
    const description = typeof obj.description === "string" ? obj.description : null;

    const cleanEntries: Array<{ key: string; value: string }> = [];
    for (const raw of obj.entries) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as Record<string, unknown>;
        if (typeof e.key !== "string" || typeof e.value !== "string") continue;
        if (e.key.length > 256 || e.value.length > 1_000_000) continue;
        cleanEntries.push({ key: e.key, value: e.value });
    }

    const id = crypto.randomUUID();
    await db.insert(userProfiles).values({
        id,
        userId,
        name,
        description,
        isActive: false,
    });
    if (cleanEntries.length > 0) {
        await db.insert(profilePreferences).values(
            cleanEntries.map((e) => ({ profileId: id, key: e.key, value: e.value }))
        );
    }

    if (options?.activate) {
        await db
            .update(userProfiles)
            .set({ isActive: false })
            .where(eq(userProfiles.userId, userId));
        await db
            .update(userProfiles)
            .set({ isActive: true })
            .where(eq(userProfiles.id, id));
    }

    return { success: true, id };
}
