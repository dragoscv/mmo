import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MEDIA_SCHEMA_VERSION, cacheGet, cacheSet, getMeta, migrateMediaDb, openMediaDb, setMeta } from "./db";

describe("media db", () => {
    it("creates media.sqlite in userData, WAL, versioned; re-open is idempotent", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-media-"));
        try {
            const db = openMediaDb(dir);
            expect(fs.existsSync(path.join(dir, "media.sqlite"))).toBe(true);
            expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
            expect(db.pragma("user_version", { simple: true })).toBe(MEDIA_SCHEMA_VERSION);
            const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
            for (const t of ["titles", "availability", "recs_cache", "progress", "track_plays", "library_index", "meta"]) expect(tables).toContain(t);
            setMeta(db, "revision", "5");
            db.close();

            const db2 = openMediaDb(dir);
            expect(migrateMediaDb(db2)).toBe(MEDIA_SCHEMA_VERSION);
            expect(getMeta(db2, "revision")).toBe("5"); // INSERT OR IGNORE did not reset
            db2.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("recs_cache honours TTL", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mmo-media-"));
        try {
            const db = openMediaDb(dir);
            cacheSet(db, "k", { a: 1 }, 1000);
            expect(cacheGet(db, "k", 100, 1050)).toEqual({ a: 1 });
            expect(cacheGet(db, "k", 100, 1200)).toBeNull();
            expect(cacheGet(db, "missing", 100, 1000)).toBeNull();
            db.close();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("v2 migrates a v1 database in place (rev columns, tombstones, last_pushed_revision)", () => {
        const db = new Database(":memory:");
        // Replay only v1 by running the migrator on a copy of the first statement.
        db.exec("CREATE TABLE progress (profile_id TEXT NOT NULL, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, season INTEGER NOT NULL DEFAULT 0, episode INTEGER NOT NULL DEFAULT 0, position_sec REAL NOT NULL DEFAULT 0, duration_sec REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (profile_id, kind, tmdb_id, season, episode));");
        db.exec("CREATE TABLE track_plays (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, track_key TEXT NOT NULL, played_at INTEGER NOT NULL, duration_sec REAL NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0);");
        db.exec("CREATE TABLE library_index (server_file_id TEXT PRIMARY KEY, kind TEXT NOT NULL, tmdb_id INTEGER, season INTEGER, episode INTEGER, path TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mtime INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);");
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('revision','7'),('library_etag','3');");
        db.exec("INSERT INTO progress (profile_id, kind, tmdb_id, updated_at) VALUES ('p','movie',1,5)");
        db.pragma("user_version = 1");
        expect(migrateMediaDb(db)).toBe(MEDIA_SCHEMA_VERSION);
        const cols = (db.prepare("PRAGMA table_info(progress)").all() as { name: string }[]).map((c) => c.name);
        expect(cols).toContain("rev");
        expect((db.prepare("SELECT rev FROM progress").get() as { rev: number }).rev).toBe(0);
        expect(getMeta(db, "revision")).toBe("7");
        expect(getMeta(db, "last_pushed_revision")).toBe("0");
        expect((db.prepare("SELECT COUNT(*) AS n FROM library_tombstones").get() as { n: number }).n).toBe(0);
        db.close();
    });
});
