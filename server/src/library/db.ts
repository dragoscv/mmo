/**
 * Library DB bootstrap.
 *
 * SQLite file lives in Electron's per-user `userData` dir so each OS user
 * gets isolated storage. Tables are created on first open via raw SQL
 * (we deliberately avoid drizzle-kit migrations in the companion so the
 * packaged Electron app has no extra runtime dependency).
 */

import path from "node:path";
import fs from "node:fs";
import { app } from "electron";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { log } from "../lib/logger";

let _sqlite: Database.Database | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function getDbPath(): string {
    // In Electron main process `app` is defined. For unit tests / standalone
    // node runs we fall back to a temp dir so importing this module never
    // throws. Production always uses Electron.
    let baseDir: string;
    try {
        baseDir = app.getPath("userData");
    } catch {
        baseDir = path.join(process.cwd(), "data");
    }
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    return path.join(baseDir, "library.db");
}

function bootstrap(sqlite: Database.Database) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            filepath TEXT NOT NULL,
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
            synced_lyrics TEXT,
            is_hidden INTEGER DEFAULT 0,
            source_url TEXT,
            source_platform TEXT,
            source_id TEXT,
            related_track_id INTEGER,
            device_id TEXT,
            is_offline_available INTEGER DEFAULT 0,
            stems_status TEXT,
            stems_vocals_path TEXT,
            stems_drums_path TEXT,
            stems_bass_path TEXT,
            stems_melody_path TEXT,
            stems_analyzed_at TEXT,
            stems_model TEXT,
            stems_error TEXT,
            loudness_lufs REAL,
            loudness_true_peak_dbfs REAL,
            loudness_range_lu REAL,
            acoustid_fingerprint TEXT,
            acoustid_id TEXT,
            bpm_confidence REAL,
            key_confidence REAL,
            beats TEXT,
            downbeats TEXT,
            chord_progression TEXT,
            structure_segments TEXT,
            dsp_analyzed_at TEXT,
            UNIQUE(user_id, filepath)
        );

        CREATE INDEX IF NOT EXISTS idx_tracks_user ON tracks(user_id);
        CREATE INDEX IF NOT EXISTS idx_tracks_user_added ON tracks(user_id, added_at);
        CREATE INDEX IF NOT EXISTS idx_tracks_user_genre ON tracks(user_id, genre);

        CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            type TEXT DEFAULT 'manual',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id);

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            playlist_id INTEGER NOT NULL,
            track_id INTEGER NOT NULL,
            position INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_pt_playlist ON playlist_tracks(playlist_id);
        CREATE INDEX IF NOT EXISTS idx_pt_track ON playlist_tracks(track_id);

        CREATE TABLE IF NOT EXISTS scan_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            action TEXT NOT NULL,
            filepath TEXT NOT NULL,
            details TEXT,
            scanned_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_scan_logs_user ON scan_logs(user_id, scanned_at);

        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT,
            artist TEXT,
            duration INTEGER,
            thumbnail TEXT,
            extractor TEXT,
            file_path TEXT,
            file_size INTEGER,
            format TEXT,
            quality TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            track_id INTEGER,
            error TEXT,
            downloaded_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id, downloaded_at);

        CREATE TABLE IF NOT EXISTS saved_drives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            path TEXT NOT NULL,
            label TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'removable',
            format TEXT,
            is_active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_drives_user_path ON saved_drives(user_id, path);

        -- Scan-job persistence. Each row mirrors a ScanJob in scan-jobs.ts.
        -- Only terminal states (complete/error) and the initial pending
        -- row are written through — in-flight progress mutations stay in
        -- RAM to avoid SQLite write amplification. On companion restart,
        -- any rows still in pending/discovering/scanning get marked as
        -- 'error: companion restarted' so the UI shows a clear state and
        -- the user can retry the scan from scratch.
        CREATE TABLE IF NOT EXISTS scan_jobs (
            id TEXT PRIMARY KEY,
            folder TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            discovered INTEGER NOT NULL DEFAULT 0,
            scanned INTEGER NOT NULL DEFAULT 0,
            errored INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT -1,
            current_file TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            error TEXT,
            origin TEXT NOT NULL DEFAULT 'manual'
        );
        CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_scan_jobs_started ON scan_jobs(started_at DESC);
    `);

    // ── Idempotent column migrations for existing DBs ──────────────────
    // SQLite's ALTER TABLE ADD COLUMN has no `IF NOT EXISTS`, so we
    // probe the existing column set first and only emit ADDs for the
    // ones that are missing. This keeps schema upgrades inline without
    // a migrations directory shipped in the Electron bundle.
    const ensureColumns = (table: string, defs: Array<[string, string]>) => {
        const existing = sqlite
            .prepare(`PRAGMA table_info(${table})`)
            .all() as Array<{ name: string }>;
        const have = new Set(existing.map((c) => c.name));
        for (const [name, ddl] of defs) {
            if (have.has(name)) continue;
            try {
                sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
            } catch (e) {
                // Best-effort: log and continue. A failed ADD here is
                // never a reason to refuse to boot the companion.
                log.warn("db.alter_failed", { table, column: name }, e);
            }
        }
    };
    ensureColumns("tracks", [
        ["stems_status", "TEXT"],
        ["stems_vocals_path", "TEXT"],
        ["stems_drums_path", "TEXT"],
        ["stems_bass_path", "TEXT"],
        ["stems_melody_path", "TEXT"],
        ["stems_analyzed_at", "TEXT"],
        ["stems_model", "TEXT"],
        ["stems_error", "TEXT"],
        ["loudness_lufs", "REAL"],
        ["loudness_true_peak_dbfs", "REAL"],
        ["loudness_range_lu", "REAL"],
        ["acoustid_fingerprint", "TEXT"],
        ["acoustid_id", "TEXT"],
        ["bpm_confidence", "REAL"],
        ["key_confidence", "REAL"],
        ["beats", "TEXT"],
        ["downbeats", "TEXT"],
        ["chord_progression", "TEXT"],
        ["structure_segments", "TEXT"],
        ["dsp_analyzed_at", "TEXT"],
        // Cloud sync key. Cloud Postgres `tracks` is uniquely keyed by
        // (user_id, sha256); mirroring it here lets `pushTrackChange()`
        // and `/v1/sync` ingest use a stable cross-device id rather than
        // the SQLite-local autoincrement id. Backfill is best-effort:
        // we hash on next analysis pass, not as part of this migration.
        ["sha256", "TEXT"],
        // Per-field LWW timestamps so partial pushes from any device can
        // merge without clobbering newer fields. Stored as JSON string
        // because SQLite has no native jsonb.
        ["field_versions", "TEXT"],
    ]);
    ensureColumns("playlists", [
        // Stable cross-device id. Cloud playlists key on (user_id, external_id).
        ["external_id", "TEXT"],
        ["updated_at", "TEXT"],
    ]);
    // Best-effort indices for the new sync columns. CREATE INDEX IF NOT
    // EXISTS is safe to run on every boot.
    try {
        sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_user_sha ON tracks(user_id, sha256) WHERE sha256 IS NOT NULL`);
        sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_ext ON playlists(user_id, external_id) WHERE external_id IS NOT NULL`);
    } catch (e) {
        console.warn("[db] sync index creation failed:", e);
    }
}

export function getLibraryDb() {
    if (!_db) {
        const dbPath = getDbPath();
        _sqlite = new Database(dbPath);
        bootstrap(_sqlite);
        _db = drizzle(_sqlite, { schema });
    }
    return _db;
}

export function getLibrarySqlite() {
    if (!_sqlite) getLibraryDb();
    return _sqlite!;
}

export function closeLibraryDb() {
    if (_sqlite) {
        // TRUNCATE checkpoint folds the WAL fully into the main DB
        // file before closing. Belt-and-braces: better-sqlite3.close()
        // already checkpoints, but doing it explicitly first means even
        // a forced kill between the pragma and close() leaves the main
        // file fully up to date — no analyzer progress hiding in WAL.
        try { _sqlite.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
        try { _sqlite.close(); } catch { /* ignore */ }
    }
    _sqlite = null;
    _db = null;
}
