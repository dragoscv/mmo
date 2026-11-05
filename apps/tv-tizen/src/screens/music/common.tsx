/**
 * Shared music UI (WP16-33): cards, track list, low-res artwork backdrop, header with play/shuffle.
 * Artwork-first: covers are square cards; the backdrop is the SAME cover at 64 px scaled up by the backdrop
 * layer (natural blur, no CSS filter — too expensive on Tizen).
 */
import { useEffect, type ReactNode } from "react";
import { t } from "../../i18n/messages";
import { fmtDuration } from "../../lib/format";
import type { MusicClient } from "../../lib/music";
import type { AlbumCard, ArtistCard, PlaylistCard, TrackCard } from "../../lib/media-types";
import { musicPlayer, useMusicState } from "../../lib/music-player";
import { remPx } from "../../lib/image";
import { useScreenActive } from "../../nav/Nav";
import { Icon, PosterCard, CARD_REM, useBackdrop } from "../../ui";
import "./music.css";

export const COVER_PX = Math.round(remPx(CARD_REM.square) * 1.1);

export function coverPx(): number { return Math.max(150, Math.min(400, COVER_PX)); }

/** Shows `url` (a 64 px cover) as the backdrop while this screen is active. */
export function useCoverBackdrop(url: string | null | undefined): void {
    const bd = useBackdrop();
    const active = useScreenActive();
    useEffect(() => {
        if (active && url !== undefined) bd.show(url ?? null);
    }, [active, url, bd]);
}

export function AlbumTile({ music, album, focusKey, onSelect, onFocus, sub }: {
    music: MusicClient; album: AlbumCard; focusKey: string; onSelect: () => void; onFocus?: () => void; sub?: string;
}) {
    return (
        <PosterCard square focusKey={focusKey} title={album.name} subtitle={sub ?? [album.artist, album.year].filter(Boolean).join(" · ")}
            image={music.coverUrl(album, coverPx())} placeholderIcon="music" onSelect={onSelect} onFocus={onFocus} alwaysShowTitle />
    );
}

export function ArtistTile({ music, artist, focusKey, onSelect, onFocus }: {
    music: MusicClient; artist: ArtistCard; focusKey: string; onSelect: () => void; onFocus?: () => void;
}) {
    return (
        <PosterCard square focusKey={focusKey} title={artist.name} subtitle={t("music.albumsCount", { n: artist.albumCount })}
            image={music.coverUrl(artist, coverPx())} placeholderIcon="user" onSelect={onSelect} onFocus={onFocus} alwaysShowTitle
            className="mcard-round" />
    );
}

export function PlaylistTile({ music, playlist, focusKey, onSelect, onFocus }: {
    music: MusicClient; playlist: PlaylistCard; focusKey: string; onSelect: () => void; onFocus?: () => void;
}) {
    return (
        <PosterCard square focusKey={focusKey} title={playlist.name} subtitle={t("music.tracksCount", { n: playlist.songCount })}
            image={music.coverUrl(playlist, coverPx())} placeholderIcon="queue" onSelect={onSelect} onFocus={onFocus} alwaysShowTitle />
    );
}

export function TrackTile({ music, track, focusKey, onSelect, onFocus }: {
    music: MusicClient; track: TrackCard; focusKey: string; onSelect: () => void; onFocus?: () => void;
}) {
    return (
        <PosterCard square focusKey={focusKey} title={track.title} subtitle={track.artist ?? undefined}
            image={music.coverUrl(track, coverPx())} placeholderIcon="music" onSelect={onSelect} onFocus={onFocus} alwaysShowTitle />
    );
}

/** Equaliser glyph for the playing row (transform-only animation; static under reduced motion). */
export function PlayingBars({ playing }: { playing: boolean }) {
    return (
        <span className={`mu-bars${playing ? " is-on" : ""}`} aria-hidden="true">
            <i /><i /><i />
        </span>
    );
}

export interface TrackListProps {
    tracks: TrackCard[];
    listId: string;
    onSelect: (index: number) => void;
    /** Show the artist column (playlists, top tracks, search). */
    showArtist?: boolean;
    /** Show the album column. */
    showAlbum?: boolean;
    /** Number column: track number (album) or position (default). */
    numbering?: "track" | "index";
    /** Group by disc when the album spans several. */
    discs?: boolean;
}

export function TrackList({ tracks, listId, onSelect, showArtist, showAlbum, numbering = "index", discs }: TrackListProps) {
    const st = useMusicState();
    const multiDisc = !!discs && new Set(tracks.map((x) => x.disc ?? 1)).size > 1;
    const out: ReactNode[] = [];
    let lastDisc: number | null = null;
    tracks.forEach((tr, i) => {
        const disc = tr.disc ?? 1;
        if (multiDisc && disc !== lastDisc) {
            out.push(<div key={`disc-${disc}`} className="mu-disc">{t("music.disc", { n: disc })}</div>);
            lastDisc = disc;
        }
        const isCur = st.current?.id === tr.id;
        out.push(
            <button key={`${tr.id}-${i}`} type="button" className={`mu-track${isCur ? " is-current" : ""}`} data-focusable=""
                data-focus-key={`${listId}:${tr.id}:${i}`} onClick={() => onSelect(i)}
                aria-label={[tr.title, tr.artist, fmtDuration(tr.durationSec)].filter(Boolean).join(", ")}>
                <span className="mu-track-num">
                    {isCur ? <PlayingBars playing={st.playing} /> : numbering === "track" && tr.track ? tr.track : i + 1}
                </span>
                <span className="mu-track-main">
                    <span className="mu-track-title">{tr.title}</span>
                    {(showArtist || showAlbum) && (
                        <span className="mu-track-sub">{[showArtist ? tr.artist : null, showAlbum ? tr.album : null].filter(Boolean).join(" · ")}</span>
                    )}
                </span>
                {(tr.hasSyncedLyrics || tr.hasLyrics) && (
                    <span className="badge badge-neutral mu-track-badge"><Icon name="lyrics" />{t("music.lyricsBadge")}</span>
                )}
                {tr.format && <span className="mu-track-fmt">{tr.format.toUpperCase()}</span>}
                <span className="mu-track-dur">{fmtDuration(tr.durationSec)}</span>
            </button>,
        );
    });
    return <div className="mu-tracks" role="list">{out}</div>;
}

/** Header block used by Album / Artist / Playlist: big cover + texts + actions row. */
export function MusicHero({ cover, round, kicker, title, meta, actions, chips }: {
    cover: string | null; round?: boolean; kicker?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode; chips?: ReactNode;
}) {
    return (
        <header className="mu-hero">
            <div className={`mu-hero-cover${round ? " is-round" : ""}`}>
                {cover ? <img src={cover} alt="" decoding="async" /> : <span className="mu-hero-ph"><Icon name="music" /></span>}
            </div>
            <div className="mu-hero-body">
                {kicker && <div className="mu-hero-kicker">{kicker}</div>}
                <h1 className="mu-hero-title">{title}</h1>
                {meta && <div className="mu-hero-meta">{meta}</div>}
                {chips && <div className="mu-hero-chips">{chips}</div>}
                {actions && <div className="mu-hero-actions" data-focus-row="hero-actions">{actions}</div>}
            </div>
        </header>
    );
}

export function totalDuration(tracks: TrackCard[]): string | null {
    return fmtDuration(tracks.reduce((s, x) => s + (x.durationSec || 0), 0));
}

/** Play a list from index (or shuffled) and open Now Playing. */
export function playAndOpen(tracks: TrackCard[], index: number, open: () => void, shuffle = false): void {
    if (tracks.length === 0) return;
    musicPlayer.play(tracks, index, { shuffle });
    open();
}
