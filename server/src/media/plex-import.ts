/**
 * Plex importer (WP16-50, D38): watch history, ratings and watchlist from a Plex Media Server
 * (+ the plex.tv Discover watchlist) into media.sqlite for one profile.
 *
 *   movies   GET {server}/library/sections/{key}/all?type=1&unwatched=0&includeGuids=1
 *   shows    GET {server}/library/sections/{key}/all?type=2&includeGuids=1        (show tmdb ids + ratings)
 *   episodes GET {server}/library/sections/{key}/all?type=4&unwatched=0           (per-episode watched)
 *   history  GET {server}/status/sessions/history/all                             (last viewedAt per item)
 *   watchlist GET https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1
 *
 * Matching uses the `Guid[]` ids (`tmdb://`, then `imdb://` via TMDB /find when configured). The Plex
 * token is used for these requests only — never stored or logged. Watched items become completed
 * progress (100 %, `updatedAt` = Plex viewedAt so later local plays still win); ratings go to
 * `user_ratings` (0–10, source `plex`).
 */

import type { MediaDb } from "./db";
import type { ProgressStore } from "./progress";
import type { WatchlistStore } from "./watchlist";
import type { MediaKind } from "./types";

export const PLEX_DISCOVER_WATCHLIST = "https://discover.provider.plex.tv/library/sections/watchlist/all";

export type PlexFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PlexImportDeps {
    db: MediaDb;
    progress: ProgressStore;
    watchlist: WatchlistStore;
    fetch?: PlexFetch;
    /** IMDB id → TMDB id (TMDB `/find`); optional. */
    findByImdb?: (imdbId: string, kind: MediaKind) => Promise<number | null>;
    now?: () => number;
}

export interface PlexImportInput { serverUrl: string; token: string; profileId: string }

export interface PlexImportResult {
    profileId: string;
    sections: number;
    watchedMovies: number;
    watchedEpisodes: number;
    ratings: number;
    watchlist: number;
    unmatched: number;
    errors: string[];
}

export class PlexImportError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

type Meta = Record<string, unknown>;

const arr = (v: unknown): Meta[] => (Array.isArray(v) ? (v as Meta[]) : []);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** `{MediaContainer: {Metadata|Directory: [...]}}` → items. */
function items(json: unknown, field: "Metadata" | "Directory" = "Metadata"): Meta[] {
    const mc = (json as { MediaContainer?: Meta } | null)?.MediaContainer;
    return arr(mc?.[field]);
}

/** External ids from a Plex item (`Guid: [{id:"tmdb://603"}]`, legacy `guid: "com.plexapp.agents.themoviedb://603?lang=en"`). */
export function plexGuids(m: Meta): { tmdb: number | null; imdb: string | null } {
    let tmdb: number | null = null;
    let imdb: string | null = null;
    const ids = arr(m.Guid).map((g) => s(g.id)).filter((x): x is string => x !== null);
    const legacy = s(m.guid);
    if (legacy) ids.push(legacy);
    for (const id of ids) {
        let mm = /^tmdb:\/\/(\d+)/.exec(id) ?? /themoviedb:\/\/(\d+)/.exec(id);
        if (mm && tmdb === null) tmdb = Number(mm[1]);
        mm = /^imdb:\/\/(tt\d+)/.exec(id) ?? /imdb:\/\/(tt\d+)/.exec(id);
        if (mm && imdb === null) imdb = mm[1]!;
    }
    return { tmdb, imdb };
}

export function normalizeServerUrl(raw: string): string {
    let u: URL;
    try { u = new URL(raw.trim()); } catch { throw new PlexImportError(400, "serverUrl must be an absolute http(s) URL"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new PlexImportError(400, "serverUrl must be an absolute http(s) URL");
    u.search = ""; u.hash = "";
    return u.toString().replace(/\/+$/, "");
}

export async function importFromPlex(deps: PlexImportDeps, input: PlexImportInput): Promise<PlexImportResult> {
    const server = normalizeServerUrl(input.serverUrl);
    const token = input.token.trim();
    if (!token) throw new PlexImportError(400, "token required");
    const fetchImpl: PlexFetch = deps.fetch ?? ((url, init) => fetch(url, init));
    const headers = { accept: "application/json", "x-plex-token": token, "x-plex-product": "MixAI", "x-plex-client-identifier": "mixai-server" };
    const res: PlexImportResult = { profileId: input.profileId, sections: 0, watchedMovies: 0, watchedEpisodes: 0, ratings: 0, watchlist: 0, unmatched: 0, errors: [] };

    const get = async (url: string, required = false): Promise<unknown> => {
        let r: Awaited<ReturnType<PlexFetch>>;
        try {
            r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
        } catch {
            if (required) throw new PlexImportError(502, "Plex server unreachable");
            res.errors.push(`unreachable: ${new URL(url).pathname}`);
            return null;
        }
        if (r.status === 401 || r.status === 403) throw new PlexImportError(401, "Plex rejected the token");
        if (!r.ok) {
            if (required) throw new PlexImportError(502, `Plex answered ${r.status}`);
            res.errors.push(`http ${r.status}: ${new URL(url).pathname}`);
            return null;
        }
        return r.json();
    };

    const resolve = async (m: Meta, kind: MediaKind): Promise<number | null> => {
        const g = plexGuids(m);
        if (g.tmdb) return g.tmdb;
        if (g.imdb && deps.findByImdb) {
            try { return await deps.findByImdb(g.imdb, kind); } catch { return null; }
        }
        return null;
    };

    const rate = (kind: MediaKind, tmdbId: number, m: Meta) => {
        const r = n(m.userRating);
        if (r === null || r <= 0) return;
        const at = (n(m.lastRatedAt) ?? n(m.updatedAt) ?? Math.floor((deps.now ?? Date.now)() / 1000)) * 1000;
        deps.db.prepare(
            `INSERT INTO user_ratings (profile_id, kind, tmdb_id, rating, rated_at, source) VALUES (?, ?, ?, ?, ?, 'plex')
             ON CONFLICT(profile_id, kind, tmdb_id) DO UPDATE SET rating = excluded.rating, rated_at = excluded.rated_at, source = excluded.source
             WHERE excluded.rated_at >= user_ratings.rated_at`,
        ).run(input.profileId, kind, tmdbId, Math.min(10, r), at);
        res.ratings++;
    };

    // Last viewedAt per ratingKey (history endpoint is optional — older servers or non-owner tokens 401/404 it).
    const lastViewed = new Map<string, number>();
    const hist = await get(`${server}/status/sessions/history/all?sort=viewedAt:desc`);
    for (const h of items(hist)) {
        const key = s(h.ratingKey) ?? (n(h.ratingKey) !== null ? String(n(h.ratingKey)) : null);
        const at = n(h.viewedAt);
        if (key && at && !lastViewed.has(key)) lastViewed.set(key, at * 1000);
    }
    const keyOf = (m: Meta) => s(m.ratingKey) ?? (n(m.ratingKey) !== null ? String(n(m.ratingKey)) : "");
    const viewedAt = (m: Meta) => lastViewed.get(keyOf(m)) ?? ((n(m.lastViewedAt) ?? 0) * 1000 || (deps.now ?? Date.now)());

    const sections = items(await get(`${server}/library/sections`, true), "Directory");
    for (const sec of sections) {
        const key = s(sec.key) ?? (n(sec.key) !== null ? String(n(sec.key)) : null);
        const type = s(sec.type);
        if (!key || (type !== "movie" && type !== "show")) continue;
        res.sections++;
        if (type === "movie") {
            for (const m of items(await get(`${server}/library/sections/${key}/all?type=1&unwatched=0&includeGuids=1`))) {
                const tmdbId = await resolve(m, "movie");
                if (!tmdbId) { res.unmatched++; continue; }
                if ((n(m.viewCount) ?? 0) > 0) {
                    const dur = Math.round((n(m.duration) ?? 0) / 1000);
                    deps.progress.putProgress({ profileId: input.profileId, kind: "movie", tmdbId, positionSec: dur, durationSec: dur, completed: true, updatedAt: viewedAt(m) });
                    res.watchedMovies++;
                }
                rate("movie", tmdbId, m);
            }
            continue;
        }
        // Shows: show-level ids + ratings, then watched episodes mapped through grandparentRatingKey.
        const showIds = new Map<string, number>();
        for (const sh of items(await get(`${server}/library/sections/${key}/all?type=2&includeGuids=1`))) {
            const tmdbId = await resolve(sh, "tv");
            if (!tmdbId) { res.unmatched++; continue; }
            showIds.set(keyOf(sh), tmdbId);
            rate("tv", tmdbId, sh);
        }
        for (const ep of items(await get(`${server}/library/sections/${key}/all?type=4&unwatched=0`))) {
            if ((n(ep.viewCount) ?? 0) <= 0) continue;
            const showKey = s(ep.grandparentRatingKey) ?? (n(ep.grandparentRatingKey) !== null ? String(n(ep.grandparentRatingKey)) : "");
            const tmdbId = showIds.get(showKey);
            const season = n(ep.parentIndex);
            const episode = n(ep.index);
            if (!tmdbId || season === null || episode === null || season < 0 || episode <= 0) { res.unmatched++; continue; }
            const dur = Math.round((n(ep.duration) ?? 0) / 1000);
            deps.progress.putProgress({ profileId: input.profileId, kind: "tv", tmdbId, season, episode, positionSec: dur, durationSec: dur, completed: true, updatedAt: viewedAt(ep) });
            res.watchedEpisodes++;
        }
    }

    for (const w of items(await get(`${PLEX_DISCOVER_WATCHLIST}?includeGuids=1&includeFields=guid,type,title`))) {
        const kind: MediaKind | null = s(w.type) === "movie" ? "movie" : s(w.type) === "show" ? "tv" : null;
        if (!kind) continue;
        const tmdbId = await resolve(w, kind);
        if (!tmdbId) { res.unmatched++; continue; }
        if (!deps.watchlist.has(input.profileId, kind, tmdbId)) deps.watchlist.add(input.profileId, kind, tmdbId);
        res.watchlist++;
    }
    return res;
}
