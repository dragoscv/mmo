import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "music-organizer.db");
const sqlite = new Database(dbPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Auto-migrate: add is_hidden column if missing
try {
  const cols = sqlite.prepare("PRAGMA table_info(tracks)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "is_hidden")) {
    sqlite.exec("ALTER TABLE tracks ADD COLUMN is_hidden INTEGER DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "related_track_id")) {
    sqlite.exec("ALTER TABLE tracks ADD COLUMN related_track_id INTEGER");
  }
} catch {
  // table may not exist yet
}

export { sqlite };
export const db = drizzle(sqlite, { schema });

// Auto-create tables on first run
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filepath TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    artist TEXT,
    title TEXT,
    album TEXT,
    remix TEXT,
    label TEXT,
    bpm REAL,
    key_camelot TEXT,
    key_musical TEXT,
    duration INTEGER,
    energy INTEGER,
    genre TEXT,
    subgenre TEXT,
    mood TEXT,
    color TEXT,
    vocal_type TEXT,
    set_position TEXT,
    mixability INTEGER,
    is_processed INTEGER DEFAULT 0,
    file_size INTEGER,
    format TEXT,
    bitrate INTEGER,
    sample_rate INTEGER,
    added_at TEXT DEFAULT (datetime('now')),
    analyzed_at TEXT,
    rating INTEGER,
    is_favorite INTEGER DEFAULT 0,
    tags TEXT,
    artwork_url TEXT,
    musicbrainz_id TEXT,
    release_mbid TEXT,
    isrc TEXT,
    year INTEGER,
    comment TEXT,
    lyrics TEXT,
    synced_lyrics TEXT
  );

  CREATE TABLE IF NOT EXISTS drives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    label TEXT,
    type TEXT NOT NULL,
    format TEXT,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    filepath TEXT NOT NULL,
    details TEXT,
    scanned_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'idle',
    mode TEXT NOT NULL,
    options TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    current_track TEXT,
    changes_count INTEGER DEFAULT 0,
    errors_count INTEGER DEFAULT 0,
    errors TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analysis_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    track_artist TEXT NOT NULL,
    track_title TEXT NOT NULL,
    field TEXT NOT NULL,
    field_label TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT NOT NULL,
    source TEXT NOT NULL,
    checked INTEGER DEFAULT 0
  );
`);

// ─── Auth.js tables ──────────────────────────────────────────────────────────
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

  CREATE TABLE IF NOT EXISTS offline_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    cached_at TEXT DEFAULT (datetime('now')),
    size INTEGER NOT NULL,
    priority INTEGER DEFAULT 0,
    is_pinned INTEGER DEFAULT 0
  );
`);

// Migrate existing DB: add new columns if they don't exist
const colCheck = sqlite
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('tracks') WHERE name='rating'")
  .get() as { cnt: number };
if (colCheck.cnt === 0) {
  sqlite.exec(`
    ALTER TABLE tracks ADD COLUMN rating INTEGER;
    ALTER TABLE tracks ADD COLUMN is_favorite INTEGER DEFAULT 0;
    ALTER TABLE tracks ADD COLUMN tags TEXT;
    ALTER TABLE tracks ADD COLUMN artwork_url TEXT;
    ALTER TABLE tracks ADD COLUMN musicbrainz_id TEXT;
    ALTER TABLE tracks ADD COLUMN release_mbid TEXT;
    ALTER TABLE tracks ADD COLUMN year INTEGER;
    ALTER TABLE tracks ADD COLUMN comment TEXT;
  `);
}

// Migrate: add isrc, lyrics, synced_lyrics columns
const isrcCheck = sqlite
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('tracks') WHERE name='isrc'")
  .get() as { cnt: number };
if (isrcCheck.cnt === 0) {
  sqlite.exec(`
    ALTER TABLE tracks ADD COLUMN isrc TEXT;
    ALTER TABLE tracks ADD COLUMN lyrics TEXT;
    ALTER TABLE tracks ADD COLUMN synced_lyrics TEXT;
  `);
}

// Migrate: add device_id and is_offline_available columns
const deviceIdCheck = sqlite
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('tracks') WHERE name='device_id'")
  .get() as { cnt: number };
if (deviceIdCheck.cnt === 0) {
  sqlite.exec(`
    ALTER TABLE tracks ADD COLUMN device_id TEXT;
    ALTER TABLE tracks ADD COLUMN is_offline_available INTEGER DEFAULT 0;
  `);
}

// Migrate: add stems columns
const stemsCheck = sqlite
  .prepare("SELECT COUNT(*) as cnt FROM pragma_table_info('tracks') WHERE name='stems_status'")
  .get() as { cnt: number };
if (stemsCheck.cnt === 0) {
  sqlite.exec(`
    ALTER TABLE tracks ADD COLUMN stems_status TEXT;
    ALTER TABLE tracks ADD COLUMN stems_vocals_path TEXT;
    ALTER TABLE tracks ADD COLUMN stems_drums_path TEXT;
    ALTER TABLE tracks ADD COLUMN stems_bass_path TEXT;
    ALTER TABLE tracks ADD COLUMN stems_melody_path TEXT;
    ALTER TABLE tracks ADD COLUMN stems_analyzed_at TEXT;
  `);
}

// Seed default settings if empty
const settingsCount = sqlite
  .prepare("SELECT COUNT(*) as count FROM settings")
  .get() as { count: number };

if (settingsCount.count === 0) {
  const defaultSettings = [
    ["music_root", "H:\\\\Music"],
    ["inbox_folder", "H:\\\\Music\\\\_Inbox"],
    [
      "watch_folders",
      JSON.stringify(["H:\\\\Music\\\\_Inbox", "H:\\\\Music\\\\DJ"]),
    ],
    [
      "genre_folders",
      JSON.stringify({
        Techno: "DJ/Techno",
        "Tech House": "DJ/Tech House",
        Acid: "DJ/Acid",
        Psytrance: "DJ/Psytrance",
        Bounce: "DJ/Bounce",
        Manele: "DJ/Manele",
        "Populară": "DJ/Populara",
        "Balkanică": "DJ/Balkanica",
        Latino: "DJ/Latino",
        Other: "DJ/Other",
      }),
    ],
  ];

  const insert = sqlite.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  );
  for (const [key, value] of defaultSettings) {
    insert.run(key, value);
  }
}
