/**
 * `/media/*` client (Media Home brain on MMO Server, WP10) with an etag-keyed
 * 5-minute cache. Every read returns `null` on 404 so the Home screen can fall
 * back to the scan-based rows against an older server.
 */
import { ApiError, type MmoClient } from "./api";
import type { ServerConfig } from "./config";
import type {
    LibraryIndex, MediaEtag, MediaHome, MediaKind, MediaSearchPage, MediaStatus, MediaTitleResponse,
    ProgressEntry, ProgressInput,
} from "./media-types";

export const CACHE_TTL_MS = 5 * 60_000;
export const PROFILE_FALLBACK = "default";

interface CacheEntry<T> { etag: string; at: number; value: T }

export class MediaClient {
    private cache = new Map<string, CacheEntry<unknown>>();
    private etag: MediaEtag | null = null;
    private etagAt = 0;
    /** `null` once a 404 proves the server predates `/media`. */
    private supported: boolean | null = null;

    constructor(private readonly cfg: ServerConfig, private readonly api: MmoClient) {}

    get profile(): string { return this.cfg.userId || PROFILE_FALLBACK; }

    private headers(json = false): Record<string, string> {
        const h: Record<string, string> = { "x-device-token": this.cfg.token };
        if (this.cfg.userId) h["x-user-id"] = this.cfg.userId;
        if (json) h["content-type"] = "application/json";
        return h;
    }

    /** GET → parsed JSON; 404 → null (marks the whole module unsupported). */
    private async get<T>(path: string): Promise<T | null> {
        if (this.supported === false) return null;
        const res = await fetch(this.cfg.baseUrl + path, { headers: this.headers() });
        if (res.status === 404) { this.supported = false; return null; }
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        this.supported = true;
        return (await res.json()) as T;
    }

    private async cached<T>(key: string, path: string): Promise<T | null> {
        const etag = await this.mediaEtag();
        if (etag === null) return null;
        const tag = `${etag.revision}:${etag.libraryEtag ?? ""}`;
        const hit = this.cache.get(key) as CacheEntry<T> | undefined;
        if (hit && hit.etag === tag && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
        const value = await this.get<T>(path);
        if (value !== null) this.cache.set(key, { etag: tag, at: Date.now(), value });
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

    invalidate(): void { this.etag = null; this.cache.clear(); }

    mediaStatus(): Promise<MediaStatus | null> {
        return this.get<MediaStatus>("/media/status");
    }

    mediaHome(): Promise<MediaHome | null> {
        return this.cached<MediaHome>("home", `/media/home?profile=${encodeURIComponent(this.profile)}`);
    }

    mediaTitle(kind: MediaKind, tmdbId: number): Promise<MediaTitleResponse | null> {
        return this.cached<MediaTitleResponse>(`title:${kind}:${tmdbId}`, `/media/title/${kind}/${tmdbId}?profile=${encodeURIComponent(this.profile)}`);
    }

    mediaSearch(q: string): Promise<MediaSearchPage | null> {
        return this.get<MediaSearchPage>(`/media/search?q=${encodeURIComponent(q)}`);
    }

    /** Full video index (serverFileId ↔ tmdbId), used for resume + migration. */
    mediaLibrary(): Promise<LibraryIndex | null> {
        return this.cached<LibraryIndex>("library", "/media/library");
    }

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
    image(path: string | null | undefined, size: "w92" | "w185" | "w500" | "w780" | "w1280" | "original"): string | null {
        if (!path) return null;
        return this.api.tmdbImageUrl(path, size);
    }
}
