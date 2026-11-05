/**
 * `/media/*` client (Media Home brain on MMO Server, WP10/WP16).
 *  - Profile-scoped: `?profile=<active>` + `x-profile-token` from `ProfilesClient`.
 *  - `/media/home` is cached PERSISTENTLY per profile in localStorage (`mixai-web:home:<profile>`, size-checked,
 *    memory fallback on quota) → `homeCached()` returns instantly, `revalidateHome()` refetches only when
 *    `/media/etag` moved (stale-while-revalidate).
 *  - Title responses are cached in memory per profile (etag-keyed, 5 min).
 * Reads return `null` on 404 so screens can fall back against an older server.
 */
import { ApiError } from "./api";
import type { ServerConfig } from "./config";
import type {
    LibraryIndex, MediaEtag, MediaHome, MediaKind, MediaSearchPage, MediaSeasonResponse, MediaStats, MediaStatus,
    MediaTitleResponse, ProgressEntry, ProgressInput, TrackPlayInput, WatchlistEntry, WatchlistResponse,
} from "./media-types";
import type { ProfilesClient } from "./profiles";
import { tmdbImg } from "@/lib/media/normalize";

export type TmdbSize = "w92" | "w185" | "w342" | "w500" | "w780" | "w1280" | "original";

/** TMDB size for a rendered CSS width at the current DPR. */
export function tmdbSize(renderedWidthPx: number): TmdbSize {
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = renderedWidthPx * dpr;
    if (w <= 92) return "w92";
    if (w <= 185) return "w185";
    if (w <= 342) return "w342";
    if (w <= 500) return "w500";
    if (w <= 780) return "w780";
    return "w1280";
}

export const CACHE_TTL_MS = 5 * 60_000;
export const PROFILE_FALLBACK = "default";
export const HOME_CACHE_PREFIX = "mixai-web:home:";
/** Never write more than this to localStorage for one home blob (~5 MB quota per origin). */
export const HOME_CACHE_MAX_CHARS = 1_500_000;

interface CacheEntry<T> { etag: string; at: number; value: T }
interface HomeBlob { tag: string; at: number; home: MediaHome }

const tagOf = (e: MediaEtag): string => `${e.revision}:${e.libraryEtag ?? ""}`;

export class MediaClient {
    private cache = new Map<string, CacheEntry<unknown>>();
    private homeMem = new Map<string, HomeBlob>();
    private etag: MediaEtag | null = null;
    private etagAt = 0;
    /** `false` once a 404 proves the server predates `/media`. */
    private supported: boolean | null = null;

    constructor(
        private readonly cfg: ServerConfig,
        private readonly profiles: ProfilesClient | null = null,
    ) {}

    /** Active profile id used for `?profile=`. */
    get profile(): string { return this.profiles?.profileId ?? (this.cfg.userId || PROFILE_FALLBACK); }

    private headers(json = false): Record<string, string> {
        const h: Record<string, string> = { "x-device-token": this.cfg.token, ...(this.profiles?.headers() ?? {}) };
        if (this.cfg.userId) h["x-user-id"] = this.cfg.userId;
        if (json) h["content-type"] = "application/json";
        return h;
    }

    private pq(): string { return `profile=${encodeURIComponent(this.profile)}`; }

    /** GET → parsed JSON; 404 → null (marks the whole module unsupported). */
    private async get<T>(path: string): Promise<T | null> {
        if (this.supported === false) return null;
        const res = await fetch(this.cfg.baseUrl + path, { headers: this.headers() });
        if (res.status === 404) { this.supported = false; return null; }
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        this.supported = true;
        return (await res.json()) as T;
    }

    /** Write (PUT/DELETE/POST) → JSON; 404 → null. Invalidates caches. */
    private async write<T>(method: string, path: string, body?: unknown): Promise<T | null> {
        const res = await fetch(this.cfg.baseUrl + path, {
            method, headers: this.headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        this.invalidate();
        return res.status === 204 ? null : ((await res.json()) as T);
    }

    private async cached<T>(key: string, path: string): Promise<T | null> {
        const etag = await this.mediaEtag();
        if (etag === null) return null;
        const tag = tagOf(etag);
        const k = `${this.profile}|${key}`;
        const hit = this.cache.get(k) as CacheEntry<T> | undefined;
        if (hit && hit.etag === tag && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
        const value = await this.get<T>(path);
        if (value !== null) this.cache.set(k, { etag: tag, at: Date.now(), value });
        return value;
    }

    /** Cheap poll; itself cached for 30 s so a screen with several rows does one round-trip. */
    async mediaEtag(force = false): Promise<MediaEtag | null> {
        if (!force && this.etag && Date.now() - this.etagAt < 30_000) return this.etag;
        const e = await this.get<MediaEtag>("/media/etag");
        this.etag = e;
        this.etagAt = Date.now();
        return e;
    }

    /** Drops the in-memory caches (the persistent home blob stays; its tag no longer matches). */
    invalidate(): void { this.etag = null; this.cache.clear(); }

    mediaStatus(): Promise<MediaStatus | null> {
        return this.get<MediaStatus>("/media/status");
    }

    // ─── Home (persistent stale-while-revalidate) ────────────────────────

    private homeKey(): string { return HOME_CACHE_PREFIX + this.profile; }

    /** Last known `/media/home` for the active profile, synchronously (memory, then localStorage). */
    homeCached(): MediaHome | null {
        const mem = this.homeMem.get(this.profile);
        if (mem) return mem.home;
        try {
            const raw = localStorage.getItem(this.homeKey());
            if (!raw) return null;
            const blob = JSON.parse(raw) as HomeBlob;
            if (!blob || !blob.home || !Array.isArray(blob.home.rows)) return null;
            this.homeMem.set(this.profile, blob);
            return blob.home;
        } catch {
            return null;
        }
    }

    private storeHome(tag: string, home: MediaHome): void {
        const blob: HomeBlob = { tag, at: Date.now(), home };
        this.homeMem.set(this.profile, blob);
        try {
            const s = JSON.stringify(blob);
            if (s.length > HOME_CACHE_MAX_CHARS) { localStorage.removeItem(this.homeKey()); return; }
            localStorage.setItem(this.homeKey(), s);
        } catch {
            // Quota exceeded → keep the memory copy only.
            try { localStorage.removeItem(this.homeKey()); } catch { /* ignore */ }
        }
    }

    /**
     * Refetches `/media/home` when the etag moved (or nothing is cached, or `force`). Resolves to the
     * fresh home, or `null` when the cached copy is still current / the server has no `/media`.
     */
    async revalidateHome(force = false): Promise<MediaHome | null> {
        const etag = await this.mediaEtag(true);
        if (etag === null) return null;
        const tag = tagOf(etag);
        const cur = this.homeMem.get(this.profile) ?? (this.homeCached() ? this.homeMem.get(this.profile) : undefined);
        if (!force && cur && cur.tag === tag) return null;
        const home = await this.get<MediaHome>(`/media/home?${this.pq()}`);
        if (home) this.storeHome(tag, home);
        return home;
    }

    /** Cached home if present, else network (back-compat for older screens). */
    async mediaHome(): Promise<MediaHome | null> {
        const c = this.homeCached();
        if (c) { void this.revalidateHome().catch(() => undefined); return c; }
        return this.revalidateHome(true);
    }

    // ─── Titles / seasons / search ───────────────────────────────────────

    mediaTitle(kind: MediaKind, tmdbId: number): Promise<MediaTitleResponse | null> {
        return this.cached<MediaTitleResponse>(`title:${kind}:${tmdbId}`, `/media/title/${kind}/${tmdbId}?${this.pq()}`);
    }

    /** `GET /media/title/tv/{id}/season/{n}` — episodes + local versions + progress per episode. */
    season(tmdbId: number, season: number): Promise<MediaSeasonResponse | null> {
        return this.cached<MediaSeasonResponse>(`season:${tmdbId}:${season}`, `/media/title/tv/${tmdbId}/season/${season}?${this.pq()}`);
    }

    mediaSearch(q: string): Promise<MediaSearchPage | null> {
        return this.get<MediaSearchPage>(`/media/search?q=${encodeURIComponent(q)}&${this.pq()}`);
    }

    /** Full video index (serverFileId ↔ tmdbId), used for resume + migration + library grids. */
    mediaLibrary(): Promise<LibraryIndex | null> {
        return this.cached<LibraryIndex>("library", "/media/library");
    }

    // ─── Watchlist ───────────────────────────────────────────────────────

    watchlist(): Promise<WatchlistResponse | null> {
        return this.cached<WatchlistResponse>("watchlist", `/media/watchlist?${this.pq()}`);
    }

    watchlistAdd(kind: MediaKind, tmdbId: number): Promise<{ entry: WatchlistEntry; revision: number } | null> {
        return this.write("PUT", `/media/watchlist/${kind}/${tmdbId}?${this.pq()}`);
    }

    watchlistRemove(kind: MediaKind, tmdbId: number): Promise<{ removed: boolean; revision: number } | null> {
        return this.write("DELETE", `/media/watchlist/${kind}/${tmdbId}?${this.pq()}`);
    }

    // ─── Stats / plays ───────────────────────────────────────────────────

    /** Year in review (default: current year on the server). */
    stats(year?: number): Promise<MediaStats | null> {
        return this.get<MediaStats>(`/media/stats?${this.pq()}${year ? `&year=${year}` : ""}`);
    }

    /** Record a music play (`POST /media/plays`). */
    recordPlay(input: TrackPlayInput): Promise<unknown> {
        return this.write("POST", `/media/plays?${this.pq()}`, { profileId: this.profile, ...input });
    }

    // ─── Progress ────────────────────────────────────────────────────────

    async getProgress(since?: number): Promise<{ revision: number; entries: ProgressEntry[] } | null> {
        const q = new URLSearchParams({ profile: this.profile });
        if (since !== undefined) q.set("since", String(since));
        return this.get(`/media/progress?${q.toString()}`);
    }

    /** Batch upsert (1..500). Throws on network/5xx so the caller can queue. */
    async putProgress(entries: ProgressInput[]): Promise<{ revision: number } | null> {
        if (entries.length === 0) return null;
        if (this.supported === false) return null;
        const body = entries.slice(0, 500).map((e) => ({ profileId: this.profile, ...e }));
        const res = await fetch(`${this.cfg.baseUrl}/media/progress`, { method: "PUT", headers: this.headers(true), body: JSON.stringify(body) });
        if (res.status === 404) { this.supported = false; return null; }
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        this.invalidate();
        return (await res.json()) as { revision: number };
    }

    // ─── Image proxy helpers (`/video/tmdb-image/<size>/<path>`) ─────────

    image(path: string | null | undefined, size: TmdbSize): string | null {
        return tmdbImg(path, size);
    }

    /** TMDB image sized for a rendered width in CSS px (w185/w342/w500/w780). */
    imageFor(path: string | null | undefined, renderedWidthPx: number): string | null {
        return this.image(path, tmdbSize(renderedWidthPx));
    }
}
