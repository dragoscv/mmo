/**
 * Music tabs (WP16-33): Home rows, Artists / Albums A–Z paged grids, Playlists, Search, plus in-screen
 * sub-views (playlist tracks, genre albums) that close on Back.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n/messages";
import type { MusicClient } from "../../lib/music";
import type { AlbumCard, ArtistCard, GenreCard, MusicHome, MusicSearch, PlaylistCard, PlaylistDetail, TrackCard } from "../../lib/media-types";
import { useBackHandler } from "../../nav/back";
import type { NavApi } from "../../nav/Nav";
import {
    Chips, Empty, ErrorState, Grid, Keyboard, LoadingBlock, LoadingRows, PrimaryButton, Row, SecondaryButton,
} from "../../ui";
import { AlbumTile, ArtistTile, MusicHero, PlaylistTile, TrackList, TrackTile, playAndOpen, totalDuration } from "./common";

const PAGE = 120;
export const LETTERS = ["all", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "#"];

export interface TabProps {
    music: MusicClient;
    nav: NavApi;
    /** Backdrop: low-res cover URL of the focused item. */
    onCover: (url: string | null) => void;
}

const openNowPlaying = (nav: NavApi) => () => nav.push({ name: "nowPlaying" });

// ─── Home ──────────────────────────────────────────────────────────────────

export function HomeTab({ music, nav, onCover, home, onGenre, onPlaylist }: TabProps & {
    home: MusicHome; onGenre: (g: GenreCard) => void; onPlaylist: (p: PlaylistCard) => void;
}) {
    const [busy, setBusy] = useState(false);
    const shuffleAll = useCallback(async () => {
        setBusy(true);
        try {
            const tracks = await music.random(200);
            playAndOpen(tracks, 0, openNowPlaying(nav), true);
        } finally { setBusy(false); }
    }, [music, nav]);
    const album = (rowId: string) => (a: AlbumCard) => (
        <AlbumTile music={music} album={a} focusKey={`${rowId}:${a.id}`} onSelect={() => nav.push({ name: "album", id: a.id, seed: a })}
            onFocus={() => onCover(music.coverUrl(a, 64))} />
    );
    return (
        <div className="mu-section">
            <div className="mu-hero-actions" data-focus-row="mu-home-actions" style={{ marginTop: 0, marginBottom: "1.2rem" }}>
                <PrimaryButton icon="shuffle" label={t("music.shuffleAll")} onClick={() => { void shuffleAll(); }} focusKey="mu:shuffleAll" disabled={busy} testId="music-shuffle-all" />
            </div>
            {home.recent.length > 0 && <Row rowId="mu-recent" title={t("music.recent")} kind="square" items={home.recent} itemKey={(a) => a.id} renderItem={album("mu-recent")} />}
            {home.newest.length > 0 && <Row rowId="mu-newest" title={t("music.newest")} kind="square" items={home.newest} itemKey={(a) => a.id} renderItem={album("mu-newest")} />}
            {home.mostPlayed.length > 0 && (
                <Row rowId="mu-most" title={t("music.mostPlayed")} kind="square" items={home.mostPlayed} itemKey={(x) => x.id}
                    renderItem={(x, i) => <TrackTile music={music} track={x} focusKey={`mu-most:${x.id}`} onSelect={() => playAndOpen(home.mostPlayed, i, openNowPlaying(nav))} onFocus={() => onCover(music.coverUrl(x, 64))} />} />
            )}
            {home.playlists.length > 0 && (
                <Row rowId="mu-pl" title={t("music.playlists")} kind="square" items={home.playlists} itemKey={(p) => p.id}
                    renderItem={(p) => <PlaylistTile music={music} playlist={p} focusKey={`mu-pl:${p.id}`} onSelect={() => onPlaylist(p)} onFocus={() => onCover(music.coverUrl(p, 64))} />} />
            )}
            {home.genres.length > 0 && (
                <section className="vrow">
                    <h2 className="vrow-title">{t("music.genres")}</h2>
                    <Chips rowId="mu-genres" wrap items={home.genres.slice(0, 24).map((g) => ({ id: g.name, label: `${g.name} · ${g.albumCount}` }))}
                        onChange={(id) => { const g = home.genres.find((x) => x.name === id); if (g) onGenre(g); }} />
                </section>
            )}
            {home.randomAlbums.length > 0 && <Row rowId="mu-random" title={t("music.randomAlbums")} kind="square" items={home.randomAlbums} itemKey={(a) => a.id} renderItem={album("mu-random")} />}
        </div>
    );
}

// ─── Paged A–Z grid (artists / albums) ─────────────────────────────────────

interface Paged<T> { items: T[]; total: number | null; error: string | null; more: () => void; retry: () => void }

function usePaged<T>(load: (letter: string | undefined, offset: number) => Promise<{ total: number; items: T[] } | null>, letter: string): Paged<T> {
    const [items, setItems] = useState<T[]>([]);
    const [total, setTotal] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const loading = useRef(false);
    const gen = useRef(0);
    const fetchMore = useCallback(async (reset: boolean) => {
        if (loading.current && !reset) return;
        const g = reset ? ++gen.current : gen.current;
        loading.current = true;
        try {
            const off = reset ? 0 : items.length;
            const r = await load(letter === "all" ? undefined : letter, off);
            if (g !== gen.current) return;
            setTotal(r?.total ?? 0);
            setItems((cur) => (reset ? r?.items ?? [] : [...cur, ...(r?.items ?? [])]));
            setError(null);
        } catch (e) {
            if (g === gen.current) setError((e as Error).message);
        } finally {
            if (g === gen.current) loading.current = false;
        }
    }, [load, letter, items.length]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { setItems([]); setTotal(null); void fetchMore(true); }, [letter, load]);
    const more = useCallback(() => { if (total !== null && items.length < total) void fetchMore(false); }, [total, items.length, fetchMore]);
    return { items, total, error, more, retry: () => void fetchMore(true) };
}

function AzGrid<T>({ gridId, header, letter, setLetter, paged, render, emptyMsg }: {
    gridId: string; header: ReactNode; letter: string; setLetter: (l: string) => void;
    paged: Paged<T>; render: (x: T, i: number) => ReactNode; emptyMsg: string;
}) {
    const head = (
        <>
            {header}
            <Chips className="mu-letters" rowId={`${gridId}-letters`} wrap value={letter}
                items={LETTERS.map((l) => ({ id: l, label: l === "all" ? t("music.all") : l }))} onChange={setLetter} />
            {paged.error && <ErrorState message={paged.error} onRetry={paged.retry} />}
            {!paged.error && paged.total === null && <LoadingRows rows={2} kind="square" />}
            {!paged.error && paged.total === 0 && <Empty icon="music" title={emptyMsg} />}
        </>
    );
    return (
        <Grid gridId={gridId} kind="square" items={paged.items} itemKey={(_x, i) => `${gridId}-${i}`} renderItem={render}
            onEndReached={paged.more} header={head} />
    );
}

export function ArtistsTab({ music, nav, onCover, header }: TabProps & { header: ReactNode }) {
    const [letter, setLetter] = useState("all");
    const load = useCallback((l: string | undefined, offset: number) => music.artists({ letter: l, offset, limit: PAGE }), [music]);
    const paged = usePaged<ArtistCard>(load, letter);
    return (
        <AzGrid gridId="mu-artists" header={header} letter={letter} setLetter={setLetter} paged={paged} emptyMsg={t("music.noneLetter")}
            render={(a) => <ArtistTile music={music} artist={a} focusKey={`mu-artists:${a.id}`} onSelect={() => nav.push({ name: "artist", id: a.id })} onFocus={() => onCover(music.coverUrl(a, 64))} />} />
    );
}

export function AlbumsTab({ music, nav, onCover, header }: TabProps & { header: ReactNode }) {
    const [letter, setLetter] = useState("all");
    const load = useCallback((l: string | undefined, offset: number) => music.albums({ letter: l, offset, limit: PAGE }), [music]);
    const paged = usePaged<AlbumCard>(load, letter);
    return (
        <AzGrid gridId="mu-albums" header={header} letter={letter} setLetter={setLetter} paged={paged} emptyMsg={t("music.noneLetter")}
            render={(a) => <AlbumTile music={music} album={a} focusKey={`mu-albums:${a.id}`} onSelect={() => nav.push({ name: "album", id: a.id, seed: a })} onFocus={() => onCover(music.coverUrl(a, 64))} />} />
    );
}

// ─── Playlists ─────────────────────────────────────────────────────────────

export function PlaylistsTab({ music, onCover, playlists, onOpen, header }: TabProps & {
    playlists: PlaylistCard[]; onOpen: (p: PlaylistCard) => void; header: ReactNode;
}) {
    const head = <>{header}{playlists.length === 0 && <Empty icon="queue" title={t("music.noPlaylists")} message={t("music.noPlaylistsMsg")} />}</>;
    return (
        <Grid gridId="mu-playlists" kind="square" items={playlists} itemKey={(p) => p.id} header={head}
            renderItem={(p) => <PlaylistTile music={music} playlist={p} focusKey={`mu-playlists:${p.id}`} onSelect={() => onOpen(p)} onFocus={() => onCover(music.coverUrl(p, 64))} />} />
    );
}

/** Playlist tracks (sub-view; Back closes). */
export function PlaylistView({ music, nav, onCover, playlist, onClose }: TabProps & { playlist: PlaylistCard; onClose: () => void }) {
    const [data, setData] = useState<PlaylistDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    useBackHandler(() => { onClose(); }, true);
    const load = useCallback(() => {
        setError(null);
        music.playlist(playlist.id).then((d) => setData(d ?? { playlist, tracks: [] })).catch((e: Error) => setError(e.message));
    }, [music, playlist]);
    useEffect(load, [load]);
    useEffect(() => { onCover(music.coverUrl(playlist, 64)); }, [music, playlist, onCover]);
    const tracks = data?.tracks ?? [];
    const open = openNowPlaying(nav);
    return (
        <div className="mu-section" data-testid="music-playlist">
            <MusicHero cover={music.coverUrl(playlist, 400)} kicker={t("music.playlist")} title={playlist.name}
                meta={[t("music.tracksCount", { n: tracks.length || playlist.songCount }), totalDuration(tracks)].filter(Boolean).join(" · ")}
                actions={<>
                    <PrimaryButton icon="play" label={t("music.play")} onClick={() => playAndOpen(tracks, 0, open)} focusKey="mu-pl:play" disabled={tracks.length === 0} autoFocus />
                    <SecondaryButton icon="shuffle" label={t("music.shuffle")} onClick={() => playAndOpen(tracks, 0, open, true)} focusKey="mu-pl:shuffle" disabled={tracks.length === 0} />
                </>} />
            {error && <ErrorState message={error} onRetry={load} />}
            {!error && !data && <LoadingBlock lines={6} />}
            {data && tracks.length === 0 && <Empty icon="queue" title={t("music.emptyPlaylist")} />}
            {tracks.length > 0 && <TrackList tracks={tracks} listId="mu-pl-tracks" showArtist showAlbum onSelect={(i) => playAndOpen(tracks, i, open)} />}
        </div>
    );
}

/** Genre albums (sub-view; Back closes). */
export function GenreView({ music, nav, onCover, genre, onClose, header }: TabProps & { genre: GenreCard; onClose: () => void; header: ReactNode }) {
    const [items, setItems] = useState<AlbumCard[] | null>(null);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState<string | null>(null);
    useBackHandler(() => { onClose(); }, true);
    const load = useCallback((offset: number) => {
        music.genre(genre.name, { offset, limit: PAGE }).then((r) => {
            setTotal(r?.total ?? 0);
            setItems((cur) => (offset === 0 ? r?.items ?? [] : [...(cur ?? []), ...(r?.items ?? [])]));
        }).catch((e: Error) => setError(e.message));
    }, [music, genre]);
    useEffect(() => load(0), [load]);
    const head = (
        <>
            {header}
            <h2 className="vrow-title">{t("music.genreTitle", { name: genre.name })}</h2>
            {error && <ErrorState message={error} onRetry={() => load(0)} />}
            {!error && items === null && <LoadingRows rows={2} kind="square" />}
            {items && items.length === 0 && <Empty icon="music" title={t("music.noneLetter")} />}
        </>
    );
    return (
        <Grid gridId="mu-genre" kind="square" items={items ?? []} itemKey={(a) => a.id} header={head}
            onEndReached={() => { if (items && items.length < total) load(items.length); }}
            renderItem={(a) => <AlbumTile music={music} album={a} focusKey={`mu-genre:${a.id}`} onSelect={() => nav.push({ name: "album", id: a.id, seed: a })} onFocus={() => onCover(music.coverUrl(a, 64))} />} />
    );
}

// ─── Search ────────────────────────────────────────────────────────────────

export function SearchTab({ music, nav, onCover }: TabProps) {
    const [q, setQ] = useState("");
    const [res, setRes] = useState<MusicSearch | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const query = q.trim();
        if (query.length < 2) { setRes(null); setBusy(false); return; }
        setBusy(true);
        let alive = true;
        const h = setTimeout(() => {
            music.search(query).then((r) => { if (alive) { setRes(r); setError(null); } })
                .catch((e: Error) => { if (alive) setError(e.message); })
                .finally(() => { if (alive) setBusy(false); });
        }, 400);
        return () => { alive = false; clearTimeout(h); };
    }, [q, music]);
    const open = openNowPlaying(nav);
    const tracks: TrackCard[] = res?.tracks ?? [];
    const none = res && res.artists.length + res.albums.length + tracks.length === 0;
    return (
        <div className="mu-search" data-testid="music-search">
            <div className="mu-search-kb">
                <div className="mu-search-field" aria-live="polite">{q ? q : <span className="ph">{t("music.searchPlaceholder")}</span>}</div>
                <Keyboard id="mu-kb" value={q} onChange={setQ} />
            </div>
            <div className="mu-search-results">
                {error && <ErrorState message={error} />}
                {!error && q.trim().length < 2 && <Empty icon="search" title={t("music.searchHint")} />}
                {!error && busy && !res && <LoadingRows rows={2} kind="square" count={5} />}
                {none && <Empty icon="search" title={t("music.searchNone", { q: q.trim() })} />}
                {res && res.artists.length > 0 && (
                    <Row rowId="mu-s-artists" title={t("music.artists")} kind="square" items={res.artists} itemKey={(a) => a.id}
                        renderItem={(a) => <ArtistTile music={music} artist={a} focusKey={`mu-s-ar:${a.id}`} onSelect={() => nav.push({ name: "artist", id: a.id })} onFocus={() => onCover(music.coverUrl(a, 64))} />} />
                )}
                {res && res.albums.length > 0 && (
                    <Row rowId="mu-s-albums" title={t("music.albums")} kind="square" items={res.albums} itemKey={(a) => a.id}
                        renderItem={(a) => <AlbumTile music={music} album={a} focusKey={`mu-s-al:${a.id}`} onSelect={() => nav.push({ name: "album", id: a.id, seed: a })} onFocus={() => onCover(music.coverUrl(a, 64))} />} />
                )}
                {tracks.length > 0 && (
                    <section className="vrow">
                        <h2 className="vrow-title">{t("music.tracks")}</h2>
                        <TrackList tracks={tracks.slice(0, 30)} listId="mu-s-tracks" showArtist showAlbum onSelect={(i) => playAndOpen(tracks.slice(0, 30), i, open)} />
                    </section>
                )}
            </div>
        </div>
    );
}
