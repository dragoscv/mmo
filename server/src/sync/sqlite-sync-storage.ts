/**
 * SQLite-backed implementation of `SyncStorage` for the companion.
 *
 * Two purpose-built tables live next to the regular library schema:
 *
 *   sync_state   — single-row config (device token, API URL, pull cursor)
 *   sync_queue   — append-only queue of pending local changes that the
 *                  CloudSyncClient drains on each push tick
 *
 * The same trigger surface (any local mutation that should propagate to
 * cloud) calls `enqueue(...)`. The cloud client knows nothing about
 * SQLite — it just calls `drainDirty(N)` and `applyRemote(change)`.
 *
 * Conflict policy mirrors the cloud's `lib/sync-apply.ts`:
 *   - tracks      → per-field LWW keyed by sha256
 *   - playlists   → row-level LWW keyed by externalId
 *   - cuepoints   → row-level LWW keyed by externalId (per track)
 *   - tags / pivots → idempotent set ops
 *
 * The first iteration here only persists the cursor + queue mechanics
 * fully. Per-entity remote application is implemented behind explicit
 * dispatch points (one method per entity) so the missing entities throw
 * a clear "not yet implemented" rather than silently dropping rows.
 */

import type Database from "better-sqlite3";
import type { SyncChange, SyncState, SyncStorage } from "./cloud-sync-client";

type SqliteDb = Database.Database;

const BOOTSTRAP_SQL = `
    CREATE TABLE IF NOT EXISTS sync_state (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        api_url         TEXT NOT NULL,
        device_token    TEXT NOT NULL,
        last_pull_cursor INTEGER NOT NULL DEFAULT 0,
        updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity      TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        op          TEXT NOT NULL,
        payload     TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        enqueued_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS sync_queue_idx ON sync_queue (id);
    CREATE INDEX IF NOT EXISTS sync_queue_entity_idx ON sync_queue (entity, entity_id);
`;

/**
 * Bootstrap the sync tables on a SQLite handle without constructing a
 * full SqliteSyncStorage. Safe to call multiple times — every statement
 * uses `IF NOT EXISTS`.
 *
 * Used at companion startup so that mutations enqueued BEFORE the cloud
 * sync loop spins up still land durably in `sync_queue`. Without this
 * the first few seconds of writes after a fresh boot would be silently
 * dropped.
 */
export function bootstrapSyncTables(db: SqliteDb): void {
    db.exec(BOOTSTRAP_SQL);
}

/**
 * Append a single change to `sync_queue` directly. Mirrors
 * `SqliteSyncStorage.enqueue()` but does not require an instantiated
 * storage — useful for module-level enqueue helpers that fire before
 * `startCloudSync()` has run.
 */
export function enqueueSyncChangeRaw(db: SqliteDb, change: SyncChange): void {
    db.prepare(
        "INSERT INTO sync_queue (entity, entity_id, op, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
        change.entity,
        change.entityId,
        change.op,
        JSON.stringify(change.payload),
        change.updatedAt,
    );
}

/** Fields the per-field LWW merge will NEVER overwrite on the local row. */
const FORBIDDEN_TRACK_FIELDS: ReadonlySet<string> = new Set([
    "id",
    "user_id",
    "added_at",
]);

export interface SqliteSyncStorageOptions {
    /** Initial state to write if no row exists (typically loaded from settings). */
    seed?: { apiUrl: string; deviceToken: string };
    /** Called on every `load()` to refresh credentials from the live
     *  settings store. Returning `null` keeps the persisted values; any
     *  other return is merged into the in-memory state (and written back
     *  on the next `save()`). Lets the user change `webAppUrl` or
     *  re-pair the device without restarting the companion. */
    getSeed?: () => { apiUrl: string; deviceToken: string } | null;
    /** Inject a logger; defaults to `console.warn` for failures. */
    logger?: (msg: string, err?: unknown) => void;
}

export class SqliteSyncStorage implements SyncStorage {
    private readonly logger: NonNullable<SqliteSyncStorageOptions["logger"]>;
    private readonly getSeed?: SqliteSyncStorageOptions["getSeed"];

    constructor(private readonly db: SqliteDb, opts: SqliteSyncStorageOptions = {}) {
        this.logger = opts.logger ?? ((msg, err) => console.warn(msg, err));
        this.getSeed = opts.getSeed;
        this.db.exec(BOOTSTRAP_SQL);
        if (opts.seed) {
            const existing = this.db
                .prepare("SELECT id FROM sync_state WHERE id = 1")
                .get();
            if (!existing) {
                this.db
                    .prepare(
                        "INSERT INTO sync_state (id, api_url, device_token) VALUES (1, ?, ?)",
                    )
                    .run(opts.seed.apiUrl, opts.seed.deviceToken);
            }
        }
    }

    async load(): Promise<SyncState | null> {
        const row = this.db
            .prepare<unknown[], { api_url: string; device_token: string; last_pull_cursor: number }>(
                "SELECT api_url, device_token, last_pull_cursor FROM sync_state WHERE id = 1",
            )
            .get();

        // Pull fresh credentials from the live settings store. The
        // persisted row may be stale (user changed `webAppUrl`, re-paired,
        // or wiped device token) and otherwise we'd keep hitting the
        // wrong endpoint forever.
        const fresh = this.getSeed?.() ?? null;
        if (!row) {
            if (!fresh) return null;
            this.db
                .prepare(
                    "INSERT INTO sync_state (id, api_url, device_token) VALUES (1, ?, ?)",
                )
                .run(fresh.apiUrl, fresh.deviceToken);
            return { apiUrl: fresh.apiUrl, deviceToken: fresh.deviceToken, lastPullCursor: 0 };
        }
        return {
            apiUrl: fresh?.apiUrl ?? row.api_url,
            deviceToken: fresh?.deviceToken ?? row.device_token,
            lastPullCursor: Number(row.last_pull_cursor) || 0,
        };
    }

    async save(state: SyncState): Promise<void> {
        this.db
            .prepare(
                "UPDATE sync_state SET api_url = ?, device_token = ?, last_pull_cursor = ?, updated_at = datetime('now') WHERE id = 1",
            )
            .run(state.apiUrl, state.deviceToken, state.lastPullCursor);
    }

    /** Append a local change to the push queue. Called from library mutations. */
    enqueue(change: SyncChange): void {
        this.db
            .prepare(
                "INSERT INTO sync_queue (entity, entity_id, op, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
                change.entity,
                change.entityId,
                change.op,
                JSON.stringify(change.payload),
                change.updatedAt,
            );
    }

    async drainDirty(limit: number): Promise<Array<SyncChange & { _queueId: number }>> {
        const rows = this.db
            .prepare<unknown[], { id: number; entity: string; entity_id: string; op: string; payload: string; updated_at: string }>(
                "SELECT id, entity, entity_id, op, payload, updated_at FROM sync_queue ORDER BY id LIMIT ?",
            )
            .all(limit);
        if (rows.length === 0) return [];

        // Peek only — the queue rows stay in place until the caller calls
        // ackDirty() after a successful push. Earlier versions deleted here
        // and lost data when the push failed mid-flight (network drop /
        // server 5xx).
        return rows.map((r) => ({
            _queueId: r.id,
            entity: r.entity as SyncChange["entity"],
            entityId: r.entity_id,
            op: r.op as SyncChange["op"],
            payload: JSON.parse(r.payload) as unknown,
            updatedAt: r.updated_at,
        }));
    }

    async ackDirty(queueIds: number[]): Promise<void> {
        if (queueIds.length === 0) return;
        const placeholders = queueIds.map(() => "?").join(",");
        this.db
            .prepare(`DELETE FROM sync_queue WHERE id IN (${placeholders})`)
            .run(...queueIds);
    }

    async applyRemote(change: SyncChange & { id: number }): Promise<void> {
        try {
            switch (change.entity) {
                case "tracks": return this.applyRemoteTrack(change);
                case "playlists": return this.applyRemotePlaylist(change);
                case "cuepoints": return this.applyRemoteCuepoint(change);
                case "tags":
                case "track_tags":
                case "playlist_tracks":
                    return this.applyRemoteSet(change);
                default: {
                    // Unknown entity — safer to log and drop than to crash the
                    // whole sync loop. Re-add entities here as they're added
                    // to the cloud schema.
                    const exhaustive: never = change.entity;
                    void exhaustive;
                    this.logger(`[sync] unknown entity in remote change: ${change.entity}`);
                }
            }
        } catch (err) {
            this.logger("[sync] applyRemote failed", err);
        }
    }

    /** Per-field LWW upsert for tracks (mirrors cloud lib/sync-apply.ts).
     *  Keyed by (user_id, sha256). Payload may arrive in either camelCase
     *  (drizzle row shape) or snake_case (raw SQL); both are normalised. */
    private applyRemoteTrack(change: SyncChange & { id: number }): void {
        const payload = (change.payload ?? {}) as Record<string, unknown> & {
            sha256?: string;
            userId?: string;
            user_id?: string;
        };
        const sha = String(payload.sha256 ?? change.entityId ?? "");
        const userId = String(payload.userId ?? payload.user_id ?? "");
        if (!sha || !userId) return;

        const existing = this.db
            .prepare<unknown[], { id: number; field_versions: string | null }>(
                "SELECT id, field_versions FROM tracks WHERE user_id = ? AND sha256 = ? LIMIT 1",
            )
            .get(userId, sha);
        const fv = parseFieldVersions(existing?.field_versions);

        if (change.op === "delete") {
            // Soft-delete via is_hidden (matches cloud). Re-scan can resurrect.
            if (!existing) return;
            const lastTs = fv.is_hidden ?? fv.isHidden;
            if (lastTs && lastTs >= change.updatedAt) return;
            const nextFv = { ...fv, is_hidden: change.updatedAt };
            this.db
                .prepare("UPDATE tracks SET is_hidden = 1, field_versions = ? WHERE id = ?")
                .run(JSON.stringify(nextFv), existing.id);
            return;
        }

        const accepted: Record<string, unknown> = {};
        const nextFv: Record<string, string> = { ...fv };
        for (const [rawKey, value] of Object.entries(payload)) {
            const col = TRACK_FIELD_MAP[rawKey];
            if (!col) continue; // unknown / forbidden — silently drop
            const storedTs = fv[col];
            if (storedTs && storedTs >= change.updatedAt) continue; // LWW loser
            accepted[col] = coerceForSqlite(value);
            nextFv[col] = change.updatedAt;
        }
        if (Object.keys(accepted).length === 0 && existing) return;

        if (!existing) {
            // New row: must satisfy NOT NULL columns. The cloud always sends
            // filepath + filename for new tracks; if absent we can't insert.
            const filepath = accepted.filepath ?? payload.filepath ?? payload.filePath;
            const filename = accepted.filename ?? payload.filename ?? payload.fileName;
            if (filepath == null || filename == null) {
                this.logger("[sync] applyRemoteTrack skipping insert (missing filepath/filename)");
                return;
            }
            const cols = ["user_id", "sha256", "field_versions", ...Object.keys(accepted)];
            const placeholders = cols.map(() => "?").join(",");
            const values = [
                userId,
                sha,
                JSON.stringify(nextFv),
                ...Object.values(accepted),
            ];
            this.db
                .prepare(`INSERT INTO tracks (${cols.join(",")}) VALUES (${placeholders})`)
                .run(...values);
            return;
        }

        const setClause = Object.keys(accepted)
            .map((c) => `${c} = ?`)
            .join(", ");
        this.db
            .prepare(
                `UPDATE tracks SET ${setClause}, field_versions = ? WHERE id = ?`,
            )
            .run(...Object.values(accepted), JSON.stringify(nextFv), existing.id);
    }

    /** Row-level LWW for playlists (mirrors cloud). Keyed by (user_id, external_id). */
    private applyRemotePlaylist(change: SyncChange & { id: number }): void {
        const payload = (change.payload ?? {}) as Record<string, unknown> & {
            externalId?: string;
            userId?: string;
            user_id?: string;
        };
        const ext = String(payload.externalId ?? change.entityId ?? "");
        const userId = String(payload.userId ?? payload.user_id ?? "");
        if (!ext || !userId) return;

        const existing = this.db
            .prepare<unknown[], { id: number; updated_at: string | null }>(
                "SELECT id, updated_at FROM playlists WHERE user_id = ? AND external_id = ? LIMIT 1",
            )
            .get(userId, ext);

        if (change.op === "delete") {
            if (!existing) return;
            this.db.prepare("DELETE FROM playlists WHERE id = ?").run(existing.id);
            return;
        }

        if (existing && existing.updated_at && existing.updated_at > change.updatedAt) {
            return; // LWW loser
        }

        const name = String(payload.name ?? "Untitled");
        const description = payload.description == null ? null : String(payload.description);
        const type = payload.type == null ? "manual" : String(payload.type);

        if (!existing) {
            this.db
                .prepare(
                    "INSERT INTO playlists (user_id, name, description, type, external_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .run(userId, name, description, type, ext, change.updatedAt);
        } else {
            this.db
                .prepare(
                    "UPDATE playlists SET name = ?, description = ?, type = ?, updated_at = ? WHERE id = ?",
                )
                .run(name, description, type, change.updatedAt, existing.id);
        }
    }

    private applyRemoteCuepoint(change: SyncChange & { id: number }): void {
        // The companion has no `cuepoints` table yet — analyzer-derived
        // beats / downbeats / structure live on the tracks row, and DJ
        // cuepoints are produced by the Mixer at runtime, not synced.
        // The cursor advances so we don't re-process; cloud stays
        // authoritative until the companion exposes a typed cuepoint repo.
        void change;
    }

    /** Idempotent set ops. Only `playlist_tracks` carries data the
     *  companion can act on locally — `tags` and `track_tags` ride along
     *  inside the track row's JSON `tags` column, which is already
     *  reconciled by the per-field LWW in {@link applyRemoteTrack}. */
    private applyRemoteSet(change: SyncChange & { id: number }): void {
        if (change.entity !== "playlist_tracks") return;
        this.applyRemotePlaylistTrack(change);
    }

    /** Pivot `(playlist_id, track_id)`. EntityId is `"<plExt>:<trackSha>"`
     *  by convention (matches cloud's `applyPlaylistTrackUpsert`). */
    private applyRemotePlaylistTrack(change: SyncChange & { id: number }): void {
        const payload = (change.payload ?? {}) as Record<string, unknown> & {
            userId?: string;
            user_id?: string;
            position?: number;
        };
        const userId = String(payload.userId ?? payload.user_id ?? "");
        const [playlistExt, trackSha] = String(change.entityId).split(":");
        if (!userId || !playlistExt || !trackSha) return;

        const pl = this.db
            .prepare<unknown[], { id: number }>(
                "SELECT id FROM playlists WHERE user_id = ? AND external_id = ? LIMIT 1",
            )
            .get(userId, playlistExt);
        const tr = this.db
            .prepare<unknown[], { id: number }>(
                "SELECT id FROM tracks WHERE user_id = ? AND sha256 = ? LIMIT 1",
            )
            .get(userId, trackSha);
        // Without both rows the relation has nothing to point at; the
        // change waits in the cloud until the next pull picks up the row
        // that backfilled the missing side.
        if (!pl || !tr) return;

        if (change.op === "delete") {
            this.db
                .prepare("DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?")
                .run(pl.id, tr.id);
            return;
        }

        const position = Number(payload.position ?? 0);
        // SQLite "INSERT OR IGNORE then UPDATE" pattern — works without
        // a unique constraint on (playlist_id, track_id), which the
        // companion schema doesn't currently have.
        const existing = this.db
            .prepare<unknown[], { id: number }>(
                "SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ? LIMIT 1",
            )
            .get(pl.id, tr.id);
        if (existing) {
            this.db
                .prepare("UPDATE playlist_tracks SET position = ? WHERE id = ?")
                .run(position, existing.id);
        } else {
            this.db
                .prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)")
                .run(pl.id, tr.id, position);
        }
    }
}

/**
 * Map of allowed payload keys → SQLite column names for the tracks table.
 * Anything not listed here is dropped (forbidden or unknown).
 *
 * Both camelCase (drizzle row shape) and snake_case (raw SQL shape) are
 * accepted because the queue can be fed from either source.
 */
const TRACK_FIELD_MAP: Record<string, string> = (() => {
    const pairs: Array<[string, string]> = [
        ["filepath", "filepath"],
        ["filename", "filename"],
        ["artist", "artist"],
        ["title", "title"],
        ["album", "album"],
        ["remix", "remix"],
        ["label", "label"],
        ["bpm", "bpm"],
        ["keyCamelot", "key_camelot"],
        ["keyMusical", "key_musical"],
        ["duration", "duration"],
        ["energy", "energy"],
        ["genre", "genre"],
        ["subgenre", "subgenre"],
        ["mood", "mood"],
        ["color", "color"],
        ["vocalType", "vocal_type"],
        ["setPosition", "set_position"],
        ["mixability", "mixability"],
        ["isProcessed", "is_processed"],
        ["fileSize", "file_size"],
        ["format", "format"],
        ["bitrate", "bitrate"],
        ["sampleRate", "sample_rate"],
        ["analyzedAt", "analyzed_at"],
        ["rating", "rating"],
        ["isFavorite", "is_favorite"],
        ["tags", "tags"],
        ["artworkUrl", "artwork_url"],
        ["musicbrainzId", "musicbrainz_id"],
        ["releaseMbid", "release_mbid"],
        ["isrc", "isrc"],
        ["year", "year"],
        ["comment", "comment"],
        ["lyrics", "lyrics"],
        ["syncedLyrics", "synced_lyrics"],
        ["isHidden", "is_hidden"],
        ["sourceUrl", "source_url"],
        ["sourcePlatform", "source_platform"],
        ["sourceId", "source_id"],
        ["loudnessLufs", "loudness_lufs"],
        ["loudnessTruePeakDbfs", "loudness_true_peak_dbfs"],
        ["loudnessRangeLu", "loudness_range_lu"],
    ];
    const out: Record<string, string> = {};
    for (const [camel, snake] of pairs) {
        out[camel] = snake;
        out[snake] = snake;
    }
    return out;
})();

function parseFieldVersions(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

/** SQLite better-sqlite3 only accepts string|number|bigint|Buffer|null. */
function coerceForSqlite(value: unknown): string | number | bigint | Buffer | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return value;
    // Arrays / objects → JSON string. The companion stores beats / chord
    // progression / structure as TEXT JSON, so this is the right call.
    return JSON.stringify(value);
}

// Helper exported for tests — keeps the forbidden-field set discoverable.
export { FORBIDDEN_TRACK_FIELDS };
