"use server";

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
        console.warn("[tracks] getTracks failed:", err);
        return EMPTY_PAGINATED_TRACKS;
    }
}

export async function getTrackById(id: number): Promise<CompanionTrack | null> {
    const link = await getCompanionLink();
    if (!link) return null;
    try {
        return await companionLibrary.getTrackById(link, id);
    } catch (err) {
        console.warn("[tracks] getTrackById failed:", err);
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
        console.warn("[tracks] getDashboardStats failed:", err);
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

export async function updateTrack(
    id: number,
    data: Partial<CompanionTrack>,
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.updateTrack(link, id, data);
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
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        const r = await companionLibrary.toggleFavorite(link, id);
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
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.setRating(link, id, rating);
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
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.setTags(link, id, tags);
        revalidatePath("/library");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Tags failed" };
    }
}

export async function deleteTrack(
    id: number,
): Promise<{ success: boolean; error?: string }> {
    const link = await getCompanionLink();
    if (!link) return { success: false, error: "Companion not connected" };
    try {
        await companionLibrary.deleteTrack(link, id);
        revalidatePath("/library");
        revalidatePath("/");
        return { success: true };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Delete failed" };
    }
}

export async function hideTracks(
    ids: number[],
): Promise<{ success: boolean; count: number; error?: string }> {
    if (ids.length === 0) return { success: true, count: 0 };
    const link = await getCompanionLink();
    if (!link) return { success: false, count: 0, error: "Companion not connected" };
    try {
        const r = await companionLibrary.setHidden(link, ids, true);
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
    if (ids.length === 0) return { success: true, count: 0 };
    const link = await getCompanionLink();
    if (!link) return { success: false, count: 0, error: "Companion not connected" };
    try {
        const r = await companionLibrary.setHidden(link, ids, false);
        revalidatePath("/library");
        revalidatePath("/library/hidden");
        revalidatePath("/");
        return { success: true, count: r.count };
    } catch (err) {
        return { success: false, count: 0, error: err instanceof Error ? err.message : "Unhide failed" };
    }
}
