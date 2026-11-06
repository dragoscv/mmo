"use client";

/**
 * Music detail screens (WP16-40): album (play all / shuffle / play-from-here, disc groups), artist (top songs,
 * albums, similar), playlist, genre (paged albums) and search. Every screen has loading / not-found / error /
 * loaded states; playing opens nothing — the mini-player and Now Playing follow the engine.
 */
import Link, { useRouter } from "@/components/host/host-context";
import { useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ListPlus, Play, Search, Shuffle } from "lucide-react";
import { Button } from "@mmo/ui";
import type { AlbumCard, AlbumDetail, ArtistDetail, GenreAlbums, MusicSearch, PlaylistDetail, TrackCard } from "@/lib/mmo/media-types";
import type { MusicClient } from "@/lib/mmo/music";
import { fmtClock, totalSeconds } from "@/lib/mmo/music-core";
import { webMusicPlayer } from "@/lib/mmo/web-music-player";
import { rowKeys } from "../row";
import {
    AlbumTile, ArtistTile, DownloadAllButton, MusicError, MusicHero, MusicLoading, MusicNotFound, RadioButton, TileGrid, TrackList, artistHref, genreHref,
} from "./common";
import { useDownloadable, useLoad, useMusic } from "./use-music";

function PlayActions({ tracks }: { tracks: TrackCard[] }) {
    const t = useTranslations("mx.music.actions");
    if (tracks.length === 0) return null;
    return (
        <>
            <Button size="lg" onClick={() => webMusicPlayer.play(tracks, 0)}><Play aria-hidden />{t("playAll")}</Button>
            <Button size="lg" variant="secondary" onClick={() => webMusicPlayer.play(tracks, 0, { shuffle: true })}><Shuffle aria-hidden />{t("shuffle")}</Button>
            <Button size="lg" variant="ghost" onClick={() => webMusicPlayer.enqueue(tracks, "end")}><ListPlus aria-hidden />{t("addToQueue")}</Button>
        </>
    );
}

function Duration({ tracks }: { tracks: TrackCard[] }) {
    const t = useTranslations("mx.music.count");
    return <span>{t("tracks", { count: tracks.length })} · {fmtClock(totalSeconds(tracks))}</span>;
}

// ─── album ──────────────────────────────────────────────────────────────────

export function AlbumScreen({ id }: { id: string }) {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const r = useLoad<AlbumDetail | null>(music ? `album|${id}` : null, () => (music ? music.album(id) : Promise.resolve(null)));
    const dl = useDownloadable(r.data?.album.name);
    if (!music || r.status === "loading") return <div className="mu-page"><MusicLoading label={t("state.loading")} /></div>;
    if (r.status === "error") return <div className="mu-page"><MusicError onRetry={r.retry} /></div>;
    if (!r.data) return <div className="mu-page"><MusicNotFound /></div>;
    const { album, tracks } = r.data;
    return (
        <div className="mu-page" data-testid="music-album">
            <MusicHero cover={music.coverUrl(album, 600)} backdrop={music.coverUrl(album, 120)} kicker={t("album.kicker")} title={album.name}
                meta={<>
                    {album.artist ? (album.artistId ? <Link href={artistHref(album.artistId)}>{album.artist}</Link> : <span>{album.artist}</span>) : null}
                    {album.year ? <span>{album.year}</span> : null}
                    {album.genre ? <Link href={genreHref(album.genre)}>{album.genre}</Link> : null}
                    <Duration tracks={tracks} />
                </>}
                actions={<>
                    <PlayActions tracks={tracks} />
                    {tracks.length > 0 ? <RadioButton music={music} seed={album.id} /> : null}
                    <DownloadAllButton music={music} tracks={tracks} scope={dl} album={album.name} />
                </>} />
            {tracks.length > 0
                ? <TrackList music={music} tracks={tracks} numbering="track" discs label={t("album.tracklist")} downloadable={dl} />
                : <p className="text-muted-foreground">{t("album.empty")}</p>}
        </div>
    );
}

// ─── artist ─────────────────────────────────────────────────────────────────

export function ArtistScreen({ id }: { id: string }) {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const r = useLoad<ArtistDetail | null>(music ? `artist|${id}` : null, () => (music ? music.artist(id) : Promise.resolve(null)));
    const dl = useDownloadable();
    if (!music || r.status === "loading") return <div className="mu-page"><MusicLoading label={t("state.loading")} /></div>;
    if (r.status === "error") return <div className="mu-page"><MusicError onRetry={r.retry} /></div>;
    if (!r.data) return <div className="mu-page"><MusicNotFound /></div>;
    const { artist, albums, topTracks, similar } = r.data;
    const bg = music.coverUrl(artist, 120) ?? (albums[0] ? music.coverUrl(albums[0], 120) : null);
    return (
        <div className="mu-page" data-testid="music-artist">
            <MusicHero round cover={music.coverUrl(artist, 600)} backdrop={bg} kicker={t("artist.kicker")} title={artist.name}
                meta={<>
                    <span>{t("count.albums", { count: artist.albumCount })}</span>
                    <span>{t("count.tracks", { count: artist.songCount })}</span>
                </>}
                actions={<>
                    <PlayActions tracks={topTracks} />
                    {artist.songCount > 0 ? <RadioButton music={music} seed={artist.id} /> : null}
                </>} />
            {topTracks.length > 0 ? (
                <section aria-labelledby="mu-top">
                    <h2 id="mu-top" className="mu-section-title">{t("artist.top")}</h2>
                    <TrackList music={music} tracks={topTracks.slice(0, 10)} showAlbum showCover label={t("artist.top")} downloadable={dl} />
                </section>
            ) : null}
            {albums.length > 0 ? (
                <section aria-labelledby="mu-albums">
                    <h2 id="mu-albums" className="mu-section-title">{t("artist.albums")}</h2>
                    <TileGrid label={t("artist.albums")}>
                        {albums.map((a) => <li key={a.id}><AlbumTile music={music} album={a} sub={a.year ? String(a.year) : t("count.tracks", { count: a.songCount })} /></li>)}
                    </TileGrid>
                </section>
            ) : null}
            {similar.length > 0 ? (
                <section aria-labelledby="mu-similar">
                    <h2 id="mu-similar" className="mu-section-title">{t("artist.similar")}</h2>
                    <ul className="mu-row" onKeyDown={rowKeys} data-mx-row>
                        {similar.map((a) => <li key={a.id}><ArtistTile music={music} artist={a} /></li>)}
                    </ul>
                </section>
            ) : null}
        </div>
    );
}

// ─── playlist ───────────────────────────────────────────────────────────────

export function PlaylistScreen({ id }: { id: string }) {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const r = useLoad<PlaylistDetail | null>(music ? `pl|${id}` : null, () => (music ? music.playlist(id) : Promise.resolve(null)));
    const dl = useDownloadable();
    if (!music || r.status === "loading") return <div className="mu-page"><MusicLoading label={t("state.loading")} /></div>;
    if (r.status === "error") return <div className="mu-page"><MusicError onRetry={r.retry} /></div>;
    if (!r.data) return <div className="mu-page"><MusicNotFound /></div>;
    const { playlist, tracks } = r.data;
    return (
        <div className="mu-page" data-testid="music-playlist">
            <MusicHero cover={music.coverUrl(playlist, 600)} backdrop={music.coverUrl(playlist, 120)} kicker={t("playlist.kicker")} title={playlist.name}
                meta={<Duration tracks={tracks} />}
                actions={<><PlayActions tracks={tracks} /><DownloadAllButton music={music} tracks={tracks} scope={dl} /></>} />
            {tracks.length > 0
                ? <TrackList music={music} tracks={tracks} showArtist showAlbum showCover label={playlist.name} downloadable={dl} />
                : <p className="text-muted-foreground">{t("playlist.empty")}</p>}
        </div>
    );
}

// ─── genre ──────────────────────────────────────────────────────────────────

const GENRE_PAGE = 100;

export function GenreScreen({ name }: { name: string }) {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const [extra, setExtra] = useState<{ name: string; items: AlbumCard[] }>({ name: "", items: [] });
    const [more, setMore] = useState(false);
    const r = useLoad<GenreAlbums | null>(music ? `genre|${name}` : null, () => (music ? music.genre(name, { limit: GENRE_PAGE }) : Promise.resolve(null)));
    if (!music || r.status === "loading") return <div className="mu-page"><MusicLoading label={t("state.loading")} /></div>;
    if (r.status === "error") return <div className="mu-page"><MusicError onRetry={r.retry} /></div>;
    const items = [...(r.data?.items ?? []), ...(extra.name === name ? extra.items : [])];
    const total = r.data?.total ?? 0;
    if (items.length === 0) return <div className="mu-page"><MusicNotFound /></div>;

    const loadMore = async () => {
        setMore(true);
        try {
            const p = await music.genre(name, { offset: items.length, limit: GENRE_PAGE });
            setExtra((e) => ({ name, items: [...(e.name === name ? e.items : []), ...(p?.items ?? [])] }));
        } catch { /* keep */ } finally { setMore(false); }
    };

    return (
        <div className="mu-page" data-testid="music-genre">
            <div className="mu-head">
                <div>
                    <p className="mu-hero-kicker">{t("genre.kicker")}</p>
                    <h1 className="mu-title">{name}</h1>
                    <p className="text-muted-foreground">{t("count.albums", { count: total })}</p>
                </div>
            </div>
            <TileGrid label={name}>
                {items.map((a) => <li key={a.id}><AlbumTile music={music} album={a} /></li>)}
            </TileGrid>
            {items.length < total ? (
                <div className="flex justify-center">
                    <Button variant="outline" onClick={() => void loadMore()} loading={more}>{t("letters.more", { shown: items.length, total })}</Button>
                </div>
            ) : null}
        </div>
    );
}

// ─── search ─────────────────────────────────────────────────────────────────

export function MusicSearchScreen() {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const router = useRouter();
    const params = useSearchParams();
    const q = (params?.get("q") ?? "").trim();
    const [input, setInput] = useState(q);
    // Follow URL changes (back/forward) by adjusting state during render, not in an effect.
    const [prevQ, setPrevQ] = useState(q);
    if (prevQ !== q) { setPrevQ(q); setInput(q); }

    // Debounced live search while typing (URL stays the source of truth).
    useEffect(() => {
        const s = input.trim();
        if (s === q) return;
        const h = setTimeout(() => router.replace(s ? `/media/music/search?q=${encodeURIComponent(s)}` : "/media/music/search", { scroll: false }), 350);
        return () => clearTimeout(h);
    }, [input, q, router]);

    const r = useLoad<MusicSearch | null>(music && q ? `search|${q}` : null, () => (music ? music.search(q) : Promise.resolve(null)));
    const dl = useDownloadable();
    const onSubmit = (e: FormEvent) => {
        e.preventDefault();
        const s = input.trim();
        router.replace(s ? `/media/music/search?q=${encodeURIComponent(s)}` : "/media/music/search");
    };
    const res = r.data;
    const nothing = !!res && res.artists.length === 0 && res.albums.length === 0 && res.tracks.length === 0;

    return (
        <div className="mu-page" data-testid="music-search">
            <div className="mu-head">
                <h1 className="mu-title">{t("search.title")}</h1>
                <form role="search" className="mu-search" onSubmit={onSubmit}>
                    <Search aria-hidden className="size-4 text-muted-foreground" />
                    <input type="search" autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder={t("search.placeholder")}
                        aria-label={t("search.label")} enterKeyHint="search" />
                </form>
            </div>
            {!music ? null
                : !q ? <p className="text-muted-foreground">{t("search.hint")}</p>
                    : r.status === "loading" ? <MusicLoading label={t("state.loading")} />
                        : r.status === "error" ? <MusicError onRetry={r.retry} />
                            : !res || nothing ? <p className="text-muted-foreground" role="status">{t("search.none", { q })}</p>
                                : (
                                    <div className="flex flex-col gap-8" aria-live="polite">
                                        {res.tracks.length > 0 ? (
                                            <section aria-labelledby="mu-s-tracks">
                                                <h2 id="mu-s-tracks" className="mu-section-title">{t("search.tracks")}</h2>
                                                <TrackList music={music} tracks={res.tracks} showArtist showAlbum showCover label={t("search.tracks")}
                                                    onPlay={(i) => webMusicPlayer.play(res.tracks, i)} downloadable={dl} />
                                            </section>
                                        ) : null}
                                        {res.artists.length > 0 ? (
                                            <section aria-labelledby="mu-s-artists">
                                                <h2 id="mu-s-artists" className="mu-section-title">{t("search.artists")}</h2>
                                                <ul className="mu-row" onKeyDown={rowKeys} data-mx-row>
                                                    {res.artists.map((a) => <li key={a.id}><ArtistTile music={music} artist={a} /></li>)}
                                                </ul>
                                            </section>
                                        ) : null}
                                        {res.albums.length > 0 ? (
                                            <section aria-labelledby="mu-s-albums">
                                                <h2 id="mu-s-albums" className="mu-section-title">{t("search.albums")}</h2>
                                                <TileGrid label={t("search.albums")}>
                                                    {res.albums.map((a) => <li key={a.id}><AlbumTile music={music} album={a} /></li>)}
                                                </TileGrid>
                                            </section>
                                        ) : null}
                                    </div>
                                )}
        </div>
    );
}
