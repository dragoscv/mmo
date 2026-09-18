import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});
