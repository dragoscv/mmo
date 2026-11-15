/**
 * Library change feed — the server as the sync hub
 * (docs/decks/crate-sync-design.md, phase 1, decisions D4 / D5 / D7).
 *
 * One per-user revision counter (`library_sync_meta.rev`) grows with every
 * synced write; every syncable row carries the `rev` of its last change and
 * deleted rows leave a tombstone with the `rev` of the delete. A device pulls
 * `GET /library/changes?since=<rev>` and pushes a batch with
 * `POST /library/changes`.
 *
 * Conflict resolution is last-write-wins per row on the DEVICE clock
 * (`changed_at`), with `changed_by` (device id) as the tie-break — not on the
 * revision, because a change made offline carries its own time and can arrive
 * after a newer change stamped by the server. The revision is only the feed
 * cursor. The per-entity rules are the table in section 5 of the design.
 *
 * This module is pure DB logic (no network, no `../sync` import) so the same
 * cue rules can be reused by the cloud-apply path (`sqlite-sync-storage`).
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { getLibraryDb } from "./db";
import {
    tracks,
    playlists,
    playlistTracks,
    trackCues,
    trackGrids,
    libraryTombstones,
    librarySyncMeta,
    trackHashAliases,
} from "./schema";

export type LibraryDb = ReturnType<typeof getLibraryDb>;

/** Entities a client may push in a change batch. */
export const CHANGE_ENTITIES = ["favorite", "cue", "grid", "crate", "crate_entry"] as const;
export type ChangeEntity = (typeof CHANGE_ENTITIES)[number];

/** Tombstone entity names (one per row kind that can be deleted). */
export type TombstoneEntity = "cue" | "grid" | "crate" | "crate_entry";

export interface LibraryChange {
    entity: ChangeEntity;
    entityId: string;
    op: "upsert" | "delete";
    /** Device clock in ms since epoch. Missing / non-finite / non-positive is
     *  replaced by the server's now; a time in the future is cut to now. */
    changedAt?: number;
    payload?: Record<string, unknown> | null;
}

export type ChangeStatus = "applied" | "superseded" | "unknown" | "invalid";

export interface ChangeResult {
    index: number;
    entity: ChangeEntity;
    entityId: string;
    status: ChangeStatus;
    rev?: number;
    reason?: string;
}

export interface ApplyBatchResult {
    rev: number;
    results: ChangeResult[];
}

/** A cue write the caller may want to relay to the cloud. The callback keeps
 *  this module free of any `../sync` import (no cycle) while still letting the
 *  route and the cloud-apply path share the exact same conflict rules. */
export interface CueRelayPayload {
    id: string;
    trackId: number;
    kind: string;
    startMs: number;
    endMs: number | null;
    label: string | null;
    colour: string | null;
}
export type CueRelayCallback = (op: "upsert" | "delete", cue: CueRelayPayload) => void;

/** Bounds for one push (mirrors the playlist routes' style). */
export const MAX_CHANGES_PER_PUSH = 2000;
export const MAX_ROWS_PER_PAGE = 5000;
/** Tombstones are kept this long; a cursor below the oldest kept one forces
 *  a full-state answer (`reset`). */
export const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// ─── Revision counter ───────────────────────────────────────────────────────

export function getRev(db: LibraryDb, userId: string): number {
    const row = db.select({ rev: librarySyncMeta.rev }).from(librarySyncMeta)
        .where(eq(librarySyncMeta.userId, userId)).get();
    return row?.rev ?? 0;
}

export function nextRev(db: LibraryDb, userId: string): number {
    const row = db.select({ rev: librarySyncMeta.rev }).from(librarySyncMeta)
        .where(eq(librarySyncMeta.userId, userId)).get();
    const next = (row?.rev ?? 0) + 1;
    if (!row) db.insert(librarySyncMeta).values({ userId, rev: next }).run();
    else db.update(librarySyncMeta).set({ rev: next }).where(eq(librarySyncMeta.userId, userId)).run();
    return next;
}

function minKeptRev(db: LibraryDb, userId: string): number {
    const row = db.select({ v: librarySyncMeta.minKeptRev }).from(librarySyncMeta)
        .where(eq(librarySyncMeta.userId, userId)).get();
    return row?.v ?? 0;
}

// ─── Tombstones ─────────────────────────────────────────────────────────────

export function recordTombstone(
    db: LibraryDb, userId: string, entity: TombstoneEntity, entityId: string, rev: number, changedAt: number,
): void {
    db.insert(libraryTombstones).values({ userId, entity, entityId, rev, changedAt })
        .onConflictDoUpdate({
            target: [libraryTombstones.userId, libraryTombstones.entity, libraryTombstones.entityId],
            set: { rev, changedAt },
        })
        .run();
}

export function clearTombstone(db: LibraryDb, userId: string, entity: TombstoneEntity, entityId: string): void {
    db.delete(libraryTombstones)
        .where(and(
            eq(libraryTombstones.userId, userId),
            eq(libraryTombstones.entity, entity),
            eq(libraryTombstones.entityId, entityId),
        ))
        .run();
}

/**
 * Drop tombstones older than `retentionMs` and remember how far we pruned, so
 * a device whose cursor is below the pruned range gets `reset: true` instead
 * of silently missing a deletion. Returns the number of rows removed.
 */
export function pruneTombstones(
    db: LibraryDb, userId: string, now: number, retentionMs = TOMBSTONE_RETENTION_MS,
): number {
    const cutoff = now - retentionMs;
    // Remember the highest revision we are about to discard: a client whose
    // cursor is below it may have missed a deletion, so it must be told to
    // take the full state (`reset`) instead of a delta.
    const pruned = db.select({ maxRev: sql<number>`COALESCE(MAX(rev), 0)` }).from(libraryTombstones)
        .where(and(eq(libraryTombstones.userId, userId), sql`${libraryTombstones.changedAt} <= ${cutoff}`)).get();
    const prunedMax = pruned?.maxRev ?? 0;
    const removed = db.delete(libraryTombstones)
        .where(and(eq(libraryTombstones.userId, userId), sql`${libraryTombstones.changedAt} <= ${cutoff}`))
        .run().changes;
    if (removed > 0 && prunedMax > minKeptRev(db, userId)) {
        const res = db.update(librarySyncMeta).set({ minKeptRev: prunedMax })
            .where(eq(librarySyncMeta.userId, userId)).run();
        if (res.changes === 0) db.insert(librarySyncMeta).values({ userId, rev: 0, minKeptRev: prunedMax }).run();
    }
    return removed;
}

// ─── Clock helper ───────────────────────────────────────────────────────────

interface Clock { at: number; by: string }

/** Normalise the incoming clock: server now when missing, now when in the
 *  future, integer ms otherwise. */
export function normalizeClock(changedAt: unknown, deviceId: string, now: number): Clock {
    const by = deviceId || "server";
    if (typeof changedAt !== "number" || !Number.isFinite(changedAt) || changedAt <= 0) return { at: now, by };
    const t = Math.floor(changedAt);
    return { at: t > now ? now : t, by };
}

/** True when `incoming` beats the stored clock (strictly newer, or equal time
 *  with a lexicographically larger device id — the design's tie-break). */
function beats(incoming: Clock, storedAt: number | null | undefined, storedBy: string | null | undefined): boolean {
    if (storedAt == null) return true;
    if (incoming.at !== storedAt) return incoming.at > storedAt;
    return (incoming.by ?? "") > (storedBy ?? "");
}

// ─── Order keys (crate entries) ─────────────────────────────────────────────

/** Fixed-width decimal keys: sort lexicographically = numerically, always
 *  12 chars (< the design's 40-char rebalance threshold). */
export const SORT_KEY_WIDTH = 12;
const SORT_KEY_BASE = 10n ** BigInt(SORT_KEY_WIDTH);

export function formatSortKey(n: bigint): string {
    const clamped = n < 0n ? 0n : n >= SORT_KEY_BASE ? SORT_KEY_BASE - 1n : n;
    return clamped.toString().padStart(SORT_KEY_WIDTH, "0");
}

export function parseSortKey(key: string | null | undefined): bigint | null {
    if (!key || !/^\d+$/.test(key)) return null;
    try { return BigInt(key); } catch { return null; }
}

/** A key strictly between `prev` and `next` (each null = unbounded), or null
 *  when there is no room left and the caller must rebalance the crate. */
export function keyBetween(prev: string | null, next: string | null): string | null {
    const lo = prev == null ? 0n : parseSortKey(prev);
    const hi = next == null ? SORT_KEY_BASE : parseSortKey(next);
    if (lo == null || hi == null) return null;
    if (hi - lo <= 1n) return null;
    return formatSortKey((lo + hi) / 2n);
}

/** Evenly spread keys for `count` entries, so a crate can be re-keyed when
 *  two neighbours have no room between them. */
export function rebalancedKeys(count: number): string[] {
    if (count <= 0) return [];
    const step = SORT_KEY_BASE / BigInt(count + 1);
    const out: string[] = [];
    for (let i = 1; i <= count; i++) out.push(formatSortKey(step * BigInt(i)));
    return out;
}

// ─── Track resolution ───────────────────────────────────────────────────────

/** Resolve a server track id from an explicit id, a quick hash (current or an
 *  alias of a re-tagged file), or the whole-file SHA-256 the cloud keys by. */
export function resolveTrackId(
    db: LibraryDb, userId: string, trackId: unknown, quickHash: unknown, trackSha256?: unknown,
): number | null {
    if (typeof trackId === "number" && Number.isInteger(trackId) && trackId > 0) {
        const row = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.userId, userId), eq(tracks.id, trackId))).get();
        if (row) return row.id;
    }
    if (typeof quickHash === "string" && /^[0-9a-f]{32}$/.test(quickHash)) {
        const direct = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.userId, userId), eq(tracks.quickHash, quickHash))).get();
        if (direct) return direct.id;
        const alias = db.select({ trackId: trackHashAliases.trackId }).from(trackHashAliases)
            .where(and(eq(trackHashAliases.userId, userId), eq(trackHashAliases.quickHash, quickHash))).get();
        if (alias) return alias.trackId;
    }
    if (typeof trackSha256 === "string" && /^[0-9a-f]{64}$/.test(trackSha256)) {
        const row = db.select({ id: tracks.id }).from(tracks)
            .where(and(eq(tracks.userId, userId), eq(tracks.sha256, trackSha256))).get();
        if (row) return row.id;
    }
    return null;
}

// ─── Per-entity apply ───────────────────────────────────────────────────────

function applyFavorite(db: LibraryDb, userId: string, c: LibraryChange, clock: Clock, index: number): ChangeResult {
    const base = { index, entity: c.entity, entityId: c.entityId };
    const id = Number(c.entityId);
    if (!Number.isInteger(id) || id <= 0) return { ...base, status: "invalid", reason: "entityId must be a track id" };
    const row = db.select().from(tracks).where(and(eq(tracks.userId, userId), eq(tracks.id, id))).get();
    if (!row) return { ...base, status: "unknown", reason: "track not on this server" };
    if (!beats(clock, row.syncChangedAt, row.syncChangedBy)) return { ...base, status: "superseded" };
    const want = c.op === "delete" ? false : (c.payload?.isFavorite !== false);
    const rev = nextRev(db, userId);
    db.update(tracks)
        .set({ isFavorite: want, syncRev: rev, syncChangedAt: clock.at, syncChangedBy: clock.by })
        .where(and(eq(tracks.userId, userId), eq(tracks.id, id)))
        .run();
    return { ...base, status: "applied", rev };
}

function applyCue(
    db: LibraryDb, userId: string, c: LibraryChange, clock: Clock, index: number, onCue?: CueRelayCallback,
): ChangeResult {
    const base = { index, entity: c.entity, entityId: c.entityId };
    const existing = db.select().from(trackCues)
        .where(and(eq(trackCues.userId, userId), eq(trackCues.id, c.entityId))).get();

    if (c.op === "delete") {
        if (!existing) return { ...base, status: "superseded", reason: "already gone" };
        if (!beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
        const rev = nextRev(db, userId);
        db.delete(trackCues).where(and(eq(trackCues.userId, userId), eq(trackCues.id, c.entityId))).run();
        recordTombstone(db, userId, "cue", c.entityId, rev, clock.at);
        onCue?.("delete", {
            id: existing.id, trackId: existing.trackId, kind: existing.kind,
            startMs: existing.startMs, endMs: existing.endMs, label: existing.label, colour: existing.colour,
        });
        return { ...base, status: "applied", rev };
    }

    const p = c.payload ?? {};
    const trackId = resolveTrackId(db, userId, p.trackId ?? p.serverTrackId, p.quickHash ?? p.quick_hash);
    if (trackId == null) return { ...base, status: "unknown", reason: "track not on this server" };
    if (existing && !beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };

    const kindIn = String(p.kind ?? existing?.kind ?? "hot");
    const kind: "hot" | "memory" | "loop" = kindIn === "loop" ? "loop" : kindIn === "memory" ? "memory" : "hot";
    const slotIn = p.slot ?? existing?.slot ?? null;
    const slot = kind === "hot" && typeof slotIn === "number" && Number.isInteger(slotIn) && slotIn >= 0 && slotIn <= 7
        ? slotIn : null;
    if (kind === "hot" && slot == null) return { ...base, status: "invalid", reason: "hot cue needs slot 0..7" };
    const startMs = Number(p.startMs ?? p.start_ms ?? existing?.startMs ?? 0);
    if (!Number.isFinite(startMs)) return { ...base, status: "invalid", reason: "startMs must be a number" };
    const rawEnd = p.endMs ?? p.end_ms ?? existing?.endMs ?? null;
    const endMs = rawEnd == null ? null : Number(rawEnd);
    if (endMs != null && !Number.isFinite(endMs)) return { ...base, status: "invalid", reason: "endMs must be a number" };
    const colour = (p.colour ?? p.color ?? existing?.colour ?? null) as string | null;
    let label = (p.label ?? existing?.label ?? null) as string | null;

    const rev = nextRev(db, userId);
    let finalKind = kind;
    let finalSlot = slot;

    // Two cues claiming one hot slot: the later one takes it, the earlier one
    // is kept as a MEMORY cue labelled with its old slot (D4 / question 4).
    if (kind === "hot" && slot != null) {
        const rival = db.select().from(trackCues)
            .where(and(
                eq(trackCues.userId, userId),
                eq(trackCues.trackId, trackId),
                eq(trackCues.kind, "hot"),
                eq(trackCues.slot, slot),
            )).all().find((r) => r.id !== c.entityId);
        if (rival) {
            if (beats(clock, rival.changedAt, rival.changedBy)) {
                // We win the slot: demote the rival to a memory cue.
                const rivalLabel = rival.label && rival.label.trim().length > 0
                    ? rival.label : `Hot ${(slot) + 1}`;
                db.update(trackCues)
                    .set({ kind: "memory", slot: null, label: rivalLabel, rev, changedAt: clock.at, changedBy: clock.by })
                    .where(and(eq(trackCues.userId, userId), eq(trackCues.id, rival.id)))
                    .run();
            } else {
                // We lose the slot: keep ourselves as a memory cue.
                finalKind = "memory";
                finalSlot = null;
                if (!label || label.trim().length === 0) label = `Hot ${slot + 1}`;
            }
        }
    }

    if (existing) {
        db.update(trackCues)
            .set({
                trackId, kind: finalKind, slot: finalSlot, startMs: Math.round(startMs),
                endMs: endMs == null ? null : Math.round(endMs), colour, label,
                changedAt: clock.at, changedBy: clock.by, rev,
            })
            .where(and(eq(trackCues.userId, userId), eq(trackCues.id, c.entityId)))
            .run();
    } else {
        db.insert(trackCues).values({
            id: c.entityId, userId, trackId, kind: finalKind, slot: finalSlot,
            startMs: Math.round(startMs), endMs: endMs == null ? null : Math.round(endMs),
            colour, label, changedAt: clock.at, changedBy: clock.by, rev,
        }).run();
    }
    clearTombstone(db, userId, "cue", c.entityId);
    onCue?.("upsert", {
        id: c.entityId, trackId, kind: finalKind, startMs: Math.round(startMs),
        endMs: endMs == null ? null : Math.round(endMs), label, colour,
    });
    return { ...base, status: "applied", rev };
}

function applyGrid(db: LibraryDb, userId: string, c: LibraryChange, clock: Clock, index: number): ChangeResult {
    const base = { index, entity: c.entity, entityId: c.entityId };
    const id = Number(c.entityId);
    if (!Number.isInteger(id) || id <= 0) return { ...base, status: "invalid", reason: "entityId must be a track id" };
    const trackRow = db.select({ id: tracks.id }).from(tracks)
        .where(and(eq(tracks.userId, userId), eq(tracks.id, id))).get();
    if (!trackRow) return { ...base, status: "unknown", reason: "track not on this server" };
    const existing = db.select().from(trackGrids)
        .where(and(eq(trackGrids.userId, userId), eq(trackGrids.trackId, id))).get();

    if (c.op === "delete") {
        if (!existing) return { ...base, status: "superseded", reason: "already gone" };
        if (!beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
        const rev = nextRev(db, userId);
        db.delete(trackGrids).where(and(eq(trackGrids.userId, userId), eq(trackGrids.trackId, id))).run();
        recordTombstone(db, userId, "grid", c.entityId, rev, clock.at);
        return { ...base, status: "applied", rev };
    }

    if (existing && !beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
    const p = c.payload ?? {};
    const bpm = Number(p.bpm);
    const firstBeatMs = Number(p.firstBeatMs ?? p.first_beat_ms);
    if (!Number.isFinite(bpm) || !Number.isFinite(firstBeatMs)) {
        return { ...base, status: "invalid", reason: "bpm and firstBeatMs are required numbers" };
    }
    const markers = p.markers == null ? null
        : typeof p.markers === "string" ? p.markers : JSON.stringify(p.markers);
    const fixed = p.fixed === true || p.fixed === 1;
    const rev = nextRev(db, userId);
    if (existing) {
        db.update(trackGrids).set({ bpm, firstBeatMs: Math.round(firstBeatMs), markers, fixed, changedAt: clock.at, changedBy: clock.by, rev })
            .where(and(eq(trackGrids.userId, userId), eq(trackGrids.trackId, id))).run();
    } else {
        db.insert(trackGrids).values({ userId, trackId: id, bpm, firstBeatMs: Math.round(firstBeatMs), markers, fixed, changedAt: clock.at, changedBy: clock.by, rev }).run();
    }
    clearTombstone(db, userId, "grid", c.entityId);
    return { ...base, status: "applied", rev };
}

function findCrate(db: LibraryDb, userId: string, externalId: string) {
    return db.select().from(playlists)
        .where(and(eq(playlists.userId, userId), eq(playlists.externalId, externalId))).get();
}

function applyCrate(db: LibraryDb, userId: string, c: LibraryChange, clock: Clock, index: number): ChangeResult {
    const base = { index, entity: c.entity, entityId: c.entityId };
    if (!c.entityId) return { ...base, status: "invalid", reason: "entityId must be the crate external id" };
    const existing = findCrate(db, userId, c.entityId);

    if (c.op === "delete") {
        if (!existing) return { ...base, status: "superseded", reason: "already gone" };
        if (!beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
        const rev = nextRev(db, userId);
        // Soft delete: a 30-day trash (owner 2026-11-13). Entries stay so a
        // restore brings the crate back whole.
        db.update(playlists).set({ deletedAt: clock.at, changedAt: clock.at, changedBy: clock.by, rev })
            .where(and(eq(playlists.userId, userId), eq(playlists.id, existing.id))).run();
        recordTombstone(db, userId, "crate", c.entityId, rev, clock.at);
        return { ...base, status: "applied", rev };
    }

    if (existing && !beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
    const p = c.payload ?? {};
    const name = String(p.name ?? existing?.name ?? "Crate").slice(0, 200);
    const parent = p.parentExternalId == null ? null : String(p.parentExternalId);
    const isFolder = p.isFolder === true || p.isFolder === 1;
    const sortKey = p.sortKey == null ? (existing?.sortKey ?? null) : String(p.sortKey);
    const rev = nextRev(db, userId);
    if (existing) {
        db.update(playlists)
            .set({ name, parentExternalId: parent, isFolder, sortKey, type: "crate", deletedAt: null, changedAt: clock.at, changedBy: clock.by, rev, updatedAt: new Date(clock.at).toISOString() })
            .where(and(eq(playlists.userId, userId), eq(playlists.id, existing.id))).run();
    } else {
        db.insert(playlists).values({
            userId, name, type: "crate", externalId: c.entityId, parentExternalId: parent,
            isFolder, sortKey, deletedAt: null, changedAt: clock.at, changedBy: clock.by, rev,
            updatedAt: new Date(clock.at).toISOString(),
        }).run();
    }
    clearTombstone(db, userId, "crate", c.entityId);
    return { ...base, status: "applied", rev };
}

function applyCrateEntry(db: LibraryDb, userId: string, c: LibraryChange, clock: Clock, index: number): ChangeResult {
    const base = { index, entity: c.entity, entityId: c.entityId };
    if (!c.entityId) return { ...base, status: "invalid", reason: "entityId must be the entry id" };
    const existing = db.select().from(playlistTracks)
        .where(and(eq(playlistTracks.entryId, c.entityId), sql`${playlistTracks.playlistId} IN (SELECT id FROM playlists WHERE user_id = ${userId})`))
        .get();

    if (c.op === "delete") {
        if (!existing) return { ...base, status: "superseded", reason: "already gone" };
        if (existing.changedAt != null && !beats(clock, existing.changedAt, existing.changedBy)) {
            return { ...base, status: "superseded" };
        }
        const rev = nextRev(db, userId);
        db.delete(playlistTracks).where(eq(playlistTracks.id, existing.id)).run();
        recordTombstone(db, userId, "crate_entry", c.entityId, rev, clock.at);
        // Removing an entry is a change to the crate: advance its clock so a
        // concurrent "crate deleted later" comparison is order-independent.
        const crate = db.select().from(playlists).where(eq(playlists.id, existing.playlistId)).get();
        if (crate) touchCrate(db, crate, clock, rev);
        return { ...base, status: "applied", rev };
    }

    const p = c.payload ?? {};
    const crateExt = String(p.crateExternalId ?? p.crate_external_id ?? "");
    const crate = crateExt ? findCrate(db, userId, crateExt) : null;
    if (!crate) return { ...base, status: "unknown", reason: "crate not on this server" };
    const trackId = resolveTrackId(db, userId, p.trackId ?? p.serverTrackId, p.quickHash);
    if (trackId == null) return { ...base, status: "unknown", reason: "track not on this server" };
    if (existing && !beats(clock, existing.changedAt, existing.changedBy)) return { ...base, status: "superseded" };
    // "Crate deleted on A, track added on B": the later of the two wins. A
    // newer entry revives a crate trashed earlier.
    if (crate.deletedAt != null && !beats(clock, crate.changedAt, crate.changedBy)) {
        return { ...base, status: "superseded", reason: "crate deleted later" };
    }

    const rev = nextRev(db, userId);
    if (crate.deletedAt != null) {
        db.update(playlists).set({ deletedAt: null, changedAt: clock.at, changedBy: clock.by, rev })
            .where(eq(playlists.id, crate.id)).run();
        // Out of the trash: the crate's tombstone must go too, or the feed
        // would still report it as deleted.
        clearTombstone(db, userId, "crate", crateExt);
    } else {
        touchCrate(db, crate, clock, rev);
    }
    let sortKey = p.sortKey == null ? existing?.sortKey ?? null : String(p.sortKey);
    if (sortKey == null) sortKey = appendSortKey(db, crate.id);
    if (existing) {
        db.update(playlistTracks).set({ sortKey, changedAt: clock.at, changedBy: clock.by, rev })
            .where(eq(playlistTracks.id, existing.id)).run();
    } else {
        db.insert(playlistTracks).values({
            playlistId: crate.id, trackId, position: 0, entryId: c.entityId,
            sortKey, changedAt: clock.at, changedBy: clock.by, rev,
        }).run();
    }
    renumberCrate(db, crate.id);
    return { ...base, status: "applied", rev };
}

/** Advance a crate's row clock (and revision) when the incoming change is the
 *  newer of the two, so entry edits count as crate changes. */
function touchCrate(
    db: LibraryDb, crate: { id: number; changedAt: number | null; changedBy: string | null }, clock: Clock, rev: number,
): void {
    if (!beats(clock, crate.changedAt, crate.changedBy)) return;
    db.update(playlists).set({ changedAt: clock.at, changedBy: clock.by, rev })
        .where(eq(playlists.id, crate.id)).run();
}

/** Next order key at the tail of a crate, rebalancing when there is no room. */
export function appendSortKey(db: LibraryDb, crateId: number): string {
    const last = db.select({ sortKey: playlistTracks.sortKey }).from(playlistTracks)
        .where(eq(playlistTracks.playlistId, crateId))
        .orderBy(sql`sort_key DESC`).limit(1).get();
    const key = keyBetween(last?.sortKey ?? null, null);
    if (key) return key;
    rebalanceCrate(db, crateId);
    const after = db.select({ sortKey: playlistTracks.sortKey }).from(playlistTracks)
        .where(eq(playlistTracks.playlistId, crateId))
        .orderBy(sql`sort_key DESC`).limit(1).get();
    return keyBetween(after?.sortKey ?? null, null) ?? formatSortKey(SORT_KEY_BASE - 1n);
}

/** Re-key a crate's entries evenly, in their current order (one write per
 *  entry; used only when two neighbour keys have no room between them). */
export function rebalanceCrate(db: LibraryDb, crateId: number): void {
    const rows = db.select({ id: playlistTracks.id }).from(playlistTracks)
        .where(eq(playlistTracks.playlistId, crateId))
        .orderBy(sql`sort_key ASC`).all();
    const keys = rebalancedKeys(rows.length);
    rows.forEach((r, i) => {
        db.update(playlistTracks).set({ sortKey: keys[i] }).where(eq(playlistTracks.id, r.id)).run();
    });
}

/** Mirror the order keys into the legacy `position` column so the existing
 *  playlist routes keep returning the crate in the right order. */
export function renumberCrate(db: LibraryDb, crateId: number): void {
    const rows = db.select({ id: playlistTracks.id }).from(playlistTracks)
        .where(eq(playlistTracks.playlistId, crateId))
        .orderBy(sql`sort_key ASC, id ASC`).all();
    rows.forEach((r, i) => {
        db.update(playlistTracks).set({ position: i + 1 }).where(eq(playlistTracks.id, r.id)).run();
    });
}

// ─── Batch apply ────────────────────────────────────────────────────────────

export function applyChanges(
    db: LibraryDb, userId: string, deviceId: string, changes: LibraryChange[], now = Date.now(),
    onCue?: CueRelayCallback,
): ApplyBatchResult {
    const results: ChangeResult[] = [];
    changes.forEach((c, index) => {
        const clock = normalizeClock(c.changedAt, deviceId, now);
        try {
            switch (c.entity) {
                case "favorite": results.push(applyFavorite(db, userId, c, clock, index)); break;
                case "cue": results.push(applyCue(db, userId, c, clock, index, onCue)); break;
                case "grid": results.push(applyGrid(db, userId, c, clock, index)); break;
                case "crate": results.push(applyCrate(db, userId, c, clock, index)); break;
                case "crate_entry": results.push(applyCrateEntry(db, userId, c, clock, index)); break;
                default: results.push({ index, entity: c.entity, entityId: c.entityId, status: "invalid", reason: "unknown entity" });
            }
        } catch (err) {
            results.push({
                index, entity: c.entity, entityId: c.entityId, status: "invalid",
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    });
    return { rev: getRev(db, userId), results };
}

// ─── Read side ──────────────────────────────────────────────────────────────

export interface FeedTrack { trackId: number; quickHash: string | null; isFavorite: boolean; rev: number }
export interface FeedCue {
    id: string; trackId: number; kind: string; slot: number | null;
    startMs: number; endMs: number | null; colour: string | null; label: string | null; rev: number;
}
export interface FeedGrid { trackId: number; bpm: number; firstBeatMs: number; markers: string | null; fixed: boolean; rev: number }
export interface FeedCrate {
    externalId: string; name: string; parentExternalId: string | null;
    isFolder: boolean; sortKey: string | null; rev: number;
}
export interface FeedCrateEntry { entryId: string; crateExternalId: string; trackId: number; sortKey: string | null; rev: number }
export interface FeedTombstone { entity: string; entityId: string; rev: number }

export interface LibraryChanges {
    rev: number;
    reset: boolean;
    tracks: FeedTrack[];
    cues: FeedCue[];
    grids: FeedGrid[];
    crates: FeedCrate[];
    crateEntries: FeedCrateEntry[];
    tombstones: FeedTombstone[];
}

/** Rows with `rev > since` plus the tombstones. `since <= 0` (a fresh client)
 *  and a cursor below the pruned tombstones both answer the full state; the
 *  latter sets `reset: true` so the client knows to replace, not merge. */
export function getChanges(db: LibraryDb, userId: string, since: number): LibraryChanges {
    const rev = getRev(db, userId);
    const reset = since > 0 && since < minKeptRev(db, userId);
    const full = since <= 0 || reset;
    const after = full ? 0 : since;
    const trackRows = db.select({
        trackId: tracks.id, quickHash: tracks.quickHash, isFavorite: tracks.isFavorite, rev: tracks.syncRev,
    }).from(tracks)
        .where(and(eq(tracks.userId, userId), gt(tracks.syncRev, after)))
        .limit(MAX_ROWS_PER_PAGE).all();

    const cueRows = db.select().from(trackCues)
        .where(and(eq(trackCues.userId, userId), gt(trackCues.rev, after)))
        .limit(MAX_ROWS_PER_PAGE).all();

    const gridRows = db.select().from(trackGrids)
        .where(and(eq(trackGrids.userId, userId), gt(trackGrids.rev, after)))
        .limit(MAX_ROWS_PER_PAGE).all();

    const crateRows = db.select().from(playlists)
        .where(and(eq(playlists.userId, userId), eq(playlists.type, "crate"), gt(playlists.rev, after)))
        .limit(MAX_ROWS_PER_PAGE).all();

    const crateIds = db.select({ id: playlists.id, ext: playlists.externalId }).from(playlists)
        .where(and(eq(playlists.userId, userId), eq(playlists.type, "crate"))).all();
    const extById = new Map(crateIds.map((r) => [r.id, r.ext ?? ""]));

    const entryRows = crateIds.length === 0 ? [] : db.select().from(playlistTracks)
        .where(and(
            inArray(playlistTracks.playlistId, crateIds.map((r) => r.id)),
            gt(playlistTracks.rev, after),
        ))
        .orderBy(sql`sort_key ASC, id ASC`)
        .limit(MAX_ROWS_PER_PAGE).all();

    const tombRows = db.select().from(libraryTombstones)
        .where(and(eq(libraryTombstones.userId, userId), gt(libraryTombstones.rev, after)))
        .limit(MAX_ROWS_PER_PAGE).all();

    return {
        rev,
        reset,
        tracks: trackRows.map((r) => ({ trackId: r.trackId, quickHash: r.quickHash, isFavorite: !!r.isFavorite, rev: r.rev })),
        cues: cueRows.map((r) => ({
            id: r.id, trackId: r.trackId, kind: r.kind, slot: r.slot,
            startMs: r.startMs, endMs: r.endMs, colour: r.colour, label: r.label, rev: r.rev,
        })),
        grids: gridRows.map((r) => ({ trackId: r.trackId, bpm: r.bpm, firstBeatMs: r.firstBeatMs, markers: r.markers, fixed: !!r.fixed, rev: r.rev })),
        crates: crateRows.map((r) => ({
            externalId: r.externalId ?? "", name: r.name, parentExternalId: r.parentExternalId,
            isFolder: !!r.isFolder, sortKey: r.sortKey, rev: r.rev,
        })),
        crateEntries: entryRows.map((r) => ({
            entryId: r.entryId ?? `pt:${r.id}`, crateExternalId: extById.get(r.playlistId) ?? "",
            trackId: r.trackId, sortKey: r.sortKey, rev: r.rev,
        })),
        tombstones: tombRows.map((r) => ({ entity: r.entity, entityId: r.entityId, rev: r.rev })),
    };
}

// ─── Validation of an incoming batch ────────────────────────────────────────

export function validateChange(c: unknown): { ok: true; value: LibraryChange } | { ok: false; error: string } {
    if (!c || typeof c !== "object") return { ok: false, error: "change must be an object" };
    const r = c as Record<string, unknown>;
    if (typeof r.entity !== "string" || !(CHANGE_ENTITIES as readonly string[]).includes(r.entity)) {
        return { ok: false, error: `entity must be one of ${CHANGE_ENTITIES.join(", ")}` };
    }
    if (typeof r.entityId !== "string" || r.entityId.length === 0 || r.entityId.length > 128) {
        return { ok: false, error: "entityId must be a 1..128 char string" };
    }
    if (r.op !== "upsert" && r.op !== "delete") return { ok: false, error: "op must be 'upsert' or 'delete'" };
    if (r.changedAt !== undefined && (typeof r.changedAt !== "number" || !Number.isFinite(r.changedAt))) {
        return { ok: false, error: "changedAt must be a number (ms since epoch)" };
    }
    return { ok: true, value: r as unknown as LibraryChange };
}
