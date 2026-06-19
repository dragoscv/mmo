/**
 * One-time library backfill into the cloud sync queue.
 *
 * The cloud sync loop (`startCloudSync`) only drains NEW local mutations:
 * a track edit, favorite toggle, scan-ingest, etc. each call
 * `enqueueSyncChange(...)` from the route handlers. But any library that
 * was scanned BEFORE cloud sync existed (or before the device was paired)
 * was never enqueued — so cloud Postgres `tracks` stays empty and the web
 * app shows nothing when opened on another device.
 *
 * This module walks the companion's local SQLite library once and enqueues
 * an `upsert` for every existing track, playlist and playlist membership,
 * mirroring exactly the payload shape the route handlers use. It is:
 *   - idempotent at the cloud (per-field LWW keyed by sha256 / externalId),
 *   - guarded by a per-version store flag so it runs at most once per bump,
 *   - best-effort (never throws into the caller).
 */

import { store } from "../store";
import { getLibraryDb } from "../library/db";
import { tracks, playlists, playlistTracks } from "../library/schema";
import { enqueueSyncChange } from "./index";
import { log } from "../lib/logger";

/** Bump when the backfill payload logic changes and a re-run is desired.
 *  v2: earlier runs drained but the cloud rejected every track (FK on
 *      device_id / missing user, and unknown columns). Re-enqueue once the
 *      cloud accepts sha-less, device-less track upserts.
 *  v3: re-push so the cloud records per-device track_sources rows for the
 *      existing library (availability states). */
const BACKFILL_VERSION = 3;
const FLAG_KEY = "libraryBackfillVersion";

function enqueueTrackUpsert(row: { id: number; userId: string; sha256?: string | null } & Record<string, unknown>): boolean {
    const sha = (row.sha256 ?? "") as string;
    const entityId = sha || `${row.userId}:${row.id}`;
    enqueueSyncChange({
        entity: "tracks",
        entityId,
        op: "upsert",
        payload: { sha256: sha || undefined, ...row, companionTrackId: row.id },
        updatedAt: new Date().toISOString(),
    });
    return true;
}

function enqueuePlaylistUpsert(row: { id: number; userId: string; externalId?: string | null } & Record<string, unknown>): void {
    const ext = (row.externalId as string | undefined) || `${row.userId}:pl:${row.id}`;
    enqueueSyncChange({
        entity: "playlists",
        entityId: ext,
        op: "upsert",
        payload: { externalId: ext, ...row },
        updatedAt: new Date().toISOString(),
    });
}

/**
 * Run the backfill if it hasn't run for the current BACKFILL_VERSION.
 * Safe to call on every startup; returns the number of rows enqueued
 * (0 when skipped).
 */
export function backfillLibraryToCloud(force = false): number {
    try {
        const done = Number(store.get(FLAG_KEY) ?? 0);
        if (!force && done >= BACKFILL_VERSION) return 0;

        const db = getLibraryDb();
        let enqueued = 0;

        // Tracks — enqueue every non-hidden row. Hidden rows are soft-deletes
        // the cloud derives on its own; re-pushing them is harmless but noisy.
        const allTracks = db.select().from(tracks).all() as Array<
            { id: number; userId: string; sha256?: string | null } & Record<string, unknown>
        >;
        for (const row of allTracks) {
            enqueueTrackUpsert(row);
            enqueued++;
        }

        // Playlists + memberships.
        const allPlaylists = db.select().from(playlists).all() as Array<
            { id: number; userId: string; externalId?: string | null } & Record<string, unknown>
        >;
        for (const row of allPlaylists) {
            enqueuePlaylistUpsert(row);
            enqueued++;
        }

        const allMembers = db.select().from(playlistTracks).all() as Array<Record<string, unknown>>;
        for (const m of allMembers) {
            enqueueSyncChange({
                entity: "playlist_tracks",
                entityId: `${m.playlistId}:${m.trackId}`,
                op: "upsert",
                payload: m,
                updatedAt: new Date().toISOString(),
            });
            enqueued++;
        }

        store.set(FLAG_KEY, BACKFILL_VERSION);
        log.info(`[cloud-sync] library backfill enqueued ${enqueued} rows (tracks=${allTracks.length}, playlists=${allPlaylists.length}, members=${allMembers.length})`);
        return enqueued;
    } catch (err) {
        log.warn("[cloud-sync] library backfill failed", undefined, err);
        return 0;
    }
}
