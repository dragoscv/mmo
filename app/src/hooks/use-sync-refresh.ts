"use client";

/**
 * useSyncRefresh — listens to the companion's `sync:applied` WebSocket
 * frame and calls `router.refresh()` when a relevant entity changed on
 * another device. Replaces 30-second cloud-pull polling with sub-second
 * cross-device updates.
 *
 * Mount once at the top of any page whose data lives on the companion
 * and benefits from cross-device freshness (library, playlists,
 * dashboard). It's a no-op when the companion isn't reachable, so it's
 * safe to mount unconditionally.
 *
 * Internally maintains a single shared WS connection per page session
 * (process-global singleton) so multiple useSyncRefresh mounts don't
 * each open their own socket. The optional `entities` filter lets a
 * page only refresh when its own entities change; pass `undefined` (the
 * default) to refresh on any sync tick.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { discoverCompanion, NativeCompanionClient } from "@/lib/native-companion";

type SyncEntity =
    | "tracks"
    | "playlists"
    | "playlist_tracks"
    | "tags"
    | "track_tags"
    | "cuepoints";

// Module-level singleton: one shared client + listener fan-out so N
// hook mounts only ever open one socket. Lazily started on first
// subscriber and never torn down (companion discovery + WS reconnect
// are cheap and idempotent; the WS is shared with audio + watcher
// telemetry too).
let _client: NativeCompanionClient | null = null;
let _starting: Promise<void> | null = null;
const _listeners = new Set<(entities: ReadonlySet<string>) => void>();

async function ensureSyncClient(): Promise<void> {
    if (_client) return;
    if (_starting) return _starting;
    _starting = (async () => {
        const hit = await discoverCompanion().catch(() => null);
        if (!hit?.apiUrl) {
            // No companion right now — leave _client null. The next
            // subscribe call retries discovery (idempotent).
            _starting = null;
            return;
        }
        const client = new NativeCompanionClient({ apiUrl: hit.apiUrl });
        client.addSyncAppliedListener((entities) => {
            for (const fn of _listeners) fn(entities);
        });
        client.connectWs();
        _client = client;
        _starting = null;
    })();
    return _starting;
}

export function useSyncRefresh(entities?: readonly SyncEntity[]): void {
    const router = useRouter();
    useEffect(() => {
        const filter = entities && entities.length > 0 ? new Set<string>(entities) : null;
        const listener = (touched: ReadonlySet<string>) => {
            if (filter) {
                let intersects = false;
                for (const e of touched) {
                    if (filter.has(e)) { intersects = true; break; }
                }
                if (!intersects) return;
            }
            router.refresh();
        };
        _listeners.add(listener);
        void ensureSyncClient();
        return () => { _listeners.delete(listener); };
    }, [router, entities]);
}
