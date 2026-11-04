/** Per-profile watchlist (WP16-04). Writes bump the global revision so `/media/etag` changes. */

import type { MediaDb } from "./db";
import type { ProgressStore } from "./progress";
import type { MediaKind, WatchlistEntry } from "./types";

type Row = { profile_id: string; kind: MediaKind; tmdb_id: number; added_at: number; rev: number };
const toEntry = (r: Row): WatchlistEntry => ({ profileId: r.profile_id, kind: r.kind, tmdbId: r.tmdb_id, addedAt: r.added_at, rev: r.rev });

export class WatchlistStore {
    constructor(private readonly db: MediaDb, private readonly progress: ProgressStore, private readonly now: () => number = Date.now) {}

    list(profileId: string, limit = 200): WatchlistEntry[] {
        return (this.db.prepare("SELECT * FROM watchlist WHERE profile_id = ? ORDER BY added_at DESC LIMIT ?")
            .all(profileId, Math.max(1, Math.min(1000, limit))) as Row[]).map(toEntry);
    }

    has(profileId: string, kind: MediaKind, tmdbId: number): boolean {
        return Boolean(this.db.prepare("SELECT 1 FROM watchlist WHERE profile_id = ? AND kind = ? AND tmdb_id = ?").get(profileId, kind, tmdbId));
    }

    add(profileId: string, kind: MediaKind, tmdbId: number): WatchlistEntry {
        const rev = this.progress.bumpRevision();
        const at = this.now();
        this.db.prepare(
            "INSERT INTO watchlist (profile_id, kind, tmdb_id, added_at, rev) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, kind, tmdb_id) DO UPDATE SET rev = excluded.rev",
        ).run(profileId, kind, tmdbId, at, rev);
        return toEntry(this.db.prepare("SELECT * FROM watchlist WHERE profile_id = ? AND kind = ? AND tmdb_id = ?").get(profileId, kind, tmdbId) as Row);
    }

    remove(profileId: string, kind: MediaKind, tmdbId: number): boolean {
        const r = this.db.prepare("DELETE FROM watchlist WHERE profile_id = ? AND kind = ? AND tmdb_id = ?").run(profileId, kind, tmdbId);
        if (r.changes > 0) this.progress.bumpRevision();
        return r.changes > 0;
    }
}
