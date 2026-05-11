/**
 * Postgres schema (Cloud SQL / Neon / local docker postgres).
 *
 * This is the source-of-truth schema. The companion app keeps a local
 * SQLite mirror (see `server/src/library/schema.ts`) for offline work and
 * for owning the actual audio files on disk; metadata flows up to here via
 * the `/api/sync` endpoints.
 *
 * Tables exported with the SAME names as the previous SQLite schema
 * (`users`, `accounts`, `sessions`, `verificationTokens`,
 * `userPreferences`, `userProfiles`, `profilePreferences`,
 * `devices`, `deviceFolders`, `recordings`) so the rest of the app
 * compiles unchanged. New tables: `subscriptions`, `tracks`, `playlists`,
 * `playlistTracks`, `tags`, `trackTags`, `cuepoints`.
 */

import {
    pgTable,
    text,
    integer,
    bigint,
    boolean,
    timestamp,
    primaryKey,
    serial,
    real,
    jsonb,
    uniqueIndex,
    index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Auth.js Tables ──────────────────────────────────────────────────────────
// Drizzle's official Auth.js adapter expects these exact table + column names.

export const users = pgTable("user", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name"),
    email: text("email").unique(),
    emailVerified: timestamp("emailVerified", { mode: "date" }),
    image: text("image"),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

export const accounts = pgTable(
    "account",
    {
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
    },
    (account) => [primaryKey({ columns: [account.provider, account.providerAccountId] })],
);

export const sessions = pgTable("session", {
    sessionToken: text("sessionToken").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
    "verificationToken",
    {
        identifier: text("identifier").notNull(),
        token: text("token").notNull(),
        expires: timestamp("expires", { mode: "date" }).notNull(),
    },
    (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

// ─── User preferences & profiles ────────────────────────────────────────────

export const userPreferences = pgTable(
    "user_preferences",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        key: text("key").notNull(),
        value: text("value").notNull(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [uniqueIndex("user_pref_uniq").on(t.userId, t.key)],
);

export const userProfiles = pgTable("user_profiles", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

export const profilePreferences = pgTable(
    "profile_preferences",
    {
        id: serial("id").primaryKey(),
        profileId: text("profile_id").notNull().references(() => userProfiles.id, { onDelete: "cascade" }),
        key: text("key").notNull(),
        value: text("value").notNull(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [uniqueIndex("profile_pref_uniq").on(t.profileId, t.key)],
);

// ─── Companion devices ──────────────────────────────────────────────────────

export const devices = pgTable("devices", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    os: text("os"),
    hostname: text("hostname"),
    apiUrl: text("api_url").notNull(),
    /** HMAC-SHA256 of the plaintext bearer (hex). Indexable equality key
     *  used for inbound auth lookups. Populated by `issueDeviceToken()`. */
    tokenHash: text("token_hash").unique(),
    /** AES-256-GCM ciphertext envelope of the plaintext bearer
     *  ("v1:b64(nonce):b64(ciphertext+tag)"). Decrypted on demand for
     *  outbound `X-Device-Token` use. Key is derived from AUTH_SECRET. */
    tokenEncrypted: text("token_encrypted"),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    version: text("version"),
    /** Sync cursor — server-side monotonic counter the device has fully consumed. */
    syncCursor: bigint("sync_cursor", { mode: "number" }).default(0),
    createdAt: timestamp("created_at").defaultNow(),
});

export const deviceFolders = pgTable("device_folders", {
    id: serial("id").primaryKey(),
    deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    label: text("label"),
    trackCount: integer("track_count").default(0),
    totalSize: bigint("total_size", { mode: "number" }).default(0),
    lastScannedAt: timestamp("last_scanned_at"),
    isEnabled: boolean("is_enabled").default(true),
    createdAt: timestamp("created_at").defaultNow(),
});

// ─── Recordings (file body lives in GCS — gcs_object_key) ───────────────────

export const recordings = pgTable("recordings", {
    id: serial("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    name: text("name").notNull(),
    /** Legacy: absolute path on the recording machine (companion mode). */
    filepath: text("filepath").notNull(),
    /** Just the filename (display + URL). */
    filename: text("filename").notNull(),
    /** GCS object key when uploaded to cloud storage; null if local-only. */
    gcsObjectKey: text("gcs_object_key"),
    mimeType: text("mime_type").notNull(),
    durationMs: integer("duration_ms").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    metadata: jsonb("metadata"),
    notes: text("notes"),
    isFavorite: boolean("is_favorite").default(false),
    createdAt: timestamp("created_at").defaultNow(),
});

// ─── Library (cloud-side mirror of companion tracks) ────────────────────────

export const tracks = pgTable(
    "tracks",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** SHA-256 of the audio file content (stable id across devices). */
        sha256: text("sha256"),
        /** Companion-side numeric id (per device) for round-tripping during sync. */
        companionTrackId: integer("companion_track_id"),
        deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
        title: text("title"),
        artist: text("artist"),
        album: text("album"),
        remix: text("remix"),
        label: text("label"),
        bpm: real("bpm"),
        keyCamelot: text("key_camelot"),
        keyMusical: text("key_musical"),
        durationMs: integer("duration_ms"),
        energy: real("energy"),
        genre: text("genre"),
        subgenre: text("subgenre"),
        mood: text("mood"),
        color: text("color"),
        vocalType: text("vocal_type"),
        setPosition: text("set_position"),
        mixability: real("mixability"),
        rating: integer("rating"),
        isFavorite: boolean("is_favorite").default(false),
        isHidden: boolean("is_hidden").default(false),
        year: integer("year"),
        comment: text("comment"),
        artworkUrl: text("artwork_url"),
        sourceUrl: text("source_url"),
        sourcePlatform: text("source_platform"),
        sourceId: text("source_id"),
        format: text("format"),
        bitrate: integer("bitrate"),
        sampleRate: integer("sample_rate"),
        fileSize: bigint("file_size", { mode: "number" }),
        addedAt: timestamp("added_at").defaultNow(),
        analyzedAt: timestamp("analyzed_at"),
        updatedAt: timestamp("updated_at").defaultNow(),
        /** Monotonic counter for incremental sync. */
        syncVersion: bigint("sync_version", { mode: "number" }).default(0),
        /**
         * Per-field last-write-wins clock for sync conflict resolution.
         * Shape: `{ [fieldName: string]: ISO8601 string }`. Companion sends
         * a partial payload + one outer `updatedAt`; the server only persists
         * a field when the incoming timestamp beats the stored per-field one.
         */
        fieldVersions: jsonb("field_versions").$type<Record<string, string>>().default(sql`'{}'::jsonb`),
    },
    (t) => [
        index("tracks_user_idx").on(t.userId),
        index("tracks_sha_idx").on(t.sha256),
        index("tracks_sync_idx").on(t.userId, t.syncVersion),
        uniqueIndex("tracks_user_sha_uniq").on(t.userId, t.sha256),
    ],
);

export const playlists = pgTable(
    "playlists",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** Stable cross-device identifier (UUID minted by the companion). */
        externalId: text("external_id"),
        name: text("name").notNull(),
        description: text("description"),
        color: text("color"),
        parentId: integer("parent_id"),
        sortOrder: integer("sort_order").default(0),
        createdAt: timestamp("created_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
        syncVersion: bigint("sync_version", { mode: "number" }).default(0),
    },
    (t) => [
        uniqueIndex("playlists_user_external_uniq").on(t.userId, t.externalId),
    ],
);

export const playlistTracks = pgTable(
    "playlist_tracks",
    {
        playlistId: integer("playlist_id").notNull().references(() => playlists.id, { onDelete: "cascade" }),
        trackId: integer("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
        position: integer("position").notNull(),
        addedAt: timestamp("added_at").defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.playlistId, t.trackId] })],
);

export const tags = pgTable(
    "tags",
    {
        id: serial("id").primaryKey(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        color: text("color"),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (t) => [uniqueIndex("tags_user_name_uniq").on(t.userId, t.name)],
);

export const trackTags = pgTable(
    "track_tags",
    {
        trackId: integer("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
        tagId: integer("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
    },
    (t) => [primaryKey({ columns: [t.trackId, t.tagId] })],
);

export const cuepoints = pgTable(
    "cuepoints",
    {
        id: serial("id").primaryKey(),
        trackId: integer("track_id").notNull().references(() => tracks.id, { onDelete: "cascade" }),
        /** Stable cross-device identifier (UUID minted by the companion). */
        externalId: text("external_id"),
        /** Position in milliseconds from start of track. */
        positionMs: integer("position_ms").notNull(),
        /** "hot" | "memory" | "loop_in" | "loop_out" */
        kind: text("kind").notNull(),
        label: text("label"),
        color: text("color"),
        createdAt: timestamp("created_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [
        uniqueIndex("cuepoints_track_external_uniq").on(t.trackId, t.externalId),
    ],
);

// ─── Subscriptions (Stripe) ─────────────────────────────────────────────────

export const subscriptions = pgTable("subscriptions", {
    /** Auth.js user id. */
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id").notNull().unique(),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    /** active | trialing | past_due | canceled | incomplete | incomplete_expired | paused */
    status: text("status").notNull().default("incomplete"),
    /** "free" | "pro_monthly" | "pro_yearly" */
    plan: text("plan").notNull().default("free"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false),
    /** Last Stripe event applied — used by the webhook for replay-dedupe
     *  AND out-of-order rejection (events older than `lastEventAt` are
     *  ignored to stop a stale `updated` from clobbering a newer state). */
    lastEventId: text("last_event_id"),
    lastEventAt: timestamp("last_event_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── Sync-log (per-user, server-side change feed for incremental pull) ──────
//
// Every write to a syncable table appends here so the companion can pull
// only what changed since its `syncCursor`. Cleaned up after 30 days.

export const syncLog = pgTable(
    "sync_log",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** "tracks" | "playlists" | "playlist_tracks" | "tags" | "track_tags" | "cuepoints" */
        entity: text("entity").notNull(),
        entityId: text("entity_id").notNull(),
        /** "upsert" | "delete" */
        op: text("op").notNull(),
        /** Snapshot payload for upserts; null for deletes. */
        payload: jsonb("payload"),
        /** Device that authored the write. NULL for cloud-side writes (web app).
         *  GET /api/sync filters this so a device never re-pulls its own pushes. */
        originDeviceId: text("origin_device_id"),
        createdAt: timestamp("created_at").defaultNow().notNull(),
    },
    (t) => [
        index("sync_log_user_idx").on(t.userId, t.id),
    ],
);

// ─── Types ──────────────────────────────────────────────────────────────────

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

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;

// Track type kept for cross-package compatibility with `companion-library.ts`.
// Prefer the inferred `typeof tracks.$inferSelect` for code that reads the
// cloud DB directly.
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

// ─── Web Push subscriptions ─────────────────────────────────────────────────
// One row per (user, endpoint). A user can have many devices/browsers
// subscribed at once. We index by user_id for the common send-fanout case
// ("notify user X on all their devices"), and the endpoint is unique
// because the Push spec guarantees endpoint uniqueness across the world.

export const pushSubscriptions = pgTable(
    "push_subscriptions",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** Push provider endpoint URL (FCM/Mozilla/WNS). Unique globally per spec. */
        endpoint: text("endpoint").notNull().unique(),
        /** Subscriber's P-256 ECDH public key (base64url). */
        p256dh: text("p256dh").notNull(),
        /** Subscriber's auth secret (base64url, 16 bytes). */
        auth: text("auth").notNull(),
        /** Optional user-agent hint for the settings UI ("Chrome on Windows"). */
        userAgent: text("user_agent"),
        /** Bumped on every successful send; lets us prune dead subs after N failures. */
        lastSeenAt: timestamp("last_seen_at"),
        /** Incremented every time the push provider returns 4xx/5xx. Subs with
         *  consecutiveFailures >= 5 get garbage-collected on the next send. */
        consecutiveFailures: integer("consecutive_failures").notNull().default(0),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (t) => [index("push_subs_user_idx").on(t.userId)],
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ─── Smart playlist rules (Batch 40) ────────────────────────────────
//
// Stored separately from the `playlists` table so we don't pollute the
// per-field LWW sync surface and so a future companion-side mirror can
// adopt the same shape without rewriting the playlists schema.
//
// Keyed by (userId, companionPlaylistId): one rules row per user × per
// companion-side playlist id. The companion's id is what the UI already
// passes around everywhere.
export const smartPlaylistRules = pgTable(
    "smart_playlist_rules",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        /** Companion-side playlist id. Not a FK because the companion DB is
         *  separate; the cleanup happens via the companion's own delete event. */
        companionPlaylistId: integer("companion_playlist_id").notNull(),
        /** Discriminated-union rules JSON. Validated by `smartRulesSchema`
         *  in src/lib/smart-rules.ts. */
        rules: jsonb("rules").notNull(),
        /** Which authoring mode produced `rules`: builder|sql|graph|ai. */
        ruleSource: text("rule_source").notNull(),
        /** Last time the smart playlist was re-evaluated against the library. */
        lastPopulatedAt: timestamp("last_populated_at"),
        createdAt: timestamp("created_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [
        uniqueIndex("smart_rules_user_pl_uniq").on(t.userId, t.companionPlaylistId),
    ],
);

export type SmartPlaylistRulesRow = typeof smartPlaylistRules.$inferSelect;
export type NewSmartPlaylistRules = typeof smartPlaylistRules.$inferInsert;
