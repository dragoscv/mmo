/**
 * Music client (`/media/music/*`, WP16-11) + Subsonic media URLs.
 * JSON routes use the device token header; covers/streams are Subsonic URLs signed with `apiKey`
 * (the device token), built from the server-provided `coverUrlPath` / `streamUrlPath`.
 * Profile-scoped routes (home, queue) send `?profile=` + `x-profile-token`.
 */
import type { ServerConfig } from "./config";
import { ServerHttp, enc } from "./http";
import type {
    AlbumCard, AlbumDetail, AlbumPage, ArtistDetail, ArtistPage, GenreAlbums, GenreCard, Lyrics, MusicHome, MusicQueue,
    MusicQueueInput, MusicSearch, PlaylistDetail, TrackCard,
} from "./media-types";
import type { ProfilesClient } from "./profiles";

const SUBSONIC_CLIENT = "mixaitizen";
const SUBSONIC_VERSION = "1.16.1";

export class MusicClient {
    private readonly http: ServerHttp;

    constructor(private readonly cfg: ServerConfig, private readonly profiles: ProfilesClient | null = null) {
        this.http = new ServerHttp(cfg, () => this.profiles?.headers() ?? {});
    }

    private pq(): string { return `profile=${enc(this.profiles?.profileId ?? "default")}`; }

    home(): Promise<MusicHome | null> { return this.http.get<MusicHome>(`/media/music/home?${this.pq()}`, { allow404: true }); }

    artists(opts: { letter?: string; offset?: number; limit?: number } = {}): Promise<ArtistPage | null> {
        return this.http.get<ArtistPage>(`/media/music/artists?${qs(opts)}`, { allow404: true });
    }

    artist(id: string): Promise<ArtistDetail | null> { return this.http.get<ArtistDetail>(`/media/music/artists/${enc(id)}`, { allow404: true }); }

    /** Album by Subsonic album id. */
    album(id: string): Promise<AlbumDetail | null> { return this.http.get<AlbumDetail>(`/media/music/albums/${enc(id)}`, { allow404: true }); }

    albums(opts: { letter?: string; offset?: number; limit?: number } = {}): Promise<AlbumPage | null> {
        return this.http.get<AlbumPage>(`/media/music/albums?${qs(opts)}`, { allow404: true });
    }

    async genres(): Promise<GenreCard[]> {
        const r = await this.http.get<{ genres: GenreCard[] }>("/media/music/genres", { allow404: true });
        return r?.genres ?? [];
    }

    genre(name: string, opts: { offset?: number; limit?: number } = {}): Promise<GenreAlbums | null> {
        return this.http.get<GenreAlbums>(`/media/music/genres/${enc(name)}?${qs(opts)}`, { allow404: true });
    }

    search(q: string): Promise<MusicSearch | null> { return this.http.get<MusicSearch>(`/media/music/search?q=${enc(q)}`, { allow404: true }); }

    playlist(id: string): Promise<PlaylistDetail | null> { return this.http.get<PlaylistDetail>(`/media/music/playlists/${enc(id)}`, { allow404: true }); }

    async random(size = 50): Promise<TrackCard[]> {
        const r = await this.http.get<{ tracks: TrackCard[] }>(`/media/music/random?size=${size}`, { allow404: true });
        return r?.tracks ?? [];
    }

    queue(): Promise<MusicQueue | null> { return this.http.get<MusicQueue>(`/media/music/queue?${this.pq()}`, { allow404: true }); }

    setQueue(q: MusicQueueInput): Promise<MusicQueue | null> { return this.http.put<MusicQueue>(`/media/music/queue?${this.pq()}`, q, { allow404: true }); }

    lyrics(trackId: string): Promise<Lyrics | null> { return this.http.get<Lyrics>(`/media/music/lyrics/${enc(trackId)}`, { allow404: true }); }

    // ─── Subsonic URLs (apiKey = device token) ───────────────────────────

    private sign(path: string): string {
        const sep = path.includes("?") ? "&" : "?";
        return `${this.cfg.baseUrl}${path}${sep}f=json&v=${SUBSONIC_VERSION}&c=${SUBSONIC_CLIENT}&apiKey=${enc(this.cfg.token)}`;
    }

    /** Cover URL from a card's `coverUrlPath` (server default size 400) or a raw coverArt id with `size`. */
    coverUrl(card: { coverUrlPath?: string | null; coverArt?: string | null } | null | undefined, size?: number): string | null {
        if (!card) return null;
        if (size && card.coverArt) return this.sign(`/rest/getCoverArt.view?id=${enc(card.coverArt)}&size=${size}`);
        if (card.coverUrlPath) return this.sign(card.coverUrlPath);
        if (card.coverArt) return this.sign(`/rest/getCoverArt.view?id=${enc(card.coverArt)}&size=${size ?? 400}`);
        return null;
    }

    streamUrl(track: Pick<TrackCard, "id" | "streamUrlPath">): string {
        return this.sign(track.streamUrlPath || `/rest/stream.view?id=${enc(track.id)}`);
    }

    albumCover(a: AlbumCard, size?: number): string | null { return this.coverUrl(a, size); }
}

function qs(o: Record<string, string | number | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") q.set(k, String(v));
    return q.toString();
}
