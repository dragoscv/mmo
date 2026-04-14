import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const tracks = sqliteTable("tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filepath: text("filepath").notNull().unique(),
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
    // New columns for enhanced management
    rating: integer("rating"),
    isFavorite: integer("is_favorite", { mode: "boolean" }).default(false),
    tags: text("tags"), // JSON array of tag strings
    artworkUrl: text("artwork_url"),
    musicbrainzId: text("musicbrainz_id"),
    releaseMbid: text("release_mbid"),
    isrc: text("isrc"),
    year: integer("year"),
    comment: text("comment"),
    lyrics: text("lyrics"),
    syncedLyrics: text("synced_lyrics"),
});

export const drives = sqliteTable("drives", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").notNull().unique(),
    label: text("label"),
    type: text("type").notNull(),
    format: text("format"),
    isActive: integer("is_active", { mode: "boolean" }).default(true),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const playlists = sqliteTable("playlists", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").default("manual"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const playlistTracks = sqliteTable("playlist_tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: integer("playlist_id").references(() => playlists.id, {
        onDelete: "cascade",
    }),
    trackId: integer("track_id").references(() => tracks.id, {
        onDelete: "cascade",
    }),
    position: integer("position").notNull(),
});

export const scanLogs = sqliteTable("scan_logs", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    action: text("action").notNull(),
    filepath: text("filepath").notNull(),
    details: text("details"),
    scannedAt: text("scanned_at").default(sql`(datetime('now'))`),
});

export const settings = sqliteTable("settings", {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
});

// ─── Analysis Job Tracking ───────────────────────────────────────────────────

export const analysisJobs = sqliteTable("analysis_jobs", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    status: text("status").notNull().default("idle"),
    mode: text("mode").notNull(),
    options: text("options").notNull(),
    progress: integer("progress").default(0),
    total: integer("total").default(0),
    currentTrack: text("current_track"),
    changesCount: integer("changes_count").default(0),
    errorsCount: integer("errors_count").default(0),
    errors: text("errors"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const analysisChanges = sqliteTable("analysis_changes", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id").notNull(),
    trackId: integer("track_id").notNull(),
    trackArtist: text("track_artist").notNull(),
    trackTitle: text("track_title").notNull(),
    field: text("field").notNull(),
    fieldLabel: text("field_label").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value").notNull(),
    source: text("source").notNull(),
    checked: integer("checked", { mode: "boolean" }).default(false),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Drive = typeof drives.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type ScanLog = typeof scanLogs.$inferSelect;
export type AnalysisJob = typeof analysisJobs.$inferSelect;
export type AnalysisChangeRecord = typeof analysisChanges.$inferSelect;
