/**
 * Per-entity dispatchers for `POST /api/sync`.
 *
 * Conflict policy:
 *  • `tracks`             → per-field LWW. The row stores `field_versions`
 *                            (jsonb map of `field → ISO timestamp`). For each
 *                            key in the incoming partial payload we only
 *                            persist the value when the change's `updatedAt`
 *                            beats the stored per-field clock. New rows are
 *                            created keyed by `(userId, sha256)`.
 *  • `playlists`          → row-level LWW keyed by `(userId, externalId)`.
 *  • `cuepoints`          → row-level LWW keyed by `(trackId, externalId)`.
 *  • `tags` / `track_tags` / `playlist_tracks` → idempotent set ops (no
 *                            conflict semantics needed; presence/absence is
 *                            the entire payload).
 *
 * Every successful write also appends to `syncLog` so OTHER devices owned by
 * the same user can pull it on their next `GET /api/sync`. We do NOT log
 * the device's own writes back to itself — we filter by `originDeviceId`
 * during pull (see route GET).
 */

import { db } from "@/db";
import {
    tracks,
    playlists,
    playlistTracks,
    tags,
    trackTags,
    cuepoints,
    syncLog,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";

export type SyncEntity =
    | "tracks"
    | "playlists"
    | "playlist_tracks"
    | "tags"
    | "track_tags"
    | "cuepoints";

export interface SyncChange {
    entity: SyncEntity | string;
    /** Stable cross-device identifier — sha256 for tracks, UUID for others. */
    entityId: string;
    op: "upsert" | "delete";
    payload: Record<string, unknown> | null;
    /** ISO 8601 timestamp from the originating device. */
    updatedAt: string;
}

export interface ApplyResult {
    /** True when at least one column changed (for tracks: any field accepted). */
    changed: boolean;
    /** Cloud row id after the operation, when known. */
    rowId?: number;
    /** Skipped because LWW lost; UI can show "no-op" diagnostics. */
    skipped?: boolean;
    /** Hard error — caller should report and continue with next change. */
    error?: string;
}

const FORBIDDEN_TRACK_FIELDS = new Set([
    "id", "userId", "user_id",
    "sha256", "fieldVersions", "field_versions",
    "syncVersion", "sync_version",
    "createdAt", "addedAt", "added_at",
]);

/**
 * Tracks — per-field LWW, keyed by `(userId, sha256)`.
 * Pure helper around the DB so the route stays thin and testable.
 */
export async function applyTrackUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    if (change.op === "delete") {
        // Soft-delete via isHidden: real delete would orphan playlistTracks,
        // and a re-scan on the device would re-create the row.
        const existing = await db
            .select({ id: tracks.id, fv: tracks.fieldVersions })
            .from(tracks)
            .where(and(eq(tracks.userId, userId), eq(tracks.sha256, change.entityId)))
            .limit(1);
        if (existing.length === 0) return { changed: false, skipped: true };
        const row = existing[0];
        const fv = (row.fv ?? {}) as Record<string, string>;
        if (fv.isHidden && fv.isHidden >= change.updatedAt) {
            return { changed: false, skipped: true, rowId: row.id };
        }
        await db
            .update(tracks)
            .set({
                isHidden: true,
                fieldVersions: { ...fv, isHidden: change.updatedAt },
                updatedAt: new Date(change.updatedAt),
            })
            .where(eq(tracks.id, row.id));
        return { changed: true, rowId: row.id };
    }

    const payload = change.payload ?? {};
    const sha256 = change.entityId;
    if (!sha256) return { changed: false, error: "Missing sha256 for tracks upsert" };

    const existing = await db
        .select({ id: tracks.id, fv: tracks.fieldVersions })
        .from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.sha256, sha256)))
        .limit(1);

    // Filter incoming fields against the per-field clock.
    const stored = (existing[0]?.fv ?? {}) as Record<string, string>;
    const accepted: Record<string, unknown> = {};
    const nextFv: Record<string, string> = { ...stored };
    for (const [key, value] of Object.entries(payload)) {
        if (FORBIDDEN_TRACK_FIELDS.has(key)) continue;
        const storedTs = stored[key];
        if (storedTs && storedTs >= change.updatedAt) continue; // LWW loser
        accepted[key] = value;
        nextFv[key] = change.updatedAt;
    }

    if (Object.keys(accepted).length === 0 && existing.length > 0) {
        return { changed: false, skipped: true, rowId: existing[0].id };
    }

    if (existing.length === 0) {
        // New row — accept everything we filtered above (no stored clock yet).
        const inserted = await db
            .insert(tracks)
            .values({
                userId,
                sha256,
                ...accepted,
                fieldVersions: nextFv,
                updatedAt: new Date(change.updatedAt),
            })
            .returning({ id: tracks.id });
        return { changed: true, rowId: inserted[0]?.id };
    }

    await db
        .update(tracks)
        .set({
            ...accepted,
            fieldVersions: nextFv,
            updatedAt: new Date(change.updatedAt),
        })
        .where(eq(tracks.id, existing[0].id));
    return { changed: true, rowId: existing[0].id };
}

/** Playlists — row-level LWW by (userId, externalId). */
export async function applyPlaylistUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    const externalId = change.entityId;
    if (!externalId) return { changed: false, error: "Missing externalId for playlists" };

    if (change.op === "delete") {
        const existing = await db
            .select({ id: playlists.id, updatedAt: playlists.updatedAt })
            .from(playlists)
            .where(and(eq(playlists.userId, userId), eq(playlists.externalId, externalId)))
            .limit(1);
        if (existing.length === 0) return { changed: false, skipped: true };
        const incomingTs = new Date(change.updatedAt);
        if (existing[0].updatedAt && existing[0].updatedAt > incomingTs) {
            // Stale tombstone — the cloud has a newer write. LWW says we lose.
            return { changed: false, skipped: true, rowId: existing[0].id };
        }
        await db.delete(playlists).where(eq(playlists.id, existing[0].id));
        return { changed: true, rowId: existing[0].id };
    }

    const payload = change.payload ?? {};
    const existing = await db
        .select({ id: playlists.id, updatedAt: playlists.updatedAt })
        .from(playlists)
        .where(and(eq(playlists.userId, userId), eq(playlists.externalId, externalId)))
        .limit(1);

    const incomingTs = new Date(change.updatedAt);

    if (existing.length === 0) {
        const inserted = await db
            .insert(playlists)
            .values({
                userId,
                externalId,
                name: String(payload.name ?? "Untitled"),
                description: payload.description == null ? null : String(payload.description),
                color: payload.color == null ? null : String(payload.color),
                parentId: payload.parentId == null ? null : Number(payload.parentId),
                sortOrder: Number(payload.sortOrder ?? 0),
                updatedAt: incomingTs,
            })
            .returning({ id: playlists.id });
        return { changed: true, rowId: inserted[0]?.id };
    }

    const row = existing[0];
    if (row.updatedAt && row.updatedAt > incomingTs) {
        return { changed: false, skipped: true, rowId: row.id };
    }
    await db
        .update(playlists)
        .set({
            ...(payload.name !== undefined ? { name: String(payload.name) } : {}),
            ...(payload.description !== undefined ? { description: payload.description == null ? null : String(payload.description) } : {}),
            ...(payload.color !== undefined ? { color: payload.color == null ? null : String(payload.color) } : {}),
            ...(payload.parentId !== undefined ? { parentId: payload.parentId == null ? null : Number(payload.parentId) } : {}),
            ...(payload.sortOrder !== undefined ? { sortOrder: Number(payload.sortOrder) } : {}),
            updatedAt: incomingTs,
        })
        .where(eq(playlists.id, row.id));
    return { changed: true, rowId: row.id };
}

/**
 * Tags — keyed by `(userId, name)`, idempotent. Delete removes the row and
 * any trackTags pivots cascade through the FK.
 */
export async function applyTagUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    const payload = change.payload ?? {};
    const name = String(payload.name ?? change.entityId ?? "").trim();
    if (!name) return { changed: false, error: "Missing tag name" };

    if (change.op === "delete") {
        await db.delete(tags).where(and(eq(tags.userId, userId), eq(tags.name, name)));
        return { changed: true };
    }

    await db
        .insert(tags)
        .values({ userId, name, color: payload.color == null ? null : String(payload.color) })
        .onConflictDoUpdate({
            target: [tags.userId, tags.name],
            set: { color: payload.color == null ? null : String(payload.color) },
        });
    return { changed: true };
}

/**
 * Pivot tables — set semantics. The companion sends one change per
 * (playlist, track) or (track, tag) tuple; the server upserts/deletes the
 * single row.
 */
export async function applyPlaylistTrackUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    const payload = change.payload ?? {};
    // entityId encodes "<playlistExternalId>:<trackSha256>"
    const [playlistExt, trackSha] = String(change.entityId).split(":");
    if (!playlistExt || !trackSha) {
        return { changed: false, error: "playlist_tracks entityId must be 'plExt:trackSha'" };
    }

    const pl = await db
        .select({ id: playlists.id })
        .from(playlists)
        .where(and(eq(playlists.userId, userId), eq(playlists.externalId, playlistExt)))
        .limit(1);
    const tr = await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.sha256, trackSha)))
        .limit(1);
    if (pl.length === 0 || tr.length === 0) return { changed: false, error: "Unknown playlist or track" };

    if (change.op === "delete") {
        await db
            .delete(playlistTracks)
            .where(and(eq(playlistTracks.playlistId, pl[0].id), eq(playlistTracks.trackId, tr[0].id)));
        return { changed: true };
    }

    const position = Number(payload.position ?? 0);
    await db
        .insert(playlistTracks)
        .values({ playlistId: pl[0].id, trackId: tr[0].id, position })
        .onConflictDoUpdate({
            target: [playlistTracks.playlistId, playlistTracks.trackId],
            set: { position },
        });
    return { changed: true };
}

export async function applyTrackTagUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    // entityId = "<trackSha256>:<tagName>"
    const [trackSha, tagName] = String(change.entityId).split(":");
    if (!trackSha || !tagName) {
        return { changed: false, error: "track_tags entityId must be 'trackSha:tagName'" };
    }

    const tr = await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.sha256, trackSha)))
        .limit(1);
    const tg = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, userId), eq(tags.name, tagName)))
        .limit(1);
    if (tr.length === 0 || tg.length === 0) return { changed: false, error: "Unknown track or tag" };

    if (change.op === "delete") {
        await db
            .delete(trackTags)
            .where(and(eq(trackTags.trackId, tr[0].id), eq(trackTags.tagId, tg[0].id)));
        return { changed: true };
    }
    await db
        .insert(trackTags)
        .values({ trackId: tr[0].id, tagId: tg[0].id })
        .onConflictDoNothing();
    return { changed: true };
}

/** Cuepoints — row-level LWW by (trackId, externalId). */
export async function applyCuepointUpsert(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    const payload = change.payload ?? {};
    const trackSha = String(payload.trackSha256 ?? "");
    if (!trackSha) return { changed: false, error: "cuepoints payload must include trackSha256" };
    const externalId = change.entityId;
    if (!externalId) return { changed: false, error: "Missing externalId for cuepoints" };

    const tr = await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.sha256, trackSha)))
        .limit(1);
    if (tr.length === 0) return { changed: false, error: "Unknown track for cuepoint" };

    if (change.op === "delete") {
        const existing = await db
            .select({ id: cuepoints.id, updatedAt: cuepoints.updatedAt })
            .from(cuepoints)
            .where(and(eq(cuepoints.trackId, tr[0].id), eq(cuepoints.externalId, externalId)))
            .limit(1);
        if (existing.length === 0) return { changed: false, skipped: true };
        const incomingTs = new Date(change.updatedAt);
        if (existing[0].updatedAt && existing[0].updatedAt > incomingTs) {
            return { changed: false, skipped: true, rowId: existing[0].id };
        }
        await db.delete(cuepoints).where(eq(cuepoints.id, existing[0].id));
        return { changed: true, rowId: existing[0].id };
    }

    const incomingTs = new Date(change.updatedAt);
    const existing = await db
        .select({ id: cuepoints.id, updatedAt: cuepoints.updatedAt })
        .from(cuepoints)
        .where(and(eq(cuepoints.trackId, tr[0].id), eq(cuepoints.externalId, externalId)))
        .limit(1);

    if (existing.length === 0) {
        await db.insert(cuepoints).values({
            trackId: tr[0].id,
            externalId,
            positionMs: Number(payload.positionMs ?? 0),
            kind: String(payload.kind ?? "hot"),
            label: payload.label == null ? null : String(payload.label),
            color: payload.color == null ? null : String(payload.color),
            updatedAt: incomingTs,
        });
        return { changed: true };
    }
    const row = existing[0];
    if (row.updatedAt && row.updatedAt > incomingTs) {
        return { changed: false, skipped: true, rowId: row.id };
    }
    await db
        .update(cuepoints)
        .set({
            ...(payload.positionMs !== undefined ? { positionMs: Number(payload.positionMs) } : {}),
            ...(payload.kind !== undefined ? { kind: String(payload.kind) } : {}),
            ...(payload.label !== undefined ? { label: payload.label == null ? null : String(payload.label) } : {}),
            ...(payload.color !== undefined ? { color: payload.color == null ? null : String(payload.color) } : {}),
            updatedAt: incomingTs,
        })
        .where(eq(cuepoints.id, row.id));
    return { changed: true, rowId: row.id };
}

/** Append to the per-user change log (skipped on no-op writes).
 *  `originDeviceId` lets `GET /api/sync` skip a device's own pushes. */
export async function appendSyncLog(
    userId: string,
    change: SyncChange,
    originDeviceId: string | null = null,
): Promise<void> {
    await db.insert(syncLog).values({
        userId,
        entity: change.entity,
        entityId: change.entityId,
        op: change.op,
        payload: change.payload as object | null,
        originDeviceId,
    });
}

/** Top-level dispatcher used by the route. */
export async function applyChange(
    userId: string,
    change: SyncChange,
): Promise<ApplyResult> {
    switch (change.entity) {
        case "tracks": return applyTrackUpsert(userId, change);
        case "playlists": return applyPlaylistUpsert(userId, change);
        case "tags": return applyTagUpsert(userId, change);
        case "playlist_tracks": return applyPlaylistTrackUpsert(userId, change);
        case "track_tags": return applyTrackTagUpsert(userId, change);
        case "cuepoints": return applyCuepointUpsert(userId, change);
        default:
            return { changed: false, error: `Unknown entity: ${change.entity}` };
    }
}

// Re-export `sql` so the route file can use it without a separate import.
export { sql };
