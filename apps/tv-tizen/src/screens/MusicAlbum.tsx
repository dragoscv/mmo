/**
 * Album (WP16-33): cover hero, chips (year, genre, format), Play / Shuffle / Add to queue / Artist, track
 * list with lyrics badge; OK on a track → play from that index → Now Playing.
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/messages";
import type { AlbumDetail } from "../lib/media-types";
import { musicPlayer } from "../lib/music-player";
import type { ScreenProps } from "../nav/ctx";
import { Empty, ErrorState, GhostButton, LoadingBlock, PrimaryButton, SecondaryButton } from "../ui";
import { MusicHero, TrackList, playAndOpen, totalDuration, useCoverBackdrop } from "./music/common";

export function MusicAlbum({ ctx, params }: ScreenProps<"album">) {
    const { music, nav } = ctx;
    const [data, setData] = useState<AlbumDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [missing, setMissing] = useState(false);
    const [queued, setQueued] = useState(false);
    useEffect(() => { musicPlayer.attach(music, ctx.media); }, [music, ctx.media]);

    const load = useCallback(() => {
        setError(null);
        music.album(params.id).then((d) => { if (d) setData(d); else setMissing(true); }).catch((e: Error) => setError(e.message));
    }, [music, params.id]);
    useEffect(load, [load]);

    const album = data?.album ?? params.seed ?? null;
    useCoverBackdrop(album ? music.coverUrl(album, 64) : undefined);
    const tracks = data?.tracks ?? [];
    const open = () => nav.push({ name: "nowPlaying" });

    if (error) return <div className="tv-screen" data-scroll="screen"><ErrorState message={error} onRetry={load} /></div>;
    if (missing) return <div className="tv-screen" data-scroll="screen"><Empty icon="music" title={t("music.albumMissing")} action={{ label: t("common.back"), onClick: () => nav.pop() }} /></div>;

    const formats = Array.from(new Set(tracks.map((x) => x.format?.toUpperCase()).filter(Boolean)));
    const chips = album ? [album.year ? String(album.year) : null, album.genre ?? null, ...formats].filter(Boolean) as string[] : [];
    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-album">
            <MusicHero cover={album ? music.coverUrl(album, 400) : null} kicker={t("screen.album")} title={album?.name ?? "…"}
                meta={album ? [album.artist, t("music.tracksCount", { n: tracks.length || album.songCount }), totalDuration(tracks)].filter(Boolean).join(" · ") : undefined}
                chips={chips.map((c) => <span key={c} className="badge badge-neutral">{c}</span>)}
                actions={<>
                    <PrimaryButton icon="play" label={t("music.play")} onClick={() => playAndOpen(tracks, 0, open)} focusKey="al:play" disabled={tracks.length === 0} autoFocus />
                    <SecondaryButton icon="shuffle" label={t("music.shuffle")} onClick={() => playAndOpen(tracks, 0, open, true)} focusKey="al:shuffle" disabled={tracks.length === 0} />
                    <SecondaryButton icon={queued ? "check" : "queue"} label={queued ? t("music.queued") : t("music.addToQueue")} focusKey="al:queue"
                        disabled={tracks.length === 0} onClick={() => { musicPlayer.enqueue(tracks, "end"); setQueued(true); }} />
                    {album?.artistId && <GhostButton icon="user" label={album.artist ?? t("screen.artist")} focusKey="al:artist" onClick={() => nav.push({ name: "artist", id: album.artistId! })} />}
                </>} />
            {!data && <LoadingBlock lines={6} />}
            {data && tracks.length === 0 && <Empty icon="music" title={t("album.empty")} />}
            {tracks.length > 0 && <TrackList tracks={tracks} listId="al-tracks" numbering="track" discs onSelect={(i) => playAndOpen(tracks, i, open)} />}
        </div>
    );
}
