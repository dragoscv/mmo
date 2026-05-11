"use server";

/**
 * Server actions for "saved searches" (a.k.a. smart crates).
 *
 * A saved search is a named copy of the /library page's URL filter
 * state. Auto-updates by definition: the next visit re-runs the
 * filters against the live library, so a crate like
 * "tech-house 124-128 BPM in 7A/8A" stays fresh without any background
 * job.
 *
 * Storage is the `saved_searches` table; payload is validated by
 * `savedSearchInputSchema`. All actions are scoped to the current
 * authenticated user — the unique constraint on (user_id, name)
 * keeps duplicates out without a separate uniqueness check.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { savedSearches, type SavedSearchRow } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { savedSearchInputSchema, type SavedSearchInput } from "@/lib/saved-searches";
import { log } from "@/lib/logger";

async function requireUserId(): Promise<string> {
    const session = await auth();
    const id = session?.user?.id;
    if (!id) throw new Error("Not authenticated");
    return id;
}

export async function listSavedSearches(): Promise<SavedSearchRow[]> {
    const userId = await requireUserId();
    return db
        .select()
        .from(savedSearches)
        .where(eq(savedSearches.userId, userId))
        .orderBy(asc(savedSearches.sortOrder), asc(savedSearches.name));
}

export async function createSavedSearch(input: SavedSearchInput): Promise<SavedSearchRow> {
    const userId = await requireUserId();
    const parsed = savedSearchInputSchema.parse(input);
    try {
        const [row] = await db
            .insert(savedSearches)
            .values({
                userId,
                name: parsed.name,
                icon: parsed.icon,
                filters: parsed.filters,
            })
            .returning();
        revalidatePath("/library");
        log.info("saved-search.created", { id: row.id, name: row.name });
        return row;
    } catch (err) {
        // Postgres unique-violation on (user_id, name).
        if (err instanceof Error && /saved_searches_user_name_uniq/.test(err.message)) {
            throw new Error(`A saved search named "${parsed.name}" already exists.`);
        }
        throw err;
    }
}

const renameSchema = z.object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(60),
});

export async function renameSavedSearch(input: z.infer<typeof renameSchema>): Promise<void> {
    const userId = await requireUserId();
    const { id, name } = renameSchema.parse(input);
    await db
        .update(savedSearches)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(savedSearches.userId, userId), eq(savedSearches.id, id)));
    revalidatePath("/library");
}

export async function deleteSavedSearch(id: number): Promise<void> {
    const userId = await requireUserId();
    const parsed = z.number().int().positive().parse(id);
    await db
        .delete(savedSearches)
        .where(and(eq(savedSearches.userId, userId), eq(savedSearches.id, parsed)));
    revalidatePath("/library");
    log.info("saved-search.deleted", { id: parsed });
}
