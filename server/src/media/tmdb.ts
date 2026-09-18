/**
 * TMDB v3 client for the media module.
 *
 * - Auth: `TMDB_API_KEY` may be a v3 key (`?api_key=`) or a v4 read token
 *   (starts with `eyJ` → `Authorization: Bearer`).
 * - Token-bucket limiter (30 req/s, TMDB allows ~40-50).
 * - `getTitle` cached 30 d in `titles`; list endpoints cached 6 h in
 *   `recs_cache` keyed by the final URL.
 * - Without a key every call resolves to an empty result — never throws.
 */

import type { MediaDb } from "./db";
import { cacheGet, cacheSet } from "./db";
import type {
    MediaKind, MediaLogger, Person, TitleCard, TitleDetails, TmdbProviderRef, TmdbRegionProviders,
} from "./types";

export const TMDB_BASE = "https://api.themoviedb.org/3";
export const TITLE_TTL_MS = 30 * 24 * 3600_000;
export const LIST_TTL_MS = 6 * 3600_000;
export const PROVIDER_CATALOG_TTL_MS = 24 * 3600_000;

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
    ok: boolean; status: number; json(): Promise<unknown>;
}>;

export interface TmdbClientOptions {
    apiKey?: string;
    language?: string;
    region?: string;
    fetch?: FetchLike;
    log?: MediaLogger;
    ratePerSec?: number;
    now?: () => number;
}

export type TrendingWindow = "day" | "week";

export interface TmdbPage { page: number; results: TitleCard[]; totalPages: number }

export interface ProviderCatalogEntry {
    provider_id: number;
    provider_name: string;
    logo_path: string | null;
    display_priority: number;
}

// ── limiter ───────────────────────────────────────────────────────────────

export class TokenBucket {
    private tokens: number;
    private last: number;
    constructor(private readonly ratePerSec: number, private readonly now: () => number = Date.now) {
        this.tokens = ratePerSec;
        this.last = now();
    }
    async take(): Promise<void> {
        for (;;) {
            const t = this.now();
            this.tokens = Math.min(this.ratePerSec, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
            this.last = t;
            if (this.tokens >= 1) { this.tokens -= 1; return; }
            const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}

// ── mapping helpers ───────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function toCard(raw: Raw, kindHint?: MediaKind): TitleCard | null {
    const id = num(raw.id);
    if (!id) return null;
    const mt = str(raw.media_type);
    const kind: MediaKind = mt === "tv" ? "tv" : mt === "movie" ? "movie" : kindHint ?? (raw.first_air_date || raw.name ? "tv" : "movie");
    if (mt === "person") return null;
    const genreIds = Array.isArray(raw.genre_ids)
        ? (raw.genre_ids as unknown[]).filter((g): g is number => typeof g === "number")
        : Array.isArray(raw.genres)
            ? (raw.genres as Raw[]).map((g) => num(g.id)).filter((g): g is number => g !== undefined)
            : [];
    return {
        kind,
        tmdbId: id,
        title: str(raw.title) ?? str(raw.name) ?? str(raw.original_title) ?? str(raw.original_name) ?? "",
        originalTitle: str(raw.original_title) ?? str(raw.original_name),
        overview: str(raw.overview),
        posterPath: strOrNull(raw.poster_path),
        backdropPath: strOrNull(raw.backdrop_path),
        releaseDate: str(raw.release_date) ?? str(raw.first_air_date),
        voteAverage: num(raw.vote_average),
        voteCount: num(raw.vote_count),
        popularity: num(raw.popularity),
        genreIds,
    };
}

function toPeople(list: unknown, roleKey: "character" | "job", limit: number): Person[] {
    if (!Array.isArray(list)) return [];
    const out: Person[] = [];
    for (const p of list as Raw[]) {
        const id = num(p.id);
        const name = str(p.name);
        if (!id || !name) continue;
        out.push({ id, name, role: str(p[roleKey]) ?? "", profilePath: strOrNull(p.profile_path) });
        if (out.length >= limit) break;
    }
    return out;
}

function pickLogo(images: unknown, lang: string): string | null {
    const logos = (images as Raw | undefined)?.logos;
    if (!Array.isArray(logos) || logos.length === 0) return null;
    const short = lang.split("-")[0];
    const byLang = (l: string | null) => (logos as Raw[]).find((x) => (x.iso_639_1 ?? null) === l);
    const pick = byLang(short ?? null) ?? byLang("en") ?? byLang(null) ?? (logos as Raw[])[0];
    return strOrNull(pick?.file_path);
}

function pickCertification(raw: Raw, kind: MediaKind, region: string): string | undefined {
    if (kind === "movie") {
        const results = ((raw.release_dates as Raw | undefined)?.results ?? []) as Raw[];
        const r = results.find((x) => x.iso_3166_1 === region) ?? results.find((x) => x.iso_3166_1 === "US");
        const dates = (r?.release_dates ?? []) as Raw[];
        return dates.map((d) => str(d.certification)).find(Boolean);
    }
    const results = ((raw.content_ratings as Raw | undefined)?.results ?? []) as Raw[];
    const r = results.find((x) => x.iso_3166_1 === region) ?? results.find((x) => x.iso_3166_1 === "US");
    return str(r?.rating);
}

export function toDetails(raw: Raw, kind: MediaKind, lang: string, region: string): TitleDetails | null {
    const card = toCard(raw, kind);
    if (!card) return null;
    const credits = (raw.credits ?? raw.aggregate_credits ?? {}) as Raw;
    const kwRoot = (raw.keywords ?? {}) as Raw;
    const kwList = (kwRoot.keywords ?? kwRoot.results ?? []) as Raw[];
    const recs = ((raw.recommendations as Raw | undefined)?.results ?? []) as Raw[];
    const sim = ((raw.similar as Raw | undefined)?.results ?? []) as Raw[];
    const videos = ((raw.videos as Raw | undefined)?.results ?? []) as Raw[];
    const wp = ((raw["watch/providers"] as Raw | undefined)?.results ?? {}) as Record<string, TmdbRegionProviders>;
    const crewRaw = Array.isArray(credits.crew) ? (credits.crew as Raw[]) : [];
    const directors = crewRaw.filter((c) => c.job === "Director" || c.job === "Creator" || c.department === "Directing");
    const creators = Array.isArray(raw.created_by) ? (raw.created_by as Raw[]).map((c) => ({ ...c, job: "Creator" })) : [];
    return {
        ...card,
        kind,
        runtime: num(raw.runtime) ?? (Array.isArray(raw.episode_run_time) ? num((raw.episode_run_time as unknown[])[0]) : undefined),
        status: str(raw.status),
        tagline: str(raw.tagline),
        genres: Array.isArray(raw.genres)
            ? (raw.genres as Raw[]).map((g) => ({ id: num(g.id) ?? 0, name: str(g.name) ?? "" })).filter((g) => g.id)
            : [],
        keywords: kwList.map((k) => ({ id: num(k.id) ?? 0, name: str(k.name) ?? "" })).filter((k) => k.id),
        cast: toPeople(credits.cast, "character", 20),
        crew: toPeople([...creators, ...directors], "job", 10),
        collectionId: num((raw.belongs_to_collection as Raw | undefined)?.id) ?? null,
        numberOfSeasons: num(raw.number_of_seasons),
        numberOfEpisodes: num(raw.number_of_episodes),
        externalIds: (raw.external_ids as Record<string, string | number | null> | undefined) ?? {},
        videos: videos
            .filter((v) => v.site === "YouTube")
            .map((v) => ({ key: str(v.key) ?? "", site: "YouTube", type: str(v.type) ?? "", name: str(v.name) ?? "" }))
            .filter((v) => v.key),
        logoPath: pickLogo(raw.images, lang),
        certification: pickCertification(raw, kind, region),
        recommendations: recs.map((r) => toCard(r, kind)).filter((c): c is TitleCard => c !== null),
        similar: sim.map((r) => toCard(r, kind)).filter((c): c is TitleCard => c !== null),
        watchProviders: wp,
    };
}

// ── client ────────────────────────────────────────────────────────────────

export class TmdbClient {
    readonly configured: boolean;
    readonly language: string;
    readonly region: string;
    private readonly apiKey: string | undefined;
    private readonly bearer: boolean;
    private readonly fetchImpl: FetchLike;
    private readonly bucket: TokenBucket;
    private readonly log: MediaLogger | undefined;
    private readonly now: () => number;

    constructor(private readonly db: MediaDb, opts: TmdbClientOptions = {}) {
        this.apiKey = opts.apiKey?.trim() || undefined;
        this.configured = Boolean(this.apiKey);
        this.bearer = Boolean(this.apiKey && this.apiKey.startsWith("eyJ"));
        this.language = opts.language ?? "ro-RO";
        this.region = (opts.region ?? "RO").toUpperCase();
        this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
        this.now = opts.now ?? Date.now;
        this.bucket = new TokenBucket(opts.ratePerSec ?? 30, this.now);
        this.log = opts.log;
    }

    buildUrl(pathname: string, params: Record<string, string | number | undefined> = {}): string {
        const u = new URL(`${TMDB_BASE}${pathname}`);
        if (!("language" in params)) u.searchParams.set("language", this.language);
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === "") continue;
            u.searchParams.set(k, String(v));
        }
        if (this.apiKey && !this.bearer) u.searchParams.set("api_key", this.apiKey);
        return u.toString();
    }

    /** Raw GET with limiter. Returns null on any failure (logged). */
    async getJson<T = Raw>(pathname: string, params: Record<string, string | number | undefined> = {}): Promise<T | null> {
        if (!this.configured) return null;
        const url = this.buildUrl(pathname, params);
        await this.bucket.take();
        const headers: Record<string, string> = { accept: "application/json" };
        if (this.bearer && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
        try {
            const res = await this.fetchImpl(url, { headers });
            if (!res.ok) {
                this.log?.warn("[media/tmdb] http error", { status: res.status, path: pathname });
                return null;
            }
            return (await res.json()) as T;
        } catch (err) {
            this.log?.warn("[media/tmdb] fetch failed", { path: pathname }, err);
            return null;
        }
    }

    /** Cached list call (6 h) keyed by URL without the api_key. */
    private async cachedList(pathname: string, params: Record<string, string | number | undefined>, kindHint?: MediaKind): Promise<TmdbPage> {
        const key = `tmdb:${this.buildUrl(pathname, params).replace(/([?&])api_key=[^&]*&?/, "$1").replace(/[?&]$/, "")}`;
        const hit = cacheGet<TmdbPage>(this.db, key, LIST_TTL_MS, this.now());
        if (hit) return hit;
        const raw = await this.getJson<Raw>(pathname, params);
        const results = Array.isArray(raw?.results) ? (raw!.results as Raw[]) : [];
        const page: TmdbPage = {
            page: num(raw?.page) ?? 1,
            totalPages: num(raw?.total_pages) ?? 1,
            results: results.map((r) => toCard(r, kindHint)).filter((c): c is TitleCard => c !== null),
        };
        if (raw) cacheSet(this.db, key, page, this.now());
        return page;
    }

    async getTitle(kind: MediaKind, tmdbId: number, opts: { force?: boolean } = {}): Promise<TitleDetails | null> {
        const row = this.db.prepare("SELECT json, fetched_at FROM titles WHERE kind = ? AND tmdb_id = ?").get(kind, tmdbId) as
            | { json: string; fetched_at: number } | undefined;
        if (row && !opts.force && this.now() - row.fetched_at < TITLE_TTL_MS) {
            try { return JSON.parse(row.json) as TitleDetails; } catch { /* refetch */ }
        }
        if (!this.configured) {
            if (row) { try { return JSON.parse(row.json) as TitleDetails; } catch { return null; } }
            return null;
        }
        const append = [
            "credits", "keywords", "recommendations", "similar", "external_ids", "images", "videos",
            "watch/providers", kind === "movie" ? "release_dates" : "content_ratings",
        ].join(",");
        const short = this.language.split("-")[0] ?? "en";
        const raw = await this.getJson<Raw>(`/${kind}/${tmdbId}`, {
            append_to_response: append,
            include_image_language: `${short},en,null`,
        });
        if (!raw) {
            if (row) { try { return JSON.parse(row.json) as TitleDetails; } catch { return null; } }
            return null;
        }
        const details = toDetails(raw, kind, this.language, this.region);
        if (!details) return null;
        this.db.prepare(
            "INSERT INTO titles (kind, tmdb_id, json, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, tmdb_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
        ).run(kind, tmdbId, JSON.stringify(details), this.now());
        return details;
    }

    /** Cached title without network (for fast reads in rows builder). */
    getCachedTitle(kind: MediaKind, tmdbId: number): TitleDetails | null {
        const row = this.db.prepare("SELECT json FROM titles WHERE kind = ? AND tmdb_id = ?").get(kind, tmdbId) as { json: string } | undefined;
        if (!row) return null;
        try { return JSON.parse(row.json) as TitleDetails; } catch { return null; }
    }

    trending(kind: MediaKind | "all", window: TrendingWindow = "week", page = 1): Promise<TmdbPage> {
        return this.cachedList(`/trending/${kind}/${window}`, { page }, kind === "all" ? undefined : kind);
    }

    popular(kind: MediaKind, page = 1): Promise<TmdbPage> {
        return this.cachedList(`/${kind}/popular`, { page, region: this.region }, kind);
    }

    discover(kind: MediaKind, params: Record<string, string | number | undefined> = {}): Promise<TmdbPage> {
        const base: Record<string, string | number | undefined> = {
            watch_region: this.region,
            include_adult: "false",
            sort_by: "popularity.desc",
            ...params,
        };
        if (base.with_watch_providers === undefined) delete base.with_watch_providers;
        return this.cachedList(`/discover/${kind}`, base, kind);
    }

    upcoming(region = this.region, page = 1): Promise<TmdbPage> {
        return this.cachedList("/movie/upcoming", { region, page }, "movie");
    }

    onTheAir(page = 1): Promise<TmdbPage> {
        return this.cachedList("/tv/on_the_air", { page }, "tv");
    }

    search(query: string, page = 1): Promise<TmdbPage> {
        const q = query.trim();
        if (!q) return Promise.resolve({ page: 1, totalPages: 0, results: [] });
        return this.cachedList("/search/multi", { query: q, page, include_adult: "false", region: this.region });
    }

    /** Live watch-provider catalog for a region (24 h cache). */
    async providerCatalog(kind: MediaKind, region = this.region): Promise<ProviderCatalogEntry[]> {
        const key = `tmdb:providers:${kind}:${region}`;
        const hit = cacheGet<ProviderCatalogEntry[]>(this.db, key, PROVIDER_CATALOG_TTL_MS, this.now());
        if (hit) return hit;
        const raw = await this.getJson<Raw>(`/watch/providers/${kind}`, { watch_region: region });
        const results = Array.isArray(raw?.results) ? (raw!.results as Raw[]) : [];
        const out: ProviderCatalogEntry[] = results
            .map((r) => {
                const prio = (r.display_priorities as Record<string, number> | undefined)?.[region] ?? num(r.display_priority) ?? 999;
                return {
                    provider_id: num(r.provider_id) ?? 0,
                    provider_name: str(r.provider_name) ?? "",
                    logo_path: strOrNull(r.logo_path),
                    display_priority: prio,
                } satisfies ProviderCatalogEntry;
            })
            .filter((r) => r.provider_id > 0)
            .sort((a, b) => a.display_priority - b.display_priority);
        if (raw) cacheSet(this.db, key, out, this.now());
        return out;
    }
}

export type { TmdbProviderRef };
