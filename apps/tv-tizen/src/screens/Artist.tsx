/**
 * Artist (WP16-33): round cover hero, Play / Shuffle (top tracks, then every album track), top tracks,
 * albums by year (newest first), similar artists.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/messages";
import type { AlbumCard, ArtistDetail, TrackCard } from "../lib/media-types";
import { musicPlayer } from "../lib/music-player";
import type { ScreenProps } from "../nav/ctx";
import { Empty, ErrorState, LoadingBlock, PrimaryButton, Row, SecondaryButton } from "../ui";
import { AlbumTile, ArtistTile, MusicHero, TrackList, playAndOpen, useCoverBackdrop } from "./music/common";

function byYear(a: AlbumCard[]): AlbumCard[] {
    return a.slice().sort((x, y) => (y.year ?? 0) - (x.year ?? 0) || x.name.localeCompare(y.name));
}

export function Artist({ ctx, params }: ScreenProps<"artist">) {
    const { music, nav } = ctx;
    const [data, setData] = useState<ArtistDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [missing, setMissing] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => { musicPlayer.attach(music, ctx.media); }, [music, ctx.media]);

    const load = useCallback(() => {
        setError(null);
        music.artist(params.id).then((d) => { if (d) setData(d); else setMissing(true); }).catch((e: Error) => setError(e.message));
    }, [music, params.id]);
    useEffect(load, [load]);
    useCoverBackdrop(data ? music.coverUrl(data.artist, 64) : undefined);

    const open = () => nav.push({ name: "nowPlaying" });
    /** All tracks of the artist (top tracks first, then albums by year, de-duplicated). */
    const allTracks = useCallback(async (): Promise<TrackCard[]> => {
        if (!data) return [];
        const seen = new Set<string>();
        const out: TrackCard[] = [];
        const push = (ts: TrackCard[]) => { for (const x of ts) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); } };
        push(data.topTracks);
        for (const a of byYear(data.albums).slice(0, 25)) {
            const d = await music.album(a.id).catch(() => null);
            if (d) push(d.tracks);
        }
        return out;
    }, [data, music]);

    const playAll = async (shuffle: boolean) => {
        setBusy(true);
        try { playAndOpen(await allTracks(), 0, open, shuffle); } finally { setBusy(false); }
    };

    if (error) return <div className="tv-screen" data-scroll="screen"><ErrorState message={error} onRetry={load} /></div>;
    if (missing) return <div className="tv-screen" data-scroll="screen"><Empty icon="user" title={t("music.artistMissing")} action={{ label: t("common.back"), onClick: () => nav.pop() }} /></div>;
    if (!data) return <div className="tv-screen" data-scroll="screen"><LoadingBlock lines={4} /></div>;

    const a = data.artist;
    const albums = byYear(data.albums);
    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-artist">
            <MusicHero round cover={music.coverUrl(a, 400)} kicker={t("screen.artist")} title={a.name}
                meta={[t("music.albumsCount", { n: a.albumCount }), t("music.tracksCount", { n: a.songCount })].join(" · ")}
                actions={<>
                    <PrimaryButton icon="play" label={t("music.play")} onClick={() => { void playAll(false); }} focusKey="ar:play" disabled={busy} autoFocus />
                    <SecondaryButton icon="shuffle" label={t("music.shuffle")} onClick={() => { void playAll(true); }} focusKey="ar:shuffle" disabled={busy} />
                </>} />
            {data.topTracks.length > 0 && (
                <section className="vrow">
                    <h2 className="vrow-title">{t("music.topTracks")}</h2>
                    <TrackList tracks={data.topTracks.slice(0, 10)} listId="ar-top" showAlbum onSelect={(i) => playAndOpen(data.topTracks, i, open)} />
                </section>
            )}
            {albums.length > 0 && (
                <Row rowId="ar-albums" title={t("music.albums")} kind="square" items={albums} itemKey={(x) => x.id}
                    renderItem={(x) => <AlbumTile music={music} album={x} sub={x.year ? String(x.year) : undefined} focusKey={`ar-albums:${x.id}`} onSelect={() => nav.push({ name: "album", id: x.id, seed: x })} />} />
            )}
            {data.similar.length > 0 && (
                <Row rowId="ar-similar" title={t("music.similar")} kind="square" items={data.similar} itemKey={(x) => x.id}
                    renderItem={(x) => <ArtistTile music={music} artist={x} focusKey={`ar-similar:${x.id}`} onSelect={() => nav.push({ name: "artist", id: x.id })} />} />
            )}
        </div>
    );
}
