"use server";

import { log } from "@/lib/logger";
import { z } from "zod";

/**
 * Track server actions — thin client over the companion's /library/* API.
 *
 * Auth model:
 *   - No session OR no local companion linked → all reads return empty
 *     and all writes are no-ops returning `{ error: "..." }`.
 *   - With session + companion → calls the companion HTTP API. Every
 *     row is filtered server-side by the user's id.
 *
 * The web app no longer reads or writes the `tracks` table directly —
 * those tables now live in the companion's library.db.
 */

import { revalidatePath } from "next/cache";
import {
    companionLibrary,
    getCompanionLink,
    EMPTY_PAGINATED_TRACKS,
    EMPTY_STATS,
    type CompanionTrack,
    type DashboardStats,
    type PaginatedTracks,
    type TrackFilters,
} from "@/lib/companion-library";

export type { TrackFilters, PaginatedTracks, DashboardStats } from "@/lib/companion-library";
export type Track = CompanionTrack;

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function getTracks(filters?: TrackFilters): Promise<PaginatedTracks> {
    const link = await getCompanionLink();
    if (!link) return EMPTY_PAGINATED_TRACKS;
    try {
        return await companionLibrary.getTracks(link, filters);
    } catch (err) {
        log.warn("tracks.getTracks failed", undefined, err);
        return EMPTY_PAGINATED_TRACKS;
    }
}

export async function getTrackById(id: number): Promise<CompanionTrack | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await companionLibrary.getTrackById(link, id);
    } catch (err) {
        log.warn("tracks.getTrackById failed", undefined, err);
        return null;
    }
}

export async function getGenres(): Promise<string[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try { return await companionLibrary.getGenres(link); }
    catch { return []; }
}

export async function getKeys(): Promise<string[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try { return await companionLibrary.getKeys(link); }
    catch { return []; }
}

export async function getAllTags(): Promise<string[]> {
    const link = await getCompanionLink();
    if (!link) return [];
    try { return await companionLibrary.getTags(link); }
    catch { return []; }
}

export async function getDashboardStats(): Promise<DashboardStats> {
    const link = await getCompanionLink();
    if (!link) return EMPTY_STATS;
    try { return await companionLibrary.getStats(link); }
    catch (err) {
        log.warn("tracks.getDashboardStats failed", undefined, err);
        return EMPTY_STATS;
    }
}

/** Lightweight overview used by some smaller widgets. Derived from full
 *  stats so we only hit the companion once. */
export async function getTrackStats(): Promise<{
    total: number;
    processed: number;
    unprocessed: number;
    avgBpm: number;
    genreStats: { genre: string; count: number }[];
}> {
    const stats = await getDashboardStats();
    return {
        total: stats.total,
        processed: stats.processed,
        unprocessed: stats.unprocessed,
        avgBpm: stats.avgBpm,
        genreStats: stats.genreStats,
    };
}

export async function getHiddenTracks(
    filters?: Pick<TrackFilters, "page" | "pageSize" | "search" | "sort" | "order">,
): Promise<PaginatedTracks> {
    const link = await getCompanionLink();
    if (!link) return EMPTY_PAGINATED_TRACKS;
    try {
        return await companionLibrary.getTracks(link, { ...filters, isHidden: true });
    } catch {
        return EMPTY_PAGINATED_TRACKS;
    }
}

// ─── Writes ─────────────────────────────────────────────────────────────────
//
// Every mutation validates its input shape with Zod before forwarding to
// the companion. Auth is enforced by `getCompanionLink()` which calls
// `auth()` and short-circuits without a signed-in session. Untrusted
// fields are stripped at the API boundary too (companion's `routes.ts`
// deletes `id`, `userId`, and `filepath` from PATCH bodies regardless
// of what we send), so this is defense-in-depth.

const trackIdSchema = z.number().int().positive();
const tagSchema = z.string().min(1).max(64);
const ratingSchema = z.union([z.number().int().min(1).max(5), z.null()]);
const trackUpdateSchema = z
    .object({
        title: z.string().max(500).optional(),
        artist: z.string().max(500).optional(),
        album: z.string().max(500).optional(),
        genre: z.string().max(200).optional(),
        subgenre: z.string().max(200).optional(),
        bpm: z.number().min(0).max(400).optional(),
        keyCamelot: z.string().max(8).optional(),
        energy: z.number().int().min(0).max(10).optional(),
        mood: z.string().max(200).optional(),
        rating: ratingSchema.optional(),
        comment: z.string().max(2000).optional(),
        year: z.number().int().min(1900).max(2200).optional(),
        label: z.string().max(200).optional(),
        isFavorite: z.boolean().optional(),
        isHidden: z.boolean().optional(),
        // tags are handled by `updateTrackTags`; reject here if leaked.
    })
    .strict()
    .partial();

function failedValidation(err: z.ZodError): { success: false; error: string } {
    return { success: false, error: err.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ") };
}

export async function updateTrack(
    id: number,
    data: Partial<CompanionTrack>,
): Promise<{ success: boolean; error?: string }> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const dataCheck = trackUpdateSchema.safeParse(data);
    if (!dataCheck.success) return failedValidation(dataCheck.error);
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.updateTrack(link, idCheck.data, dataCheck.data as Partial<CompanionTrack>);
        revalidatePath("/library");
        revalidatePath("/");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Update failed" };
    }
}

export async function toggleFavorite(
    id: number,
): Promise<{ success: boolean; isFavorite?: boolean; error?: string }> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        const r = await companionLibrary.toggleFavorite(link, idCheck.data);
        revalidatePath("/library");
        return { success: true, isFavorite: r.isFavorite };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Toggle failed" };
    }
}

export async function setTrackRating(
    id: number,
    rating: number | null,
): Promise<{ success: boolean; error?: string }> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const ratingCheck = ratingSchema.safeParse(rating);
    if (!ratingCheck.success) return failedValidation(ratingCheck.error);
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.setRating(link, idCheck.data, ratingCheck.data);
        revalidatePath("/library");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Rating failed" };
    }
}

export async function updateTrackTags(
    id: number,
    tags: string[],
): Promise<{ success: boolean; error?: string }> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const tagsCheck = z.array(tagSchema).max(100).safeParse(tags);
    if (!tagsCheck.success) return failedValidation(tagsCheck.error);
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.setTags(link, idCheck.data, tagsCheck.data);
        revalidatePath("/library");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Tags failed" };
    }
}

export async function deleteTrack(
    id: number,
): Promise<{ success: boolean; error?: string }> {
    const idCheck = trackIdSchema.safeParse(id);
    if (!idCheck.success) return failedValidation(idCheck.error);
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.deleteTrack(link, idCheck.data);
        revalidatePath("/library");
        revalidatePath("/");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Delete failed" };
    }
}

const trackIdsSchema = z.array(trackIdSchema).max(10000);

export async function hideTracks(
    ids: number[],
): Promise<{ success: boolean; count: number; error?: string }> {
    const check = trackIdsSchema.safeParse(ids);
    if (!check.success) return { success: false, count: 0, error: failedValidation(check.error).error };
    if (check.data.length === 0) return { success: true, count: 0 };
    const link = await getCompanionLink();
    if (!link) return { success: false, count: 0, error: "Companion not connected" };
    try {
        const r = await companionLibrary.setHidden(link, check.data, true);
        revalidatePath("/library");
        revalidatePath("/");
        return { success: true, count: r.count };
    } catch (err) {
        return { success: false, count: 0, error: err instanceof Error ? err.message : "Hide failed" };
    }
}

export async function unhideTracks(
    ids: number[],
): Promise<{ success: boolean; count: number; error?: string }> {
    const check = trackIdsSchema.safeParse(ids);
    if (!check.success) return { success: false, count: 0, error: failedValidation(check.error).error };
    if (check.data.length === 0) return { success: true, count: 0 };
    const link = await getCompanionLink();
    if (!link) return { success: false, count: 0, error: "Companion not connected" };
    try {
        const r = await companionLibrary.setHidden(link, check.data, false);
        revalidatePath("/library");
        revalidatePath("/library/hidden");
        revalidatePath("/");
        return { success: true, count: r.count };
    } catch (err) {
        return { success: false, count: 0, error: err instanceof Error ? err.message : "Unhide failed" };
    }
}
