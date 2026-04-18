import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Auth.js Tables ──────────────────────────────────────────────────────────

export const users = sqliteTable("user", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name"),
    email: text("email").unique(),
    emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
    image: text("image"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const accounts = sqliteTable("account", {
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
}, (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
]);

export const sessions = sqliteTable("session", {
    sessionToken: text("sessionToken").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable("verificationToken", {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
}, (verificationToken) => [
    primaryKey({ columns: [verificationToken.identifier, verificationToken.token] }),
]);

// ─── User Preferences (per-user localStorage sync) ──────────────────────────

export const userPreferences = sqliteTable("user_preferences", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Auth Types ──────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type UserPreference = typeof userPreferences.$inferSelect;

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
    isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
    sourceUrl: text("source_url"),
    sourcePlatform: text("source_platform"),
    sourceId: text("source_id"),
    relatedTrackId: integer("related_track_id"),
    // Device/offline fields
    deviceId: text("device_id"),
    isOfflineAvailable: integer("is_offline_available", { mode: "boolean" }).default(false),
    // Stems separation
    stemsStatus: text("stems_status"), // null | "pending" | "processing" | "ready" | "error"
    stemsVocalsPath: text("stems_vocals_path"),
    stemsDrumsPath: text("stems_drums_path"),
    stemsBassPath: text("stems_bass_path"),
    stemsMelodyPath: text("stems_melody_path"),
    stemsAnalyzedAt: text("stems_analyzed_at"),
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

// ─── Download History ────────────────────────────────────────────────────────

export const downloads = sqliteTable("downloads", {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    status: text("status").notNull().default("pending"), // pending | downloading | complete | error | added
    trackId: integer("track_id").references(() => tracks.id, { onDelete: "set null" }),
    error: text("error"),
    downloadedAt: text("downloaded_at").default(sql`(datetime('now'))`),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Drive = typeof drives.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type ScanLog = typeof scanLogs.$inferSelect;
export type AnalysisJob = typeof analysisJobs.$inferSelect;
export type AnalysisChangeRecord = typeof analysisChanges.$inferSelect;
export type DownloadRecord = typeof downloads.$inferSelect;

// ─── Devices (remote companion apps) ────────────────────────────────────────

export const devices = sqliteTable("devices", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    os: text("os"), // windows | linux | macos
    hostname: text("hostname"),
    apiUrl: text("api_url").notNull(), // e.g. http://192.168.1.100:9876
    token: text("token").notNull(), // device auth token
    status: text("status").notNull().default("offline"), // online | offline | syncing
    lastSeenAt: text("last_seen_at"),
    version: text("version"),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const deviceFolders = sqliteTable("device_folders", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    label: text("label"),
    trackCount: integer("track_count").default(0),
    totalSize: integer("total_size").default(0),
    lastScannedAt: text("last_scanned_at"),
    isEnabled: integer("is_enabled", { mode: "boolean" }).default(true),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

// ─── Offline Cache Tracking ─────────────────────────────────────────────────

export const offlineTracks = sqliteTable("offline_tracks", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    trackId: integer("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    cachedAt: text("cached_at").default(sql`(datetime('now'))`),
    size: integer("size").notNull(), // bytes
    priority: integer("priority").default(0), // higher = keep longer
    isPinned: integer("is_pinned", { mode: "boolean" }).default(false),
});

// ─── Recordings (auto-saved sessions from Live, Mixer, DAW, Editor) ─────────

export const recordings = sqliteTable("recordings", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Source app: live | mixer | daw | editor */
    source: text("source").notNull(),
    /** User-editable display name (defaults to source + timestamp) */
    name: text("name").notNull(),
    /** Absolute path on disk */
    filepath: text("filepath").notNull(),
    /** Just the filename (for display + URL) */
    filename: text("filename").notNull(),
    /** MIME type (e.g. audio/webm;codecs=opus) */
    mimeType: text("mime_type").notNull(),
    /** Duration in milliseconds */
    durationMs: integer("duration_ms").notNull(),
    /** File size in bytes */
    sizeBytes: integer("size_bytes").notNull(),
    /** Optional snapshot of contextual metadata (JSON: bpm, key, scene name, etc.) */
    metadata: text("metadata"),
    /** Optional user notes */
    notes: text("notes"),
    /** User-favorited */
    isFavorite: integer("is_favorite", { mode: "boolean" }).default(false),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;

// ─── Device/Offline Types ───────────────────────────────────────────────────

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceFolder = typeof deviceFolders.$inferSelect;
export type OfflineTrack = typeof offlineTracks.$inferSelect;
