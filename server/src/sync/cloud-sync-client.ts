/**
 * Cloud sync client for the companion app.
 *
 * Bidirectional, last-write-wins sync against `https://muzicai.ro/api/sync`.
 * Push runs on a debounce after every local write that affects a synced
 * entity; pull runs on a 30-second interval (and immediately after push).
 *
 * State persisted in `sync_state` table (single row):
 *   - lastPullCursor:  highest sync_log.id we've consumed from cloud
 *   - lastPushAt:      last successful push timestamp
 *   - dirtyChanges:    queue of pending local changes
 *
 * This is a SCAFFOLD — wiring per-entity push/pull mappers (tracks,
 * playlists, tags, cuepoints) lands in the next iteration. The transport
 * and conflict resolver are complete.
 */

const SYNC_INTERVAL_MS = 30_000;

import { log } from "../lib/logger";

export interface SyncChange {
    entity: "tracks" | "playlists" | "playlist_tracks" | "tags" | "track_tags" | "cuepoints";
    entityId: string;
    op: "upsert" | "delete";
    payload: unknown;
    updatedAt: string;
}

export interface SyncState {
    apiUrl: string; // e.g. https://muzicai.ro
    deviceToken: string;
    lastPullCursor: number;
}

export interface SyncStorage {
    /** Read persisted sync state. */
    load(): Promise<SyncState | null>;
    save(state: SyncState): Promise<void>;
    /** Peek up to N pending local changes from the queue WITHOUT removing
     *  them. Each returned change carries the queue id so the caller can
     *  ack just the rows the cloud accepted. */
    drainDirty(limit: number): Promise<Array<SyncChange & { _queueId: number }>>;
    /** Remove queue rows by id once the cloud has accepted them. Called
     *  after a successful push so we never lose changes when the network
     *  fails mid-flight. */
    ackDirty(queueIds: number[]): Promise<void>;
    /** Apply a remote change to the local SQLite (last-write-wins). */
    applyRemote(change: SyncChange & { id: number }): Promise<void>;
}

export class CloudSyncClient {
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    /** Optional listener invoked once per pull tick that applied at least
     *  one remote change. Use it to broadcast a "refresh your queries"
     *  hint to web clients (over the existing /ws fan-out). The set of
     *  affected entities is grouped so the listener can target invalidations. */
    onApplied?: (entities: ReadonlySet<SyncChange["entity"]>) => void;

    constructor(private readonly storage: SyncStorage) { }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick().catch(this.onError), SYNC_INTERVAL_MS);
        // Immediate first tick so users see fast initial sync.
        void this.tick().catch(this.onError);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private onError = (err: unknown) => {
        log.warn("sync.tick failed", undefined, err);
    };

    /** Run one push+pull cycle. */
    async tick(): Promise<{ pushed: number; pulled: number }> {
        if (this.inFlight) return { pushed: 0, pulled: 0 };
        this.inFlight = true;
        try {
            const state = await this.storage.load();
            if (!state) return { pushed: 0, pulled: 0 };

            const pushed = await this.pushOnce(state);
            const pulled = await this.pullOnce(state);
            await this.storage.save(state);
            return { pushed, pulled };
        } finally {
            this.inFlight = false;
        }
    }

    private async pushOnce(state: SyncState): Promise<number> {
        const changes = await this.storage.drainDirty(500);
        if (changes.length === 0) return 0;
        // Strip the internal queue ids before sending — the cloud doesn't
        // care about our local autoincrement.
        const wireChanges = changes.map(({ _queueId: _, ...c }) => c);
        const res = await fetch(`${state.apiUrl}/api/sync`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${state.deviceToken}`,
            },
            body: JSON.stringify({ changes: wireChanges }),
        });
        if (!res.ok) {
            // 402 = paywall; surface so the UI can prompt upgrade. The queue
            // is intentionally untouched here so the next tick retries the
            // same changes (LWW on the cloud makes that idempotent).
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(`push failed: ${res.status} ${body?.error ?? ""}`);
        }
        // Cloud accepted (or per-row LWW-skipped, which is also "don't retry"):
        // ack the queue so we don't double-push.
        await this.storage.ackDirty(changes.map((c) => c._queueId));
        return changes.length;
    }

    private async pullOnce(state: SyncState): Promise<number> {
        let pulled = 0;
        const touched = new Set<SyncChange["entity"]>();
        // Keep pulling pages until hasMore=false.
        for (; ;) {
            const res = await fetch(
                `${state.apiUrl}/api/sync?cursor=${state.lastPullCursor}`,
                { headers: { authorization: `Bearer ${state.deviceToken}` } },
            );
            if (!res.ok) throw new Error(`pull failed: ${res.status}`);
            const body = (await res.json()) as {
                changes: Array<SyncChange & { id: number }>;
                nextCursor: number;
                hasMore: boolean;
            };
            for (const ch of body.changes) {
                await this.storage.applyRemote(ch);
                touched.add(ch.entity);
                pulled++;
            }
            state.lastPullCursor = body.nextCursor;
            if (!body.hasMore) break;
        }
        if (pulled > 0 && this.onApplied) {
            try { this.onApplied(touched); }
            catch (err) { log.warn("sync.onApplied listener failed", undefined, err); }
        }
        return pulled;
    }
}
