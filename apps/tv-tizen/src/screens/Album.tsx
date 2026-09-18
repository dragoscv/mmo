import { useEffect, useState } from "react";
import type { MmoClient, SubsonicAlbum, SubsonicSong } from "../lib/api";
import { focusFirst } from "../lib/focus";
import { fmtDuration } from "../lib/format";
import { t } from "../i18n/messages";

interface Props {
    client: MmoClient;
    album: SubsonicAlbum;
    onPlay: (album: SubsonicAlbum, songs: SubsonicSong[], index: number) => void;
}

export function AlbumScreen({ client, album, onPlay }: Props) {
    const [songs, setSongs] = useState<SubsonicSong[] | null>(album.song ?? null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        client.album(album.id)
            .then((a) => { if (alive) setSongs(a?.song ?? []); })
            .catch((e: Error) => { if (alive) setError(e.message); });
        return () => { alive = false; };
    }, [client, album.id]);

    useEffect(() => {
        if (songs) { const t = setTimeout(() => focusFirst(), 30); return () => clearTimeout(t); }
    }, [songs]);

    return (
        <div className="screen">
            <div className="album-head">
                {album.coverArt ? <img src={client.coverArtUrl(album.coverArt, 400)} alt="" /> : <div className="art placeholder" style={{ width: 220, height: 220 }}>♪</div>}
                <div>
                    <h1 className="screen-title">{album.name}</h1>
                    <p className="screen-sub" style={{ margin: 0 }}>
                        {[album.artist, album.year, album.genre, album.songCount ? t("home.songs", { n: album.songCount }) : null, fmtDuration(album.duration)].filter(Boolean).join(" · ")}
                    </p>
                </div>
            </div>
            {error && <div className="empty">{t("common.error", { message: error })}</div>}
            {!songs && !error && (
                <div className="list" aria-busy="true" data-testid="album-skeleton">
                    {Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton skeleton-line" />)}
                </div>
            )}
            {songs && (
                <div className="list">
                    {songs.length === 0 && <div className="empty">{t("album.empty")}</div>}
                    {songs.map((s, i) => (
                        <button key={s.id} className="list-item" data-focusable onClick={() => onPlay(album, songs, i)}>
                            <span className="num">{s.track ?? i + 1}</span>
                            <span className="grow">{s.title}</span>
                            <span className="dur">{fmtDuration(s.duration) ?? ""}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
