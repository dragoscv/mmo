/**
 * MMO Server client — video routes (`/video/*`) + OpenSubsonic (`/rest/*`).
 * JSON shapes mirror `server/src/library/video-routes.ts` and
 * `server/src/subsonic/browse.ts`. Kept dependency-free on purpose.
 */
import type { ServerConfig } from "./config";

const SUBSONIC_CLIENT = "mixaitizen";
const SUBSONIC_VERSION = "1.16.1";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProbedVideo {
    fileId: string;
    path: string;
    sizeBytes: number;
    container: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    width: number | null;
    height: number | null;
    durationSec: number | null;
    hdr: "sdr" | "hdr10" | "hlg" | "dolby" | null;
    audioTracks: Array<{ index: number; codec: string; channels: number; lang: string | null; title: string | null }>;
    subtitleTracks: Array<{ index: number; codec: string; lang: string | null; title: string | null; forced: boolean }>;
    parsed: { title: string; year: number | null; season: number | null; episode: number | null };
    /** Optional TMDB poster path (set when the server has matched the file). */
    posterPath?: string | null;
}

export interface SubsonicAlbum {
    id: string;
    name: string;
    artist?: string;
    artistId?: string;
    coverArt?: string;
    songCount?: number;
    duration?: number;
    year?: number;
    genre?: string;
    song?: SubsonicSong[];
}

export interface SubsonicSong {
    id: string;
    title: string;
    album?: string;
    artist?: string;
    albumId?: string;
    coverArt?: string;
    duration?: number;
    suffix?: string;
    contentType?: string;
    track?: number;
}

interface SubsonicEnvelope<T> {
    "subsonic-response": { status: "ok" | "failed"; error?: { code: number; message: string } } & T;
}

export class ApiError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
    }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class MmoClient {
    constructor(private readonly cfg: ServerConfig) {}

    private headers(): Record<string, string> {
        const h: Record<string, string> = { "x-device-token": this.cfg.token };
        if (this.cfg.userId) h["x-user-id"] = this.cfg.userId;
        return h;
    }

    /** `?t=&u=` for URLs consumed by `<video>`/`<audio>`/`<track>`/hls.js (no custom headers possible). */
    private authQuery(): string {
        const parts = [`t=${encodeURIComponent(this.cfg.token)}`];
        if (this.cfg.userId) parts.push(`u=${encodeURIComponent(this.cfg.userId)}`);
        return parts.join("&");
    }

    private async json<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await fetch(this.cfg.baseUrl + path, {
            ...init,
            headers: { ...this.headers(), ...(init?.headers as Record<string, string> | undefined) },
        });
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        return (await res.json()) as T;
    }

    // Health — public, no auth. Used by the Connect screen.
    static async health(baseUrl: string): Promise<boolean> {
        try {
            const res = await fetch(baseUrl + "/health");
            return res.ok;
        } catch {
            return false;
        }
    }

    /** Verifies the token against an authenticated, cheap endpoint. */
    async checkAuth(): Promise<void> {
        await this.json<unknown>("/video/flags");
    }

    // ─── Video ───────────────────────────────────────────────────────────

    /** The movie list: `/video/scan` walks the configured roots and returns every probed file. */
    async listVideos(): Promise<ProbedVideo[]> {
        const r = await this.json<{ files: ProbedVideo[] }>("/video/scan", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        return r.files;
    }

    directUrl(fileId: string): string {
        return `${this.cfg.baseUrl}/video/direct/${encodeURIComponent(fileId)}?${this.authQuery()}`;
    }

    /** `/video/file/:id/info`; after a server restart the registry is empty (404) → `/video/lookup?path=` re-registers. */
    async resolveVideo(fileId: string, path: string): Promise<ProbedVideo> {
        const info = (id: string) => this.json<Omit<ProbedVideo, "fileId"> & { fileId?: string }>(`/video/file/${encodeURIComponent(id)}/info`);
        try {
            return { ...(await info(fileId)), fileId };
        } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 404) throw e;
            const r = await this.json<{ fileId: string }>(`/video/lookup?path=${encodeURIComponent(path)}`);
            return { ...(await info(r.fileId)), fileId: r.fileId };
        }
    }

    /** HLS playlist. `caps` tells the server which codecs the TV decodes so it can remux instead of transcode. */
    hlsUrl(fileId: string, opts: { startSec?: number; caps?: string[]; quality?: "original" | "1080p" | "720p" | "480p" } = {}): string {
        const q = new URLSearchParams();
        q.set("q", opts.quality ?? "original");
        if (opts.startSec) q.set("start", String(Math.floor(opts.startSec)));
        if (opts.caps && opts.caps.length) q.set("caps", opts.caps.join(","));
        return `${this.cfg.baseUrl}/video/stream/${encodeURIComponent(fileId)}?${q.toString()}&${this.authQuery()}`;
    }

    subtitleUrl(fileId: string, trackIdx: number): string {
        return `${this.cfg.baseUrl}/video/subs/${encodeURIComponent(fileId)}/${trackIdx}?${this.authQuery()}`;
    }

    posterUrl(posterPath: string): string {
        return this.tmdbImageUrl(posterPath, "w500");
    }

    /** Any TMDB image through the server proxy (`/video/tmdb-image/<size>/<path>`). */
    tmdbImageUrl(imagePath: string, size: string): string {
        const p = imagePath.replace(/^\//, "");
        return `${this.cfg.baseUrl}/video/tmdb-image/${size}/${p}?${this.authQuery()}`;
    }

    /**
     * Scrubber sprite: 12×12 grid of 160×90 tiles, generated lazily by ffmpeg
     * (503 until ffmpeg is available). Used as the poster fallback (tile 14).
     */
    spriteUrl(fileId: string): string {
        return `${this.cfg.baseUrl}/video/thumbs/${encodeURIComponent(fileId)}/sprite.jpg?${this.authQuery()}`;
    }

    /** Best-effort: tell the server to tear down the ffmpeg session when we pause/leave. */
    pauseStream(fileId: string): void {
        fetch(`${this.cfg.baseUrl}/video/stream/${encodeURIComponent(fileId)}/pause?${this.authQuery()}`, {
            method: "POST",
            keepalive: true,
        }).catch(() => undefined);
    }

    // ─── Music (OpenSubsonic) ────────────────────────────────────────────

    private subsonicUrl(view: string, params: Record<string, string | number | undefined>): string {
        const q = new URLSearchParams({ f: "json", v: SUBSONIC_VERSION, c: SUBSONIC_CLIENT, apiKey: this.cfg.token });
        for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
        return `${this.cfg.baseUrl}/rest/${view}.view?${q.toString()}`;
    }

    private async subsonic<T>(view: string, params: Record<string, string | number | undefined>): Promise<T> {
        const res = await fetch(this.subsonicUrl(view, params));
        if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
        const body = (await res.json()) as SubsonicEnvelope<T>;
        const env = body["subsonic-response"];
        if (env.status !== "ok") throw new ApiError(env.error?.message ?? "Subsonic error", env.error?.code ?? 0);
        return env as unknown as T;
    }

    async albumList(type: "newest" | "recent" | "frequent" | "random" | "alphabeticalByName" = "newest", size = 50): Promise<SubsonicAlbum[]> {
        const r = await this.subsonic<{ albumList2?: { album?: SubsonicAlbum[] } }>("getAlbumList2", { type, size });
        return r.albumList2?.album ?? [];
    }

    async album(id: string): Promise<SubsonicAlbum | null> {
        const r = await this.subsonic<{ album?: SubsonicAlbum }>("getAlbum", { id });
        return r.album ?? null;
    }

    async search(query: string): Promise<{ albums: SubsonicAlbum[]; songs: SubsonicSong[] }> {
        const r = await this.subsonic<{ searchResult3?: { album?: SubsonicAlbum[]; song?: SubsonicSong[] } }>("search3", {
            query, albumCount: 20, songCount: 40, artistCount: 0,
        });
        return { albums: r.searchResult3?.album ?? [], songs: r.searchResult3?.song ?? [] };
    }

    streamUrl(songId: string): string {
        return this.subsonicUrl("stream", { id: songId });
    }

    coverArtUrl(id: string, size = 300): string {
        return this.subsonicUrl("getCoverArt", { id, size });
    }
}
