/**
 * One place that feeds the server → cloud sync queue (D7).
 *
 * The library routes and the change-feed route both record a local change and
 * then enqueue exactly one cloud change through the helpers here, so a change
 * is recorded once, not twice, and both write paths produce the same payload
 * shape. Failures are swallowed: the local write is authoritative, sync is
 * best-effort (the cloud loop drains the queue later).
 */

import { enqueueSyncChange } from "../sync";
import { and, eq } from "drizzle-orm";
import type { getLibraryDb } from "./db";
import { tracks } from "./schema";

export function enqueueTrackChange(
    op: "upsert" | "delete",
    row: { id: number; userId: string; sha256?: string | null } & Record<string, unknown>,
    extraPayload?: Record<string, unknown>,
): void {
    try {
        const sha = (row.sha256 ?? "") as string;
        const entityId = sha || `${row.userId}:${row.id}`;
        enqueueSyncChange({
            entity: "tracks",
            entityId,
            op,
            // `companionTrackId` lets the cloud round-trip the companion's
            // local row id, so the web app's write actions (rating, tags…)
            // can target the right companion track even when reads now come
            // from cloud Postgres.
            payload: { sha256: sha || undefined, ...row, companionTrackId: row.id, ...extraPayload },
            updatedAt: new Date().toISOString(),
        });
    } catch { /* sync may not be initialised yet (unpaired device) */ }
}

export function enqueuePlaylistChange(
    op: "upsert" | "delete",
    row: { id: number; userId: string } & Record<string, unknown>,
): void {
    try {
        // Playlists are keyed in cloud by externalId (UUID). Older rows without
        // one fall back to a deterministic synthetic id so the cloud can still
        // upsert; the next pull rehydrates the proper externalId.
        const ext = (row.externalId as string | undefined) || `${row.userId}:pl:${row.id}`;
        enqueueSyncChange({
            entity: "playlists",
            entityId: ext,
            op,
            payload: { externalId: ext, ...row },
            updatedAt: new Date().toISOString(),
        });
    } catch { /* see enqueueTrackChange */ }
}

export interface CueRelayInput {
    /** Cue UUID (the cloud's `external_id`). */
    id: string;
    /** Whole-file SHA-256 of the track — the cloud's key. Null = cannot relay
     *  yet (the cloud only knows tracks it has hashed); the change waits. */
    trackSha256: string | null;
    positionMs: number;
    /** "hot" | "memory" | "loop". A loop is ONE cloud row (the cloud table
     *  gained `end_ms` in phase 1). */
    kind: string;
    endMs?: number | null;
    label?: string | null;
    colour?: string | null;
}

/**
 * Relay one cue to the cloud as a `cuepoints` change.
 *
 * Skipped when the track has no whole-file SHA-256 yet — the cloud resolves a
 * cuepoint by `(userId, sha256)`, so without it the change would be rejected.
 * The next cue write, or the cloud backfill, carries it once analysis has
 * hashed the file.
 */
export function enqueueCuepointChange(op: "upsert" | "delete", cue: CueRelayInput): boolean {
    if (!cue.trackSha256) return false;
    try {
        enqueueSyncChange({
            entity: "cuepoints",
            entityId: cue.id,
            op,
            payload: op === "delete" ? { trackSha256: cue.trackSha256 } : {
                trackSha256: cue.trackSha256,
                positionMs: Math.round(cue.positionMs),
                kind: cue.kind,
                endMs: cue.endMs == null ? null : Math.round(cue.endMs),
                label: cue.label ?? null,
                color: cue.colour ?? null,
            },
            updatedAt: new Date().toISOString(),
        });
        return true;
    } catch {
        return false;
    }
}

/** The cue fields the relay needs (a `track_cues` row satisfies this). */
export interface CueRowForRelay {
    id: string;
    trackId: number;
    kind: string;
    startMs: number;
    endMs: number | null;
    label: string | null;
    colour: string | null;
}

/** Whole-file SHA-256 of a track on this server (the cloud's key), or null. */
export function shaForTrack(
    db: ReturnType<typeof getLibraryDb>, userId: string, trackId: number,
): string | null {
    const tr = db.select({ sha256: tracks.sha256 }).from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.id, trackId))).get();
    return tr?.sha256 ?? null;
}

/**
 * Relay a local cue to the cloud. Resolves the track's whole-file SHA-256 (the
 * cloud's key) and returns false when the track has none yet, so the caller can
 * leave the relay for a later write.
 */
export function relayCue(
    db: ReturnType<typeof getLibraryDb>, userId: string, cue: CueRowForRelay,
): boolean {
    return enqueueCuepointChange("upsert", {
        id: cue.id,
        trackSha256: shaForTrack(db, userId, cue.trackId),
        positionMs: cue.startMs,
        kind: cue.kind,
        endMs: cue.endMs,
        label: cue.label,
        colour: cue.colour,
    });
}

/** Relay a cue deletion to the cloud (resolves the track's hash itself). */
export function relayCueDelete(
    db: ReturnType<typeof getLibraryDb>, userId: string, trackId: number, cueId: string,
): boolean {
    return enqueueCuepointChange("delete", {
        id: cueId, trackSha256: shaForTrack(db, userId, trackId), positionMs: 0, kind: "hot",
    });
}

/**
 * Relay a playlist / crate entry change to the cloud. The cloud keys the pivot
 * by `"<playlistExternalId>:<trackSha256>"`, so this is a no-op until the track
 * has a whole-file hash.
 */
export function enqueuePlaylistTrackChange(
    op: "upsert" | "delete", playlistExt: string | null | undefined, trackSha: string | null | undefined, position: number,
): boolean {
    if (!playlistExt || !trackSha) return false;
    try {
        enqueueSyncChange({
            entity: "playlist_tracks",
            entityId: `${playlistExt}:${trackSha}`,
            op,
            payload: { position },
            updatedAt: new Date().toISOString(),
        });
        return true;
    } catch {
        return false;
    }
}
