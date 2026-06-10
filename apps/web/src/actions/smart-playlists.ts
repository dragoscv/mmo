"use server";

/**
 * Smart playlist server actions — Batch 40.
 *
 * Architecture:
 *   - Cloud table `smart_playlist_rules` stores rules keyed by
 *     (userId, companionPlaylistId). Separate from `playlists` so we
 *     don't touch the per-field LWW sync surface.
 *   - The actual playlist (name, description, track join) lives on
 *     the companion exactly like a manual playlist — no companion
 *     code change. We just call addTracksToPlaylist on the companion
 *     after the rules engine has selected the matching ids.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { smartPlaylistRules } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
    companionLibrary,
    getCompanionLink,
} from "@/lib/companion-library";
import {
    smartRulesSchema,
    applySmartRules,
    type SmartRules,
    type FilterableTrack,
} from "@/lib/smart-rules";
import { log } from "@/lib/logger";

const playlistIdSchema = z.number().int().positive();
const playlistNameSchema = z.string().trim().min(1).max(200);

function err(msg: string) {
    return { success: false as const, error: msg };
}

async function requireUser(): Promise<{ userId: string } | { error: string }> {
    const session = await auth();
    if (!session?.user?.id) return { error: "Unauthorized" };
    return { userId: session.user.id };
}

/**
 * Create a new smart playlist with rules attached. The companion
 * playlist row is created first (so we have a stable id), then the
 * rules row is inserted on the cloud, then the initial population
 * runs. Rolls back the companion row on rules-insert / populate
 * failure so a half-baked playlist doesn't get left behind.
 */
export async function createSmartPlaylist(
    name: string,
    rulesInput: unknown,
    ruleSource: "builder" | "sql" | "graph" | "ai",
): Promise<{ success: boolean; id?: number; count?: number; error?: string }> {
    const u = await requireUser();
    if ("error" in u) return err(u.error);

    const nameCheck = playlistNameSchema.safeParse(name);
    if (!nameCheck.success) return err("Invalid playlist name");
    const rulesCheck = smartRulesSchema.safeParse(rulesInput);
    if (!rulesCheck.success) {
        return err(`Invalid rules: ${rulesCheck.error.issues[0]?.message ?? "unknown"}`);
    }
    const rules = rulesCheck.data;

    const link = await getCompanionLink();
    if (!link) return err("Companion not connected");

    let playlistId: number | null = null;
    try {
        const created = await companionLibrary.createPlaylist(link, nameCheck.data);
        playlistId = created.id;

        await db.insert(smartPlaylistRules).values({
            userId: u.userId,
            companionPlaylistId: created.id,
            rules: rules as unknown as Record<string, unknown>,
            ruleSource,
            lastPopulatedAt: new Date(),
        });

        const count = await runSmartPopulation(link, playlistId, rules);
        revalidatePath("/playlists");
        return { success: true, id: playlistId, count };
    } catch (e) {
        if (playlistId !== null) {
            try { await companionLibrary.deletePlaylist(link, playlistId); }
            catch (rollbackErr) {
                log.warn("createSmartPlaylist rollback failed", {
                    playlistId,
                    error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
                });
            }
        }
        return err(e instanceof Error ? e.message : "Create failed");
    }
}

/**
 * Replace the rules on an existing smart playlist and re-populate.
 * Upserts the rules row so this also handles the "convert manual to
 * smart" path without a separate action.
 */
export async function updateSmartPlaylistRules(
    id: number,
    rulesInput: unknown,
    ruleSource: "builder" | "sql" | "graph" | "ai",
): Promise<{ success: boolean; count?: number; error?: string }> {
    const u = await requireUser();
    if ("error" in u) return err(u.error);
    const idCheck = playlistIdSchema.safeParse(id);
    if (!idCheck.success) return err("Invalid playlist id");
    const rulesCheck = smartRulesSchema.safeParse(rulesInput);
    if (!rulesCheck.success) return err(`Invalid rules: ${rulesCheck.error.issues[0]?.message ?? "unknown"}`);

    const link = await getCompanionLink();
    if (!link) return err("Companion not connected");

    try {
        await db.insert(smartPlaylistRules)
            .values({
                userId: u.userId,
                companionPlaylistId: id,
                rules: rulesCheck.data as unknown as Record<string, unknown>,
                ruleSource,
                lastPopulatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: [smartPlaylistRules.userId, smartPlaylistRules.companionPlaylistId],
                set: {
                    rules: rulesCheck.data as unknown as Record<string, unknown>,
                    ruleSource,
                    lastPopulatedAt: new Date(),
                    updatedAt: new Date(),
                },
            });

        const count = await runSmartPopulation(link, id, rulesCheck.data);
        revalidatePath("/playlists");
        return { success: true, count };
    } catch (e) {
        return err(e instanceof Error ? e.message : "Update failed");
    }
}

/** Re-run a smart playlist's stored rules (for the "Refresh" button). */
export async function refreshSmartPlaylist(
    id: number,
): Promise<{ success: boolean; count?: number; error?: string }> {
    const u = await requireUser();
    if ("error" in u) return err(u.error);
    const idCheck = playlistIdSchema.safeParse(id);
    if (!idCheck.success) return err("Invalid playlist id");

    const row = await db.select({ rules: smartPlaylistRules.rules })
        .from(smartPlaylistRules)
        .where(and(
            eq(smartPlaylistRules.companionPlaylistId, id),
            eq(smartPlaylistRules.userId, u.userId),
        ))
        .limit(1);
    if (row.length === 0) return err("Not a smart playlist");

    const rulesCheck = smartRulesSchema.safeParse(row[0].rules);
    if (!rulesCheck.success) return err("Stored rules are invalid");

    const link = await getCompanionLink();
    if (!link) return err("Companion not connected");

    try {
        const count = await runSmartPopulation(link, id, rulesCheck.data);
        await db.update(smartPlaylistRules)
            .set({ lastPopulatedAt: new Date(), updatedAt: new Date() })
            .where(and(
                eq(smartPlaylistRules.companionPlaylistId, id),
                eq(smartPlaylistRules.userId, u.userId),
            ));
        revalidatePath("/playlists");
        return { success: true, count };
    } catch (e) {
        return err(e instanceof Error ? e.message : "Refresh failed");
    }
}

/**
 * Preview-only: run the rules against the user's library and return
 * how many tracks would match.
 */
export async function previewSmartRules(
    rulesInput: unknown,
    sampleLimit = 25,
): Promise<{ success: boolean; total?: number; sample?: number[]; error?: string }> {
    const u = await requireUser();
    if ("error" in u) return err(u.error);
    const rulesCheck = smartRulesSchema.safeParse(rulesInput);
    if (!rulesCheck.success) return err(`Invalid rules: ${rulesCheck.error.issues[0]?.message ?? "unknown"}`);

    const link = await getCompanionLink();
    if (!link) return err("Companion not connected");

    try {
        const page = await companionLibrary.getTracks(link, { page: 1, pageSize: 10000 });
        const matched = applySmartRules(page.tracks as unknown as FilterableTrack[], rulesCheck.data);
        return {
            success: true,
            total: matched.length,
            sample: matched.slice(0, sampleLimit).map((t) => t.id),
        };
    } catch (e) {
        return err(e instanceof Error ? e.message : "Preview failed");
    }
}

/** Read the rules for a single playlist. */
export async function getSmartPlaylistRules(
    id: number,
): Promise<{ rules: SmartRules; ruleSource: string; lastPopulatedAt: string | null } | null> {
    const u = await requireUser();
    if ("error" in u) return null;
    const row = await db.select({
        rules: smartPlaylistRules.rules,
        ruleSource: smartPlaylistRules.ruleSource,
        lastPopulatedAt: smartPlaylistRules.lastPopulatedAt,
    })
        .from(smartPlaylistRules)
        .where(and(
            eq(smartPlaylistRules.companionPlaylistId, id),
            eq(smartPlaylistRules.userId, u.userId),
        ))
        .limit(1);
    if (row.length === 0) return null;
    const parsed = smartRulesSchema.safeParse(row[0].rules);
    if (!parsed.success) return null;
    return {
        rules: parsed.data,
        ruleSource: row[0].ruleSource,
        lastPopulatedAt: row[0].lastPopulatedAt?.toISOString() ?? null,
    };
}

/** Return the set of companionPlaylistIds that have smart rules attached.
 *  Used by the playlists list to show a "smart" badge without fetching
 *  the rules themselves. One query for the whole sidebar. */
export async function getSmartPlaylistIds(): Promise<number[]> {
    const u = await requireUser();
    if ("error" in u) return [];
    const rows = await db.select({ id: smartPlaylistRules.companionPlaylistId })
        .from(smartPlaylistRules)
        .where(eq(smartPlaylistRules.userId, u.userId));
    return rows.map((r) => r.id);
}

// ─── internals ──────────────────────────────────────────────────────

async function runSmartPopulation(
    link: NonNullable<Awaited<ReturnType<typeof getCompanionLink>>>,
    playlistId: number,
    rules: SmartRules,
): Promise<number> {
    const page = await companionLibrary.getTracks(link, { page: 1, pageSize: 10000 });
    const matched = applySmartRules(page.tracks as unknown as FilterableTrack[], rules);

    // Replace strategy: clear then add. Smart-playlist refresh cadence
    // is low and the companion's bulk addTracksToPlaylist already
    // runs in a single transaction, so wholesale rewrite is simpler
    // with identical cost vs. computing a diff.
    const existing = await companionLibrary.getPlaylistTracks(link, playlistId, 1, 100000);
    for (const t of existing.tracks) {
        await companionLibrary.removeTrackFromPlaylist(link, playlistId, t.id);
    }
    if (matched.length > 0) {
        await companionLibrary.addTracksToPlaylist(link, playlistId, matched.map((m) => m.id));
    }
    return matched.length;
}
