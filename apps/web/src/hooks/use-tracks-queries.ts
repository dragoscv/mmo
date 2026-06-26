"use client";

/**
 * TanStack Query hooks for tracks: cache-first reads + optimistic writes.
 *
 * Reads populate the persisted cache so navigating back to the library is
 * instant. Writes patch the cache immediately (optimistic) and roll back on
 * error, so rating/favorite/tags/hide feel native.
 */

import {
    useQuery,
    useMutation,
    useQueryClient,
    type QueryClient,
} from "@tanstack/react-query";
import {
    getTracks,
    getGenres,
    getAllTags,
    getKeys,
    updateTrack,
    toggleFavorite,
    setTrackRating,
    updateTrackTags,
    type TrackFilters,
    type PaginatedTracks,
} from "@/actions/tracks";
import type { CompanionTrack as Track } from "@/lib/companion-library";
import { queryKeys } from "./query-keys";
import { toast } from "sonner";

// ─── Reads ──────────────────────────────────────────────────────────

export function useTracks(
    filters: Partial<TrackFilters>,
    initialData?: PaginatedTracks,
) {
    return useQuery({
        queryKey: queryKeys.tracks.list(filters),
        queryFn: () => getTracks(filters as TrackFilters),
        initialData,
        // Keep the previous page's data on screen while the next loads.
        placeholderData: (prev) => prev,
    });
}

export function useGenres(initialData?: string[]) {
    return useQuery({ queryKey: queryKeys.tracks.genres, queryFn: () => getGenres(), initialData, staleTime: 5 * 60_000 });
}
export function useTags(initialData?: string[]) {
    return useQuery({ queryKey: queryKeys.tracks.tags, queryFn: () => getAllTags(), initialData, staleTime: 5 * 60_000 });
}
export function useKeys(initialData?: string[]) {
    return useQuery({ queryKey: queryKeys.tracks.keys, queryFn: () => getKeys(), initialData, staleTime: 5 * 60_000 });
}

// ─── Optimistic cache patching helper ───────────────────────────────

/** Patch one track across every cached tracks.list page. Returns a snapshot
 *  of the affected queries so the caller can roll back on error. */
function patchTrackInCache(
    qc: QueryClient,
    trackId: number,
    patch: Partial<Track>,
) {
    const snapshots = qc.getQueriesData<PaginatedTracks>({ queryKey: queryKeys.tracks.all });
    for (const [key, data] of snapshots) {
        if (!data?.tracks) continue;
        const next = {
            ...data,
            tracks: data.tracks.map((t) =>
                t.id === trackId ? { ...t, ...patch } : t,
            ),
        };
        qc.setQueryData(key, next);
    }
    return snapshots;
}

function rollback(qc: QueryClient, snapshots: ReturnType<typeof patchTrackInCache>) {
    for (const [key, data] of snapshots) qc.setQueryData(key, data);
}

// ─── Optimistic mutations ───────────────────────────────────────────

export function useToggleFavorite() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (vars: { id: number; current: boolean }) => toggleFavorite(vars.id),
        onMutate: async (vars) => {
            await qc.cancelQueries({ queryKey: queryKeys.tracks.all });
            const snapshots = patchTrackInCache(qc, vars.id, { isFavorite: !vars.current } as Partial<Track>);
            return { snapshots };
        },
        onError: (_e, _vars, ctx) => {
            if (ctx?.snapshots) rollback(qc, ctx.snapshots);
            toast.error("Couldn't update favorite");
        },
        onSettled: () => { void qc.invalidateQueries({ queryKey: queryKeys.tracks.all }); },
    });
}

export function useSetRating() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (vars: { id: number; rating: number | null }) => setTrackRating(vars.id, vars.rating),
        onMutate: async (vars) => {
            await qc.cancelQueries({ queryKey: queryKeys.tracks.all });
            const snapshots = patchTrackInCache(qc, vars.id, { rating: vars.rating } as Partial<Track>);
            return { snapshots };
        },
        onError: (_e, _vars, ctx) => {
            if (ctx?.snapshots) rollback(qc, ctx.snapshots);
            toast.error("Couldn't update rating");
        },
        onSettled: () => { void qc.invalidateQueries({ queryKey: queryKeys.tracks.all }); },
    });
}

export function useUpdateTrackTags() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (vars: { id: number; tags: string[] }) => updateTrackTags(vars.id, vars.tags),
        onMutate: async (vars) => {
            await qc.cancelQueries({ queryKey: queryKeys.tracks.all });
            const snapshots = patchTrackInCache(qc, vars.id, { tags: vars.tags.join(", ") } as Partial<Track>);
            return { snapshots };
        },
        onError: (_e, _vars, ctx) => {
            if (ctx?.snapshots) rollback(qc, ctx.snapshots);
            toast.error("Couldn't update tags");
        },
        onSettled: () => {
            void qc.invalidateQueries({ queryKey: queryKeys.tracks.all });
            void qc.invalidateQueries({ queryKey: queryKeys.tracks.tags });
        },
    });
}

export function useUpdateTrack() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (vars: { id: number; data: Partial<Track> }) => updateTrack(vars.id, vars.data),
        onMutate: async (vars) => {
            await qc.cancelQueries({ queryKey: queryKeys.tracks.all });
            const snapshots = patchTrackInCache(qc, vars.id, vars.data);
            return { snapshots };
        },
        onError: (_e, _vars, ctx) => {
            if (ctx?.snapshots) rollback(qc, ctx.snapshots);
            toast.error("Couldn't update track");
        },
        onSettled: () => { void qc.invalidateQueries({ queryKey: queryKeys.tracks.all }); },
    });
}
