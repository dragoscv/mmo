"use client";

/**
 * App-wide TanStack Query provider with IndexedDB persistence.
 *
 * Why:
 * - Instant, cache-first navigation: data read on one page stays warm when you
 *   come back, so the app feels native instead of refetching every time.
 * - Background refetch keeps it fresh without blocking the UI.
 * - The cache is persisted to IndexedDB so a full reload (or coming back later)
 *   renders the last data immediately and partially works offline.
 *
 * Tuning:
 * - staleTime 30s: reads are considered fresh for 30s (no refetch on remount /
 *   navigation within that window) — the key to instant page switches.
 * - gcTime 24h: keep cache entries for a day so revisits are warm.
 */

import {
    QueryClient,
    QueryCache,
    type QueryClientConfig,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { type ReactNode, useState } from "react";
import { get, set, del } from "idb-keyval";
import type { Persister } from "@tanstack/react-query-persist-client";
import { toast } from "sonner";

const CACHE_KEY = "muzicai-query-cache";

/** Async persister backed by IndexedDB (via idb-keyval). Survives reloads and
 *  is larger/safer than localStorage for the library cache. */
function createIdbPersister(idbKey: string = CACHE_KEY): Persister {
    return {
        persistClient: async (client) => {
            try { await set(idbKey, client); } catch { /* quota / private mode */ }
        },
        restoreClient: async () => {
            try { return await get(idbKey); } catch { return undefined; }
        },
        removeClient: async () => {
            try { await del(idbKey); } catch { /* ignore */ }
        },
    };
}

const queryConfig: QueryClientConfig = {
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            gcTime: 24 * 60 * 60 * 1000, // 24h
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            retry: 1,
        },
        mutations: {
            retry: 0,
        },
    },
};

export function QueryProvider({ children }: { children: ReactNode }) {
    const [queryClient] = useState(
        () =>
            new QueryClient({
                ...queryConfig,
                queryCache: new QueryCache({
                    onError: (error, query) => {
                        // Only surface errors for queries that opted in (avoids
                        // noisy toasts for background polls).
                        if (query.meta?.errorMessage) {
                            toast.error(String(query.meta.errorMessage));
                        }
                    },
                }),
            }),
    );

    const [persister] = useState(() => createIdbPersister());

    return (
        <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{
                persister,
                maxAge: 24 * 60 * 60 * 1000,
                // Bump when the cached shape changes to invalidate old caches.
                buster: "v1",
                dehydrateOptions: {
                    shouldDehydrateQuery: (q) =>
                        // Persist only successful, non-polling queries (those
                        // tagged persist:false are excluded — e.g. analyzer
                        // status that must always be live).
                        q.state.status === "success" &&
                        q.meta?.persist !== false,
                },
            }}
        >
            {children}
        </PersistQueryClientProvider>
    );
}
