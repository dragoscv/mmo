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
    /** Non-loopback LAN URL the companion announces on startup
     *  (e.g. http://192.168.1.42:17899). Populated via POST
     *  /api/devices/announce by the companion; null when never reported
     *  or when the companion only binds loopback. Used by sibling
     *  devices (tablet/TV) to reach this companion. */
    lanUrl: text("lan_url"),
    lanAnnouncedAt: timestamp("lan_announced_at"),
    /** HMAC-SHA256 of the plaintext bearer (hex). Indexable equality key
     *  used for inbound auth lookups. Populated by `issueDeviceToken()`. */
    tokenHash: text("token_hash").unique(),
    /** AES-256-GCM ciphertext envelope of the plaintext bearer
     *  ("v1:b64(nonce):b64(ciphertext+tag)"). Decrypted on demand for
     *  outbound `X-Device-Token` use. Key is derived from AUTH_SECRET. */
    tokenEncrypted: text("token_encrypted"),
    /** Cloudflare Tunnel UUID. Provisioned per-device so the browser
     *  can hit the companion directly (HTTPS, no LAN, no mixed content)
     *  via a per-device hostname. NULL until first provision. See
     *  drizzle/0015_device_tunnel.sql. */
    tunnelId: text("tunnel_id"),
    /** FQDN the browser fetches (e.g. device-<short>.devices.muzicai.ro).
     *  CNAME of <tunnelId>.cfargotunnel.com. */
    tunnelHostname: text("tunnel_hostname"),
    /** AES-256-GCM envelope of the `cloudflared --token` bearer.
     *  Encrypted with the same key as tokenEncrypted. Sent to the
     *  companion once over the announce channel; companion persists
     *  locally. */
    tunnelTokenEncrypted: text("tunnel_token_encrypted"),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    version: text("version"),
    /** Sync cursor — server-side monotonic counter the device has fully consumed. */
    syncCursor: bigint("sync_cursor", { mode: "number" }).default(0),
    createdAt: timestamp("created_at").defaultNow(),
});

// ─── Device command queue ───────────────────────────────────────────────────
//
// Cloud→companion RPC. The browser/server enqueues a row; the companion
// drains it via /api/devices/announce response and posts a result back.
// See drizzle/0014_device_commands.sql for the WHY (mixed-content + PNA).
export const deviceCommands = pgTable(
    "device_commands",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
        /** Stable opcode the companion's command worker switches on. */
        kind: text("kind").notNull(),
        /** Arbitrary JSON body, command-specific. */
        payload: jsonb("payload"),
        /** pending | dispatched | done | error | expired */
        status: text("status").notNull().default("pending"),
        /** Successful result payload (kind-specific). */
        result: jsonb("result"),
        /** Human-readable failure reason when status='error'. */
        error: text("error"),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
        completedAt: timestamp("completed_at", { withTimezone: true }),
        /** Set to now()+5min on insert; the announce route lazily expires. */
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
        index("device_commands_dispatch_idx").on(t.deviceId, t.status, t.createdAt),
        index("device_commands_status_idx").on(t.status, t.expiresAt),
    ],
);

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
        /** AI-suggested BPM (awaiting user confirmation). Cleared when accepted into bpm. */
        aiBpm: real("ai_bpm"),
        /** AI-suggested Camelot key (e.g. "8A"). Cleared when accepted into keyCamelot. */
        aiKey: text("ai_key"),
        /** Confidence 0..1 returned by the model. */
        aiConfidence: real("ai_confidence"),
        /** Which model produced the suggestion: "haiku" | "sonnet". */
        aiModel: text("ai_model"),
        /** When the AI suggestion was generated. */
        aiAnalyzedAt: timestamp("ai_analyzed_at"),
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

// ──────────────────────────────────────────────────────────────────────
// Saved searches (a.k.a. "smart crates").
//
// A persisted, named copy of the /library page's URL filter state.
// Filter shape mirrors `LibrarySearchParams` exactly so we can read/
// write without any translation layer. Auto-updates on every visit
// because it's evaluated at read time, not materialised.
export const savedSearches = pgTable(
    "saved_searches",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        /** Optional lucide icon name, e.g. "Sparkles". */
        icon: text("icon"),
        /** Library filter params, validated by `savedSearchFiltersSchema`
         *  in src/lib/saved-searches.ts. */
        filters: jsonb("filters").notNull(),
        sortOrder: integer("sort_order").notNull().default(0),
        createdAt: timestamp("created_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [
        index("saved_searches_user_idx").on(t.userId, t.sortOrder),
        uniqueIndex("saved_searches_user_name_uniq").on(t.userId, t.name),
    ],
);

export type SavedSearchRow = typeof savedSearches.$inferSelect;
export type NewSavedSearch = typeof savedSearches.$inferInsert;

// ─── Video Pillar ────────────────────────────────────────────────────────────
// Movies, TV shows, episodes, file index, watch state, recommendations,
// family sub-profiles, companion-device metadata.

/** Family sub-profiles under a single account. Picker on launch. */
export const watchProfiles = pgTable(
    "watch_profiles",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        avatar: text("avatar"),
        color: text("color"),
        isKid: boolean("is_kid").default(false).notNull(),
        sortOrder: integer("sort_order").notNull().default(0),
        prefs: jsonb("prefs").default({}).notNull(),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (t) => [index("watch_profiles_user_idx").on(t.userId, t.sortOrder)],
);

/** Companion devices (per install). Replaces the music `devices` table for video purposes. */
export const companionDevices = pgTable(
    "companion_devices",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        machineId: text("machine_id").notNull(),
        hostname: text("hostname"),
        platform: text("platform"),
        friendlyName: text("friendly_name"),
        color: text("color"),
        icon: text("icon"),
        publicIp: text("public_ip"),
        lastSeen: timestamp("last_seen").defaultNow(),
        capabilities: jsonb("capabilities").default({}).notNull(),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (t) => [
        uniqueIndex("companion_devices_user_machine_uniq").on(t.userId, t.machineId),
        index("companion_devices_user_idx").on(t.userId),
    ],
);

/** Movie metadata (one row per logical movie, can map to many files). */
export const movies = pgTable(
    "movies",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        tmdbId: integer("tmdb_id"),
        imdbId: text("imdb_id"),
        title: text("title").notNull(),
        originalTitle: text("original_title"),
        year: integer("year"),
        overview: text("overview"),
        tagline: text("tagline"),
        runtimeMinutes: integer("runtime_minutes"),
        posterPath: text("poster_path"),
        backdropPath: text("backdrop_path"),
        trailerYoutubeId: text("trailer_youtube_id"),
        genres: jsonb("genres").default([]).notNull(),
        cast: jsonb("cast").default([]).notNull(),
        crew: jsonb("crew").default([]).notNull(),
        rating: real("rating"),
        ratingCount: integer("rating_count"),
        ageRating: text("age_rating"),
        dominantColor: text("dominant_color"),
        addedAt: timestamp("added_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [
        index("movies_user_idx").on(t.userId),
        index("movies_tmdb_idx").on(t.tmdbId),
        uniqueIndex("movies_user_tmdb_uniq").on(t.userId, t.tmdbId),
    ],
);

export const tvShows = pgTable(
    "tv_shows",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        tmdbId: integer("tmdb_id"),
        imdbId: text("imdb_id"),
        title: text("title").notNull(),
        originalTitle: text("original_title"),
        firstAirYear: integer("first_air_year"),
        overview: text("overview"),
        posterPath: text("poster_path"),
        backdropPath: text("backdrop_path"),
        trailerYoutubeId: text("trailer_youtube_id"),
        genres: jsonb("genres").default([]).notNull(),
        cast: jsonb("cast").default([]).notNull(),
        rating: real("rating"),
        ratingCount: integer("rating_count"),
        ageRating: text("age_rating"),
        status: text("status"),
        dominantColor: text("dominant_color"),
        addedAt: timestamp("added_at").defaultNow(),
        updatedAt: timestamp("updated_at").defaultNow(),
    },
    (t) => [
        index("tv_shows_user_idx").on(t.userId),
        index("tv_shows_tmdb_idx").on(t.tmdbId),
        uniqueIndex("tv_shows_user_tmdb_uniq").on(t.userId, t.tmdbId),
    ],
);

export const tvSeasons = pgTable(
    "tv_seasons",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        showId: bigint("show_id", { mode: "number" }).notNull().references(() => tvShows.id, { onDelete: "cascade" }),
        seasonNumber: integer("season_number").notNull(),
        name: text("name"),
        overview: text("overview"),
        posterPath: text("poster_path"),
        airDate: timestamp("air_date"),
        episodeCount: integer("episode_count"),
    },
    (t) => [
        uniqueIndex("tv_seasons_show_num_uniq").on(t.showId, t.seasonNumber),
    ],
);

export const tvEpisodes = pgTable(
    "tv_episodes",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        showId: bigint("show_id", { mode: "number" }).notNull().references(() => tvShows.id, { onDelete: "cascade" }),
        seasonNumber: integer("season_number").notNull(),
        episodeNumber: integer("episode_number").notNull(),
        title: text("title"),
        overview: text("overview"),
        runtimeMinutes: integer("runtime_minutes"),
        airDate: timestamp("air_date"),
        stillPath: text("still_path"),
        rating: real("rating"),
        introStartSec: real("intro_start_sec"),
        introEndSec: real("intro_end_sec"),
        creditsStartSec: real("credits_start_sec"),
    },
    (t) => [
        uniqueIndex("tv_episodes_show_se_ep_uniq").on(t.showId, t.seasonNumber, t.episodeNumber),
        index("tv_episodes_show_idx").on(t.showId),
    ],
);

/** Actual file on a companion device. One movie/episode can have many files (qualities, languages). */
export const videoFiles = pgTable(
    "video_files",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        deviceId: bigint("device_id", { mode: "number" }).references(() => companionDevices.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(), // 'movie' | 'episode'
        movieId: bigint("movie_id", { mode: "number" }).references(() => movies.id, { onDelete: "cascade" }),
        episodeId: bigint("episode_id", { mode: "number" }).references(() => tvEpisodes.id, { onDelete: "cascade" }),
        path: text("path").notNull(),
        sizeBytes: bigint("size_bytes", { mode: "number" }),
        container: text("container"),
        videoCodec: text("video_codec"),
        audioCodec: text("audio_codec"),
        width: integer("width"),
        height: integer("height"),
        durationSec: real("duration_sec"),
        bitrateKbps: integer("bitrate_kbps"),
        hdr: text("hdr"),
        audioTracks: jsonb("audio_tracks").default([]).notNull(),
        subtitleTracks: jsonb("subtitle_tracks").default([]).notNull(),
        hash: text("hash"),
        mtime: timestamp("mtime"),
        scannedAt: timestamp("scanned_at").defaultNow(),
    },
    (t) => [
        index("video_files_user_idx").on(t.userId),
        index("video_files_movie_idx").on(t.movieId),
        index("video_files_episode_idx").on(t.episodeId),
        index("video_files_device_idx").on(t.deviceId),
        uniqueIndex("video_files_device_path_uniq").on(t.deviceId, t.path),
    ],
);

/** Per-profile watch progress. */
export const watchHistory = pgTable(
    "watch_history",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        profileId: bigint("profile_id", { mode: "number" }).notNull().references(() => watchProfiles.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(), // 'movie' | 'episode'
        movieId: bigint("movie_id", { mode: "number" }).references(() => movies.id, { onDelete: "cascade" }),
        episodeId: bigint("episode_id", { mode: "number" }).references(() => tvEpisodes.id, { onDelete: "cascade" }),
        positionSec: real("position_sec").default(0).notNull(),
        durationSec: real("duration_sec"),
        progress: real("progress").default(0).notNull(),
        watchedAt: timestamp("watched_at").defaultNow(),
        completed: boolean("completed").default(false).notNull(),
        playCount: integer("play_count").default(0).notNull(),
    },
    (t) => [
        uniqueIndex("watch_history_profile_movie_uniq").on(t.profileId, t.movieId),
        uniqueIndex("watch_history_profile_episode_uniq").on(t.profileId, t.episodeId),
        index("watch_history_profile_idx").on(t.profileId, t.watchedAt),
    ],
);

/** Per-profile ratings (1-10). */
export const videoRatings = pgTable(
    "video_ratings",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        profileId: bigint("profile_id", { mode: "number" }).notNull().references(() => watchProfiles.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(),
        movieId: bigint("movie_id", { mode: "number" }).references(() => movies.id, { onDelete: "cascade" }),
        showId: bigint("show_id", { mode: "number" }).references(() => tvShows.id, { onDelete: "cascade" }),
        rating: integer("rating").notNull(),
        ratedAt: timestamp("rated_at").defaultNow(),
    },
    (t) => [
        uniqueIndex("video_ratings_profile_movie_uniq").on(t.profileId, t.movieId),
        uniqueIndex("video_ratings_profile_show_uniq").on(t.profileId, t.showId),
    ],
);

export const videoCollections = pgTable(
    "video_collections",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        profileId: bigint("profile_id", { mode: "number" }).notNull().references(() => watchProfiles.id, { onDelete: "cascade" }),
        name: text("name").notNull(),
        kind: text("kind").notNull().default("custom"), // 'custom' | 'watch_later' | 'wishlist'
        description: text("description"),
        sortOrder: integer("sort_order").notNull().default(0),
        createdAt: timestamp("created_at").defaultNow(),
    },
    (t) => [index("video_collections_profile_idx").on(t.profileId)],
);

export const videoCollectionItems = pgTable(
    "video_collection_items",
    {
        id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
        collectionId: bigint("collection_id", { mode: "number" }).notNull().references(() => videoCollections.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(),
        movieId: bigint("movie_id", { mode: "number" }).references(() => movies.id, { onDelete: "cascade" }),
        showId: bigint("show_id", { mode: "number" }).references(() => tvShows.id, { onDelete: "cascade" }),
        // Items can also be tmdb-only (wishlist for things not yet in library)
        tmdbId: integer("tmdb_id"),
        tmdbKind: text("tmdb_kind"),
        sortOrder: integer("sort_order").notNull().default(0),
        addedAt: timestamp("added_at").defaultNow(),
    },
    (t) => [
        index("video_collection_items_collection_idx").on(t.collectionId, t.sortOrder),
    ],
);

export type WatchProfileRow = typeof watchProfiles.$inferSelect;
export type CompanionDeviceRow = typeof companionDevices.$inferSelect;
export type MovieRow = typeof movies.$inferSelect;
export type TvShowRow = typeof tvShows.$inferSelect;
export type TvSeasonRow = typeof tvSeasons.$inferSelect;
export type TvEpisodeRow = typeof tvEpisodes.$inferSelect;
export type VideoFileRow = typeof videoFiles.$inferSelect;
export type WatchHistoryRow = typeof watchHistory.$inferSelect;
export type VideoRatingRow = typeof videoRatings.$inferSelect;
export type VideoCollectionRow = typeof videoCollections.$inferSelect;
export type VideoCollectionItemRow = typeof videoCollectionItems.$inferSelect;
