/**
 * Marketplace UI cache: the last catalogue (in memory only) plus per-pack
 * busy/error state, so reopening the tab is instant and a running download
 * keeps its spinner when the user switches tabs.
 */
import { create } from "zustand";
import { fetchCatalog, type MarketCatalog } from "@/bridge/marketplace";

export type MarketBusy = "try" | "install";

interface MarketStore {
    catalog: MarketCatalog | null;
    loading: boolean;
    loadError: string | null;
    busy: Record<string, MarketBusy | undefined>;
    errors: Record<string, string | undefined>;
    load: (signal?: AbortSignal) => Promise<void>;
    setBusy: (id: string, busy: MarketBusy | null) => void;
    setError: (id: string, error: string | null) => void;
}

export const useMarketStore = create<MarketStore>((set) => ({
    catalog: null,
    loading: false,
    loadError: null,
    busy: {},
    errors: {},
    load: async (signal) => {
        set({ loading: true, loadError: null });
        try {
            const catalog = await fetchCatalog(undefined, signal);
            set({ catalog, loading: false });
        } catch (e) {
            if (signal?.aborted) {
                set({ loading: false });
                return;
            }
            set({ loading: false, loadError: e instanceof Error ? e.message : String(e) });
        }
    },
    setBusy: (id, busy) => set((s) => ({ busy: { ...s.busy, [id]: busy ?? undefined } })),
    setError: (id, error) => set((s) => ({ errors: { ...s.errors, [id]: error ?? undefined } })),
}));
