"use client";

/**
 * TanStack Query hooks for the /analysis page.
 *
 * These replace the page's bespoke useState + setInterval polling. Benefits:
 * - The data lives in the Query cache (not component state), so navigating away
 *   and back renders the last data INSTANTLY while a background refetch runs.
 * - `refetchInterval` keeps health/status/batches live while the page is
 *   mounted, and TanStack pauses polling when the tab is hidden.
 * - `meta.persist:false` keeps the live polling data out of the IndexedDB
 *   persister (we don't want stale "running" status restored on reload).
 */

import { useQuery } from "@tanstack/react-query";
import {
    getAnalyzerHealth,
    getAnalyzerStatus,
    getAnalyzerBatches,
    getAnalysisScope,
} from "@/actions/analyze";
import { queryKeys } from "./query-keys";

const LIVE_POLL_MS = 2500;

export function useAnalyzerHealth() {
    return useQuery({
        queryKey: queryKeys.analysis.health,
        queryFn: () => getAnalyzerHealth(),
        refetchInterval: LIVE_POLL_MS,
        staleTime: 0,
        meta: { persist: false },
    });
}

export function useAnalyzerStatus(sinceMs?: number) {
    return useQuery({
        queryKey: queryKeys.analysis.status,
        queryFn: () => getAnalyzerStatus(sinceMs),
        refetchInterval: LIVE_POLL_MS,
        staleTime: 0,
        meta: { persist: false },
    });
}

export function useAnalyzerBatches(limit = 50) {
    return useQuery({
        queryKey: queryKeys.analysis.batches,
        queryFn: () => getAnalyzerBatches(limit),
        refetchInterval: LIVE_POLL_MS,
        staleTime: 0,
        meta: { persist: false },
    });
}

export function useAnalysisScope() {
    return useQuery({
        queryKey: queryKeys.analysis.scope,
        queryFn: () => getAnalysisScope(),
        // Scope changes slowly (library size); fine to persist + cache longer.
        staleTime: 60_000,
    });
}
