/**
 * Web app SQLite — auth & per-user settings only.
 *
 * The music library (tracks, playlists, scan logs, downloads) lives in
 * the COMPANION's SQLite (see `server/src/library/db.ts`) and is
 * accessed via the `/library/*` HTTP API through `@/lib/companion-library`.
 *
 * This DB only stores:
 *  - Auth.js tables (user/account/session/verificationToken)
 *  - User preferences and named profile bundles
 *  - Registered companion devices (api_url + token) and their watched folders
 *  - Recordings made in the browser (Live/Mixer/DAW/Editor sessions)
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";

// On Vercel (and any serverless host) the project filesystem is read-only;
// only `/tmp` is writable, and it's per-invocation/ephemeral. We redirect the
// SQLite file there so the module can at least load — but persistence is NOT
// guaranteed across cold starts. The proper fix is migrating to Postgres.
const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;
const dataDir = isServerless
  ? path.join("/tmp", "mmo-data")
  : path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "music-organizer.db");
const sqlite = new Database(dbPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export { sqlite };
export const db = drizzle(sqlite, { schema });

// ─── Auth.js + per-user tables (auto-create on first run) ────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    emailVerified INTEGER,
    image TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account (
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    provider TEXT NOT NULL,
    providerAccountId TEXT NOT NULL,
    refresh_token TEXT,
    access_token TEXT,
    expires_at INTEGER,
    token_type TEXT,
    scope TEXT,
    id_token TEXT,
    session_state TEXT,
    PRIMARY KEY (provider, providerAccountId)
  );

  CREATE TABLE IF NOT EXISTS session (
    sessionToken TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verificationToken (
    identifier TEXT NOT NULL,
    token TEXT NOT NULL,
    expires INTEGER NOT NULL,
    PRIMARY KEY (identifier, token)
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, key)
  );

  CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_profiles_active ON user_profiles(user_id, is_active);

  CREATE TABLE IF NOT EXISTS profile_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(profile_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_prefs_profile ON profile_preferences(profile_id);

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    os TEXT,
    hostname TEXT,
    api_url TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    version TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS device_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    label TEXT,
    track_count INTEGER DEFAULT 0,
    total_size INTEGER DEFAULT 0,
    last_scanned_at TEXT,
    is_enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    filepath TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    metadata TEXT,
    notes TEXT,
    is_favorite INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── One-shot migration: drop legacy tables that have moved to the
//     companion. Wiping is acceptable per the dev-only DB policy. ─────────────
sqlite.exec(`
  DROP TABLE IF EXISTS analysis_changes;
  DROP TABLE IF EXISTS analysis_jobs;
  DROP TABLE IF EXISTS offline_tracks;
  DROP TABLE IF EXISTS playlist_tracks;
  DROP TABLE IF EXISTS playlists;
  DROP TABLE IF EXISTS downloads;
  DROP TABLE IF EXISTS scan_logs;
  DROP TABLE IF EXISTS tracks;
  DROP TABLE IF EXISTS drives;
  DROP TABLE IF EXISTS settings;
`);
