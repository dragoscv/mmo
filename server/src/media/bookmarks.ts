/**
 * Scene bookmarks shared in the household (WP16-50, D38).
 *
 * A bookmark points at a second of a title: `titleKey` = `movie:<tmdbId>` | `tv:<tmdbId>:s<S>e<E>` |
 * `file:<fileId>` (untagged local file). Private bookmarks are visible to their profile only; shared ones
 * to every profile — except kid profiles when the title's age rating exceeds their max age (unrated
 * titles are hidden from kids, same rule as every card list).
 */

import crypto from "node:crypto";
import type { MediaDb } from "./db";
import type { MediaKind } from "./types";

export interface Bookmark {
    id: string;
    profileId: string;
    titleKey: string;
    kind: MediaKind | null;
    tmdbId: number | null;
    season: number | null;
    episode: number | null;
    fileId: string | null;
    sec: number;
    label: string;
    shared: boolean;
    createdAt: number;
}

export interface BookmarkInput {
    kind?: MediaKind;
    tmdbId?: number;
    season?: number;
    episode?: number;
    fileId?: string;
    sec: number;
    label?: string;
    shared?: boolean;
}

export class BookmarkError extends Error {}

type Row = {
    id: string; profile_id: string; title_key: string; kind: string | null; tmdb_id: number | null; season: number | null;
    episode: number | null; file_id: string | null; sec: number; label: string; shared: number; created_at: number;
};

const toBookmark = (r: Row): Bookmark => ({
    id: r.id, profileId: r.profile_id, titleKey: r.title_key, kind: r.kind === "movie" || r.kind === "tv" ? r.kind : null,
    tmdbId: r.tmdb_id, season: r.season, episode: r.episode, fileId: r.file_id, sec: r.sec, label: r.label,
    shared: r.shared === 1, createdAt: r.created_at,
});

/** Canonical title key; throws when neither a TMDB id nor a fileId is given. */
export function titleKeyOf(i: { kind?: MediaKind | null; tmdbId?: number | null; season?: number | null; episode?: number | null; fileId?: string | null }): string {
    if ((i.kind === "movie" || i.kind === "tv") && i.tmdbId && i.tmdbId > 0) {
        if (i.kind === "tv" && i.season && i.episode) return `tv:${i.tmdbId}:s${i.season}e${i.episode}`;
        return `${i.kind}:${i.tmdbId}`;
    }
    if (i.fileId) return `file:${i.fileId}`;
    throw new BookmarkError("kind+tmdbId or fileId required");
}

export class BookmarkStore {
    constructor(private readonly db: MediaDb, private readonly now: () => number = Date.now) {}

    add(profileId: string, input: BookmarkInput): Bookmark {
        const sec = Number(input.sec);
        if (!Number.isFinite(sec) || sec < 0 || sec > 48 * 3600) throw new BookmarkError("sec must be 0..172800");
        const key = titleKeyOf(input);
        if ((this.db.prepare("SELECT COUNT(*) AS n FROM bookmarks WHERE profile_id = ?").get(profileId) as { n: number }).n >= 2000) {
            throw new BookmarkError("too many bookmarks (2000 per profile)");
        }
        const id = `bm_${crypto.randomBytes(6).toString("base64url")}`;
        this.db.prepare(
            `INSERT INTO bookmarks (id, profile_id, title_key, kind, tmdb_id, season, episode, file_id, sec, label, shared, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, profileId, key, input.kind ?? null, input.tmdbId ?? null, input.season ?? null, input.episode ?? null,
            input.fileId ?? null, Math.round(sec * 10) / 10, (input.label ?? "").trim().slice(0, 120), input.shared ? 1 : 0, this.now());
        return this.get(id)!;
    }

    get(id: string): Bookmark | null {
        const r = this.db.prepare("SELECT * FROM bookmarks WHERE id = ?").get(id) as Row | undefined;
        return r ? toBookmark(r) : null;
    }

    /**
     * Bookmarks visible to `profileId`: its own + shared ones of others. `allowShared(b)` filters shared
     * bookmarks of other profiles (age rule for kids). `titleKey` narrows to one title; for a show key
     * without an episode (`tv:<id>`) every episode's bookmarks match.
     */
    listVisible(profileId: string, opts: { titleKey?: string; allowShared?: (b: Bookmark) => boolean; limit?: number } = {}): Bookmark[] {
        const limit = Math.max(1, Math.min(1000, opts.limit ?? 500));
        const args: (string | number)[] = [profileId];
        let where = "(profile_id = ? OR shared = 1)";
        if (opts.titleKey) {
            where += " AND (title_key = ? OR title_key LIKE ?)";
            args.push(opts.titleKey, `${opts.titleKey}:%`);
        }
        const rows = this.db.prepare(`SELECT * FROM bookmarks WHERE ${where} ORDER BY title_key, sec LIMIT ${limit}`).all(...args) as Row[];
        return rows.map(toBookmark).filter((b) => b.profileId === profileId || !opts.allowShared || opts.allowShared(b));
    }

    /** Only the owner profile may delete. */
    remove(profileId: string, id: string): "deleted" | "not_found" | "forbidden" {
        const b = this.get(id);
        if (!b) return "not_found";
        if (b.profileId !== profileId) return "forbidden";
        this.db.prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
        return "deleted";
    }
}
