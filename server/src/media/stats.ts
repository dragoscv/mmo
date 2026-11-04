/**
 * Year-in-review stats per profile (WP16-11).
 *
 *   GET /media/stats?profile=&year=  → MediaStats
 *
 * Watch side comes from `progress` (one row per title/episode, last write wins): a completed row
 * counts its full duration (`duration_sec`, else TMDB runtime from the cached `titles` JSON), an
 * unfinished one counts `position_sec`. The row's year/month/day is its `updated_at` (UTC).
 * Listen side comes from `track_plays` (`duration_sec` per play). Genre names / runtime / title come
 * from `lookupTitle(kind, id)` (cache only — never a network call).
 */

import type express from "express";
import type { MediaDb } from "./db";
import type { MediaKind, TitleDetails } from "./types";

export type LookupTitle = (kind: MediaKind, tmdbId: number) => Pick<TitleDetails, "title" | "genres" | "runtime"> | null | undefined;

export interface MediaStats {
    year: number;
    profileId: string;
    watch: {
        hours: number;
        titles: number;
        movies: number;
        episodes: number;
        completed: number;
        topGenres: { id: number; name: string; hours: number }[];
        longestStreakDays: number;
        byMonth: number[];
        topTitles: { kind: MediaKind; tmdbId: number; title: string; hours: number }[];
    };
    listen: {
        hours: number;
        plays: number;
        topTracks: { trackKey: string; plays: number }[];
        byMonth: number[];
    };
}

const DAY_MS = 86_400_000;
const r2 = (h: number): number => Math.round(h * 100) / 100;

/** Longest run of consecutive UTC day numbers. */
export function longestStreak(dayNumbers: Iterable<number>): number {
    const days = [...new Set(dayNumbers)].sort((a, b) => a - b);
    let best = 0;
    let cur = 0;
    for (let i = 0; i < days.length; i++) {
        cur = i > 0 && days[i] === days[i - 1]! + 1 ? cur + 1 : 1;
        if (cur > best) best = cur;
    }
    return best;
}

export function buildStats(db: MediaDb, profileId: string, year: number, lookupTitle: LookupTitle): MediaStats {
    const from = Date.UTC(year, 0, 1);
    const to = Date.UTC(year + 1, 0, 1);

    const rows = db.prepare(
        `SELECT kind, tmdb_id, season, episode, position_sec, duration_sec, completed, updated_at
         FROM progress WHERE profile_id = ? AND updated_at >= ? AND updated_at < ?`,
    ).all(profileId, from, to) as {
        kind: MediaKind; tmdb_id: number; season: number; episode: number;
        position_sec: number; duration_sec: number; completed: number; updated_at: number;
    }[];

    const cache = new Map<string, ReturnType<LookupTitle> | null>();
    const look = (kind: MediaKind, id: number) => {
        const k = `${kind}:${id}`;
        if (!cache.has(k)) {
            let v: ReturnType<LookupTitle> | null = null;
            try { v = lookupTitle(kind, id) ?? null; } catch { v = null; }
            cache.set(k, v);
        }
        return cache.get(k) ?? null;
    };

    const watchByMonth = new Array<number>(12).fill(0);
    const perTitle = new Map<string, { kind: MediaKind; tmdbId: number; sec: number }>();
    const perGenre = new Map<number, { name: string; sec: number }>();
    const days: number[] = [];
    const movies = new Set<number>();
    let episodes = 0;
    let completed = 0;
    let totalSec = 0;

    for (const r of rows) {
        const t = look(r.kind, r.tmdb_id);
        let sec: number;
        if (r.completed) {
            sec = r.duration_sec > 0 ? r.duration_sec : (t?.runtime ?? 0) * 60;
            if (sec <= 0) sec = r.position_sec;
            completed++;
        } else {
            sec = r.duration_sec > 0 ? Math.min(r.position_sec, r.duration_sec) : r.position_sec;
        }
        sec = Math.max(0, sec || 0);
        totalSec += sec;
        watchByMonth[new Date(r.updated_at).getUTCMonth()] += sec;
        if (sec > 0) days.push(Math.floor(r.updated_at / DAY_MS));
        if (r.kind === "movie") movies.add(r.tmdb_id);
        else if (r.episode > 0) episodes++;
        const key = `${r.kind}:${r.tmdb_id}`;
        const pt = perTitle.get(key) ?? { kind: r.kind, tmdbId: r.tmdb_id, sec: 0 };
        pt.sec += sec;
        perTitle.set(key, pt);
        for (const g of t?.genres ?? []) {
            const pg = perGenre.get(g.id) ?? { name: g.name, sec: 0 };
            pg.sec += sec;
            perGenre.set(g.id, pg);
        }
    }

    const plays = db.prepare(
        `SELECT track_key, played_at, duration_sec FROM track_plays WHERE profile_id = ? AND played_at >= ? AND played_at < ?`,
    ).all(profileId, from, to) as { track_key: string; played_at: number; duration_sec: number }[];
    const listenByMonth = new Array<number>(12).fill(0);
    const perTrack = new Map<string, number>();
    let listenSec = 0;
    for (const p of plays) {
        const s = Math.max(0, p.duration_sec || 0);
        listenSec += s;
        listenByMonth[new Date(p.played_at).getUTCMonth()] += s;
        perTrack.set(p.track_key, (perTrack.get(p.track_key) ?? 0) + 1);
    }

    return {
        year,
        profileId,
        watch: {
            hours: r2(totalSec / 3600),
            titles: perTitle.size,
            movies: movies.size,
            episodes,
            completed,
            topGenres: [...perGenre.entries()]
                .sort((a, b) => b[1].sec - a[1].sec || a[0] - b[0])
                .slice(0, 10)
                .map(([id, g]) => ({ id, name: g.name, hours: r2(g.sec / 3600) })),
            longestStreakDays: longestStreak(days),
            byMonth: watchByMonth.map((s) => r2(s / 3600)),
            topTitles: [...perTitle.values()]
                .filter((t) => t.sec > 0)
                .sort((a, b) => b.sec - a.sec)
                .slice(0, 10)
                .map((t) => ({ kind: t.kind, tmdbId: t.tmdbId, title: look(t.kind, t.tmdbId)?.title ?? `${t.kind} ${t.tmdbId}`, hours: r2(t.sec / 3600) })),
        },
        listen: {
            hours: r2(listenSec / 3600),
            plays: plays.length,
            topTracks: [...perTrack.entries()]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 20)
                .map(([trackKey, n]) => ({ trackKey, plays: n })),
            byMonth: listenByMonth.map((s) => r2(s / 3600)),
        },
    };
}

export interface StatsHandlerDeps {
    db: MediaDb;
    lookupTitle: LookupTitle;
    /** Optional PIN guard; return null after answering the request yourself. Default `?profile=` or "default". */
    resolveProfile?: (req: express.Request, res: express.Response) => string | null;
    now?: () => number;
    log?: { error: (msg: string, err: unknown, fields?: Record<string, unknown>) => void };
}

/** Express handler for `GET /media/stats?profile=&year=`. */
export function createStatsHandler(deps: StatsHandlerDeps): express.RequestHandler {
    return (req, res) => {
        try {
            const profileId = deps.resolveProfile
                ? deps.resolveProfile(req, res)
                : (typeof req.query.profile === "string" && req.query.profile ? req.query.profile : "default").slice(0, 128);
            if (profileId === null) return;
            const nowYear = new Date((deps.now ?? Date.now)()).getUTCFullYear();
            const raw = req.query.year;
            const year = typeof raw === "string" && raw ? Number(raw) : nowYear;
            if (!Number.isInteger(year) || year < 1970 || year > nowYear + 1) {
                res.status(400).json({ error: "year must be an integer between 1970 and next year" });
                return;
            }
            res.json(buildStats(deps.db, profileId, year, deps.lookupTitle));
        } catch (err: unknown) {
            deps.log?.error("[media/stats] handler failed", err, { path: req.path });
            if (!res.headersSent) res.status(500).json({ error: "Internal error" });
        }
    };
}
