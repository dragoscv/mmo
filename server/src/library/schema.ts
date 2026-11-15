/**
 * Library schema (companion-owned SQLite).
 *
 * The companion now owns the music library. Web app holds only auth +
 * device registry + recordings metadata. Each row carries `userId` so a
 * single companion install can serve multiple sign-ins on the same
 * machine (rare but cheap to support and a hard requirement for the
 * "no content when not authenticated" guarantee — content is filtered
 * by userId at every query).
 */

import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tracks = sqliteTable("tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    filepath: text("filepath").notNull(),
    filename: text("filename").notNull(),
    artist: text("artist"),
    title: text("title"),
    album: text("album"),
    remix: text("remix"),
    label: text("label"),
    bpm: real("bpm"),
    keyCamelot: text("key_camelot"),
    keyMusical: text("key_musical"),
    duration: integer("duration"),
    energy: integer("energy"),
    genre: text("genre"),
    subgenre: text("subgenre"),
    mood: text("mood"),
    color: text("color"),
    vocalType: text("vocal_type"),
    setPosition: text("set_position"),
    mixability: integer("mixability"),
    isProcessed: integer("is_processed", { mode: "boolean" }).default(false),
    fileSize: integer("file_size"),
    format: text("format"),
    bitrate: integer("bitrate"),
    sampleRate: integer("sample_rate"),
    addedAt: text("added_at").default(sql`(datetime('now'))`),
    analyzedAt: text("analyzed_at"),
    rating: integer("rating"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).default(false),
    tags: text("tags"),
    artworkUrl: text("artwork_url"),
    musicbrainzId: text("musicbrainz_id"),
    releaseMbid: text("release_mbid"),
    isrc: text("isrc"),
    year: integer("year"),
    comment: text("comment"),
    lyrics: text("lyrics"),
    syncedLyrics: text("synced_lyrics"),
    isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
    sourceUrl: text("source_url"),
    sourcePlatform: text("source_platform"),
    sourceId: text("source_id"),
    relatedTrackId: integer("related_track_id"),
    deviceId: text("device_id"),
    isOfflineAvailable: integer("is_offline_available", { mode: "boolean" }).default(false),
    stemsStatus: text("stems_status"),
    stemsVocalsPath: text("stems_vocals_path"),
    stemsDrumsPath: text("stems_drums_path"),
    stemsBassPath: text("stems_bass_path"),
    stemsMelodyPath: text("stems_melody_path"),
    stemsAnalyzedAt: text("stems_analyzed_at"),
    /** Model identifier used for the most recent stems run, e.g.
     *  "bs_roformer_ep_317_sdr_12.9755" or "htdemucs_ft". Lets the
     *  Mixer/UI tell the user "stems generated with model X" and lets
     *  the analyzer skip re-runs when the same model already produced
     *  the cache. */
    stemsModel: text("stems_model"),
    /** Last-error message when stemsStatus = "error". */
    stemsError: text("stems_error"),
    /** Integrated loudness in LUFS (BS.1770-4). Negative numbers,
     *  e.g. -14.0 for streaming-master targets. */
    loudnessLufs: real("loudness_lufs"),
    /** True-peak in dBFS as measured by pyloudnorm / ITU BS.1770-4. */
    loudnessTruePeakDbfs: real("loudness_true_peak_dbfs"),
    /** Loudness range (LRA) in LU. Useful to flag dynamics-killed masters. */
    loudnessRangeLu: real("loudness_range_lu"),
    /** Chromaprint fingerprint (base64-ish). Stable across re-encodes,
     *  so this is the canonical identity hash for the audio content. */
    acoustidFingerprint: text("acoustid_fingerprint"),
    /** AcoustID UUID returned by the lookup API. Joins to MusicBrainz. */
    acoustidId: text("acoustid_id"),
    /** Confidence (0..1) of the BPM estimate from the DSP analyzer. */
    bpmConfidence: real("bpm_confidence"),
    /** Confidence (0..1) of the key/scale estimate. */
    keyConfidence: real("key_confidence"),
    /** Beat positions in seconds, JSON array. */
    beats: text("beats"),
    /** Downbeat positions in seconds, JSON array. */
    downbeats: text("downbeats"),
    /** Beat-aligned chord progression: JSON array of
     *  `{ start: number; end: number; chord: string }`. */
    chordProgression: text("chord_progression"),
    /** Functional structure segments: JSON array of
     *  `{ start: number; end: number; label: "intro"|"verse"|"chorus"|"bridge"|"outro"|"break" }`. */
    structureSegments: text("structure_segments"),
    /** Whole-track DSP analysis timestamp (separate from external
     *  metadata `analyzedAt` so each can be re-run independently). */
    dspAnalyzedAt: text("dsp_analyzed_at"),
    /** Cloud sync key. SHA-256 of the audio file's content; identical
     *  files on different devices share a row in cloud Postgres. Nullable
     *  because legacy rows pre-date the column — backfilled lazily on
     *  next analyze pass. */
    sha256: text("sha256"),
    /** JSON-encoded `Record<columnName, ISO8601>` of per-field LWW
     *  timestamps. Used by the cloud's per-field merge so partial pushes
     *  from any device can converge without clobbering newer values. */
    fieldVersions: text("field_versions"),
    /** Quick content fingerprint — the first 16 bytes (32 hex chars) of a
     *  SHA-256 over the file size (u64 LE) + the first 256 KiB and, when the
     *  file is larger than 512 KiB, the last 256 KiB. Same value the Decks
     *  apps store as `file_hash` (`crates/decks-library/src/util.rs`), so a
     *  file on a phone finds the same cues as the server's copy. Computed at
     *  scan / ingest without decoding the audio. Indexed by (user_id, quick_hash). */
    quickHash: text("quick_hash"),
    /** Library change-feed revision. Bumped only when a *synced* field of the
     *  row changes (the favourite flag and the rating / tags the Decks apps
     *  care about). Analysis-derived columns deliberately do not bump it. */
    syncRev: integer("sync_rev").notNull().default(0),
    /** Device clock (ms since epoch) of the last *synced* change — the
     *  last-write-wins key. NULL until the row is first synced. */
    syncChangedAt: integer("sync_changed_at"),
    /** Device that made the last synced change. */
    syncChangedBy: text("sync_changed_by"),
});

export const playlists = sqliteTable("playlists", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").default("manual"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
    /** Cloud sync key (UUID). Cloud playlists are uniquely keyed by
     *  (user_id, external_id). Backfilled lazily; legacy rows surface as
     *  NULL and are pushed with a synthetic id until the next pull. */
    externalId: text("external_id"),
    /** ISO-8601 last-write timestamp for row-level LWW. */
    updatedAt: text("updated_at"),
    /** Crate tree: the parent crate's external id (NULL = root). Only used
     *  for `type = 'crate'` rows. */
    parentExternalId: text("parent_external_id"),
    /** Crate tree: 1 when the row is a folder (holds crates, no tracks). */
    isFolder: integer("is_folder", { mode: "boolean" }).default(false),
    /** Crate tree: order key among siblings (short text that sorts between
     *  its neighbours, so two devices inserting at the same spot merge). */
    sortKey: text("sort_key"),
    /** Library change-feed revision for this row (0 = never synced). */
    rev: integer("rev").notNull().default(0),
    /** Device clock (ms) of the last change to this crate (row clock). */
    changedAt: integer("changed_at"),
    /** Device that made the last change to this crate. */
    changedBy: text("changed_by"),
    /** Soft-delete marker for crates: the 30-day trash (owner 2026-11-13).
     *  A crate in the trash leaves a tombstone in the feed and can be
     *  restored from any device by re-sending an upsert with a newer clock. */
    deletedAt: integer("deleted_at"),
});

export const playlistTracks = sqliteTable("playlist_tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id").notNull(),
    trackId: integer("track_id").notNull(),
    position: integer("position").notNull(),
    /** Stable per-entry id (UUID) minted by the creating device. Lets an
     *  "add on the phone" and a "reorder on the laptop" both survive instead
     *  of "last full list wins". */
    entryId: text("entry_id"),
    /** Order key within the crate (sorts between its neighbours). */
    sortKey: text("sort_key"),
    /** Device clock of the last change (ms since epoch), LWW tie-break. */
    changedAt: integer("changed_at"),
    /** Device that made the last change. */
    changedBy: text("changed_by"),
    /** Library change-feed revision for this entry (0 = never synced). */
    rev: integer("rev").notNull().default(0),
});

/**
 * DJ cue points (hot / memory / loop), one row per cue.
 *
 * The hub copy of the data: Decks devices write here through the change feed
 * and read it back; a loop is ONE row with `start_ms` + `end_ms` (the cloud
 * table splits it into two rows until it gains an end column). `id` is a
 * UUID minted by the creating device so two devices editing different cues
 * of the same track both survive.
 */
export const trackCues = sqliteTable("track_cues", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    trackId: integer("track_id").notNull(),
    /** "hot" | "memory" | "loop". */
    kind: text("kind").notNull(),
    /** 0..7 for hot cues, NULL otherwise. */
    slot: integer("slot"),
    /** Milliseconds from the start of the decoded audio. */
    startMs: integer("start_ms").notNull(),
    /** Loop end in ms (NULL for hot / memory cues). */
    endMs: integer("end_ms"),
    colour: text("colour"),
    label: text("label"),
    /** Device clock of the last change (ms since epoch). */
    changedAt: integer("changed_at").notNull(),
    /** UUID of the device that made the last change. */
    changedBy: text("changed_by").notNull(),
    /** Library change-feed revision. */
    rev: integer("rev").notNull(),
});

/**
 * Hand-edited beat grids (one per track). A grid is one object: a change
 * wins or loses as a whole (`fixed` = the DJ locked it by hand).
 */
export const trackGrids = sqliteTable("track_grids", {
    userId: text("user_id").notNull(),
    trackId: integer("track_id").notNull(),
    bpm: real("bpm").notNull(),
    firstBeatMs: integer("first_beat_ms").notNull(),
    /** JSON array of marker ms positions. */
    markers: text("markers"),
    fixed: integer("fixed", { mode: "boolean" }).notNull().default(false),
    changedAt: integer("changed_at").notNull(),
    changedBy: text("changed_by").notNull(),
    rev: integer("rev").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.trackId] })]);

/**
 * Tombstones for the library change feed. A deleted cue / crate / entry
 * leaves a row here with the `rev` of the delete, so a device that pulls
 * `since=<rev>` learns about the deletion. Kept 180 days; a cursor older
 * than the oldest kept tombstone forces a full-state answer (`reset`).
 */
export const libraryTombstones = sqliteTable("library_tombstones", {
    userId: text("user_id").notNull(),
    /** "cue" | "grid" | "crate" | "crate_entry". */
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    rev: integer("rev").notNull(),
    changedAt: integer("changed_at").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.entity, t.entityId] })]);

/** Per-user revision counter for the library change feed. */
export const librarySyncMeta = sqliteTable("library_sync_meta", {
    userId: text("user_id").primaryKey(),
    rev: integer("rev").notNull().default(0),
    /** Highest tombstone revision already pruned. A client whose cursor is
     *  below this may have missed a tombstone, so it gets a full-state
     *  answer (`reset: true`) instead of a delta. */
    minKeptRev: integer("min_kept_rev").notNull().default(0),
});

/** Old quick hashes of a track, kept as aliases so other devices still match
 *  after a re-tag / re-encode changed the hash (D2 re-link rule). */
export const trackHashAliases = sqliteTable("track_hash_aliases", {
    userId: text("user_id").notNull(),
    quickHash: text("quick_hash").notNull(),
    trackId: integer("track_id").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.quickHash] })]);

export const scanLogs = sqliteTable("scan_logs", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    filepath: text("filepath").notNull(),
    details: text("details"),
    scannedAt: text("scanned_at").default(sql`(datetime('now'))`),
});

export const downloads = sqliteTable("downloads", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    artist: text("artist"),
    duration: integer("duration"),
    thumbnail: text("thumbnail"),
    extractor: text("extractor"),
    filePath: text("file_path"),
    fileSize: integer("file_size"),
    format: text("format"),
    quality: text("quality"),
    status: text("status").notNull().default("pending"),
    trackId: integer("track_id"),
    error: text("error"),
    downloadedAt: text("downloaded_at").default(sql`(datetime('now'))`),
});

/**
 * User-labelled physical drives. The OS already gives us the live drive
 * list (see ./drives.ts); this table just stores the human metadata
 * the user attached to each one — "My CDJ USB", "Backup HDD", etc. —
 * keyed by the drive *path* (the only field that survives an unmount /
 * remount). Per-user so two sign-ins on the same machine see their own
 * labels.
 */
export const savedDrives = sqliteTable("saved_drives", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    path: text("path").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull().default("removable"),
    format: text("format"),
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Playlist = typeof playlists.$inferSelect;
export type PlaylistTrack = typeof playlistTracks.$inferSelect;
export type ScanLog = typeof scanLogs.$inferSelect;
export type DownloadRecord = typeof downloads.$inferSelect;
export type SavedDrive = typeof savedDrives.$inferSelect;
export type TrackCue = typeof trackCues.$inferSelect;
export type NewTrackCue = typeof trackCues.$inferInsert;
export type TrackGrid = typeof trackGrids.$inferSelect;
export type NewTrackGrid = typeof trackGrids.$inferInsert;
export type LibraryTombstone = typeof libraryTombstones.$inferSelect;
