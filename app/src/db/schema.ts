import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";
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

// ─── User Preferences (also used for misc per-user settings under
//     `setting:` namespace, see actions/settings.ts) ────────────────────────

export const userPreferences = sqliteTable("user_preferences", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── User Profiles (named bundles of UI/app state per user) ─────────────────

export const userProfiles = sqliteTable("user_profiles", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

export const profilePreferences = sqliteTable("profile_preferences", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    profileId: text("profile_id").notNull().references(() => userProfiles.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ─── Devices (companion apps registered by the user) ────────────────────────

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

// ─── Types ───────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type UserPreference = typeof userPreferences.$inferSelect;
export type UserProfile = typeof userProfiles.$inferSelect;
export type ProfilePreference = typeof profilePreferences.$inferSelect;

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceFolder = typeof deviceFolders.$inferSelect;

export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;

// ─── Library Track shape ────────────────────────────────────────────────────
//
// Tracks live in the COMPANION's SQLite (see server/src/library/schema.ts).
// We keep a structural mirror here so the rest of the web app can refer to
// `Track` / `NewTrack` without a cross-package import. The shape MUST stay
// in sync with `CompanionTrack` in `@/lib/companion-library`.
export interface Track {
    id: number;
    userId: string;
    filepath: string;
    filename: string;
    artist: string | null;
    title: string | null;
    album: string | null;
    remix: string | null;
    label: string | null;
    bpm: number | null;
    keyCamelot: string | null;
    keyMusical: string | null;
    duration: number | null;
    energy: number | null;
    genre: string | null;
    subgenre: string | null;
    mood: string | null;
    color: string | null;
    vocalType: string | null;
    setPosition: string | null;
    mixability: number | null;
    isProcessed: boolean | null;
    fileSize: number | null;
    format: string | null;
    bitrate: number | null;
    sampleRate: number | null;
    addedAt: string | null;
    analyzedAt: string | null;
    rating: number | null;
    isFavorite: boolean | null;
    tags: string | null;
    artworkUrl: string | null;
    musicbrainzId: string | null;
    releaseMbid: string | null;
    isrc: string | null;
    year: number | null;
    comment: string | null;
    lyrics: string | null;
    syncedLyrics: string | null;
    isHidden: boolean | null;
    sourceUrl: string | null;
    sourcePlatform: string | null;
    sourceId: string | null;
    relatedTrackId: number | null;
    deviceId: string | null;
    isOfflineAvailable: boolean | null;
    stemsStatus: string | null;
    stemsVocalsPath: string | null;
    stemsDrumsPath: string | null;
    stemsBassPath: string | null;
    stemsMelodyPath: string | null;
    stemsAnalyzedAt: string | null;
}

export type NewTrack = Partial<Omit<Track, "id" | "userId">> & {
    filepath: string;
    filename: string;
};
