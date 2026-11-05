"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { offlineManager, type OfflineManager } from "@/lib/mmo/offline/manager";
import type { OfflineItem } from "@/lib/mmo/offline/types";

const noopSubscribe = (): (() => void) => () => undefined;

/** The manager on the client, `null` during SSR and the hydration pass (no markup mismatch). */
export function useOfflineManager(): OfflineManager | null {
    return useSyncExternalStore(noopSubscribe, offlineManager, () => null);
}

/** Live record of one download (`undefined` while loading, `null` when not downloaded). */
export function useOfflineItem(key: string | null): { item: OfflineItem | null | undefined; manager: OfflineManager | null } {
    const manager = useOfflineManager();
    const [item, setItem] = useState<OfflineItem | null | undefined>(undefined);
    useEffect(() => {
        if (!manager || !key) return;
        let alive = true;
        void manager.get(key).then((i) => { if (alive) setItem(i); }).catch(() => { if (alive) setItem(null); });
        const off = manager.changed.on((c) => { if (c.key === key) setItem(c.item); });
        return () => { alive = false; off(); };
    }, [manager, key]);
    return { item: manager && key ? item : null, manager };
}

/** Live list for one scope (`${serverId}:${profileId}`). */
export function useOfflineList(scope: string | null): {
    items: OfflineItem[] | null;
    error: boolean;
    manager: OfflineManager | null;
    reload(): void;
} {
    const manager = useOfflineManager();
    const [items, setItems] = useState<OfflineItem[] | null>(null);
    const [error, setError] = useState(false);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!manager || !scope) return;
        let alive = true;
        const load = () => manager.list(scope)
            .then((l) => { if (alive) { setItems(l); setError(false); } })
            .catch(() => { if (alive) setError(true); });
        void load();
        const off = manager.changed.on((c) => {
            if (!alive) return;
            setItems((prev) => {
                if (!prev) return prev;
                if (c.item === null) return prev.filter((i) => i.key !== c.key);
                if (c.item.scope !== scope) return prev;
                const at = prev.findIndex((i) => i.key === c.key);
                if (at < 0) return [c.item, ...prev];
                const next = prev.slice();
                next[at] = c.item;
                return next;
            });
        });
        return () => { alive = false; off(); };
    }, [manager, scope, tick]);
    return { items, error, manager, reload: () => setTick((n) => n + 1) };
}
