"use client";

/**
 * Shared music UI (WP16-40): square cover cards (album / artist / playlist), track list rows (buttons, Enter
 * plays), hero header, page states (loading / empty library / error), equaliser glyph. Covers come from
 * `MusicClient.coverUrl` as plain lazy <img>.
 */
import Link from "next/link";
import { memo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Disc3, ListMusic, Mic2, Music2, User } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { MusicClient } from "@/lib/mmo/music";
import type { AlbumCard, ArtistCard, PlaylistCard, TrackCard } from "@/lib/mmo/media-types";
import { discGroups, fmtClock } from "@/lib/mmo/music-core";
import { useWebMusicState, webMusicPlayer } from "@/lib/mmo/web-music-player";
import { DownloadButton } from "../offline/download-button";

export const albumHref = (id: string) => `/media/music/album/${encodeURIComponent(id)}`;
export const artistHref = (id: string) => `/media/music/artist/${encodeURIComponent(id)}`;
export const playlistHref = (id: string) => `/media/music/playlist/${encodeURIComponent(id)}`;
export const genreHref = (name: string) => `/media/music/genre/${encodeURIComponent(name)}`;
export const NOW_PLAYING_HREF = "/media/music/now-playing";

export function Cover({ src, round, icon, className, eager }: { src: string | null; round?: boolean; icon?: ReactNode; className?: string; eager?: boolean }) {
    return (
        <span className={`mu-cover${round ? " is-round" : ""}${className ? ` ${className}` : ""}`}>
            {src
                // eslint-disable-next-line @next/next/no-img-element -- signed Subsonic cover from the user's MMO Server
                ? <img src={src} alt="" loading={eager ? "eager" : "lazy"} decoding="async" />
                : <span className="mu-cover-ph" aria-hidden>{icon ?? <Music2 />}</span>}
        </span>
    );
}

export const AlbumTile = memo(function AlbumTile({ music, album, sub }: { music: MusicClient; album: AlbumCard; sub?: string }) {
    const subtitle = sub ?? [album.artist, album.year].filter(Boolean).join(" · ");
    return (
        <Link href={albumHref(album.id)} className="mu-tile" prefetch={false}>
            <Cover src={music.coverUrl(album, 300)} icon={<Disc3 />} />
            <span className="mu-tile-title">{album.name}</span>
            {subtitle ? <span className="mu-tile-sub">{subtitle}</span> : null}
        </Link>
    );
});

export const ArtistTile = memo(function ArtistTile({ music, artist }: { music: MusicClient; artist: ArtistCard }) {
    const t = useTranslations("mx.music.count");
    return (
        <Link href={artistHref(artist.id)} className="mu-tile is-artist" prefetch={false}>
            <Cover src={music.coverUrl(artist, 300)} round icon={<User />} />
            <span className="mu-tile-title">{artist.name}</span>
            <span className="mu-tile-sub">{t("albums", { count: artist.albumCount })}</span>
        </Link>
    );
});

export const PlaylistTile = memo(function PlaylistTile({ music, playlist }: { music: MusicClient; playlist: PlaylistCard }) {
    const t = useTranslations("mx.music.count");
    return (
        <Link href={playlistHref(playlist.id)} className="mu-tile" prefetch={false}>
            <Cover src={music.coverUrl(playlist, 300)} icon={<ListMusic />} />
            <span className="mu-tile-title">{playlist.name}</span>
            <span className="mu-tile-sub">{t("tracks", { count: playlist.songCount })}</span>
        </Link>
    );
});

/** Equaliser glyph for the playing row (static under reduced motion, see music.css). */
export function PlayingBars({ playing }: { playing: boolean }) {
    return <span className={`mu-bars${playing ? " is-on" : ""}`} aria-hidden><i /><i /><i /></span>;
}

export interface TrackListProps {
    music: MusicClient;
    tracks: TrackCard[];
    /** Plays `tracks` from `index` (play-from-here). */
    onPlay?: (index: number) => void;
    showArtist?: boolean;
    showAlbum?: boolean;
    showCover?: boolean;
    numbering?: "track" | "index";
    /** Group by disc when the album spans several. */
    discs?: boolean;
    /** Offline download per row (needs the active server + profile). */
    downloadable?: { serverId: string; profileId: string; album?: string | null };
    label: string;
}

/** Track rows as buttons: Enter/Space/click plays from that row; ↑/↓ move between rows. */
export function TrackList({ music, tracks, onPlay, showArtist, showAlbum, showCover, numbering = "index", discs, downloadable, label }: TrackListProps) {
    const t = useTranslations("mx.music");
    const st = useWebMusicState();
    const play = onPlay ?? ((i: number) => webMusicPlayer.play(tracks, i));
    const groups = discs ? discGroups(tracks) : [{ disc: null, items: tracks.map((track, index) => ({ track, index })) }];

    const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button.mu-track"));
        const i = rows.indexOf(document.activeElement as HTMLButtonElement);
        if (i < 0) return;
        const n = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
        if (n) { e.preventDefault(); n.focus(); }
    };

    return (
        <div className="mu-tracks" role="group" aria-label={label} onKeyDown={onKey}>
            {groups.map((g) => (
                <div key={g.disc ?? "all"} className="mu-disc-group">
                    {g.disc !== null ? <h3 className="mu-disc"><Disc3 aria-hidden className="size-4" />{t("album.disc", { n: g.disc })}</h3> : null}
                    <ol className="mu-track-ol">
                        {g.items.map(({ track: tr, index: i }) => {
                            const isCur = st.current?.id === tr.id && !st.hidden;
                            const sub = [showArtist ? tr.artist : null, showAlbum ? tr.album : null].filter(Boolean).join(" · ");
                            return (
                                <li key={`${tr.id}-${i}`} className={downloadable ? "mu-track-li" : undefined}>
                                    <button type="button" className={`mu-track${isCur ? " is-current" : ""}`} onClick={() => play(i)}
                                        aria-current={isCur ? "true" : undefined}
                                        aria-label={t("track.playLabel", { title: [tr.title, tr.artist].filter(Boolean).join(" – "), duration: fmtClock(tr.durationSec) })}>
                                        <span className="mu-track-num">
                                            {isCur ? <PlayingBars playing={st.playing} /> : numbering === "track" && tr.track ? tr.track : i + 1}
                                        </span>
                                        {showCover ? <Cover src={music.coverUrl(tr, 80)} className="mu-track-cover" /> : null}
                                        <span className="mu-track-main">
                                            <span className="mu-track-title">{tr.title}</span>
                                            {sub ? <span className="mu-track-sub">{sub}</span> : null}
                                        </span>
                                        {tr.hasSyncedLyrics || tr.hasLyrics ? (
                                            <span className="mu-track-badge" title={t("track.lyrics")}><Mic2 aria-hidden className="size-3.5" /><span className="sr-only">{t("track.lyrics")}</span></span>
                                        ) : null}
                                        {tr.format ? <span className="mu-track-fmt">{tr.format.toUpperCase()}</span> : null}
                                        <span className="mu-track-dur">{fmtClock(tr.durationSec)}</span>
                                    </button>
                                    {downloadable ? (
                                        <DownloadButton variant="icon" size="icon-sm" item={{
                                            serverId: downloadable.serverId,
                                            profileId: downloadable.profileId,
                                            kind: "track",
                                            id: tr.id,
                                            title: tr.title,
                                            subtitle: [tr.artist, downloadable.album ?? tr.album].filter(Boolean).join(" · "),
                                            poster: music.coverUrl(tr, 300),
                                            durationSec: tr.durationSec,
                                            url: music.streamUrl(tr),
                                        }} />
                                    ) : null}
                                </li>
                            );
                        })}
                    </ol>
                </div>
            ))}
        </div>
    );
}

/** Album / artist / playlist header: big cover + blurred cover backdrop + texts + actions. */
export function MusicHero({ cover, backdrop, round, kicker, title, meta, actions }: {
    cover: string | null; backdrop?: string | null; round?: boolean; kicker?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode;
}) {
    return (
        <header className="mu-hero">
            {backdrop ? (
                // eslint-disable-next-line @next/next/no-img-element -- decorative blurred cover
                <img className="mu-hero-bg" src={backdrop} alt="" aria-hidden decoding="async" />
            ) : null}
            <Cover src={cover} round={round} className="mu-hero-cover" eager icon={round ? <User /> : <Disc3 />} />
            <div className="mu-hero-body">
                {kicker ? <p className="mu-hero-kicker">{kicker}</p> : null}
                <h1 className="mu-hero-title">{title}</h1>
                {meta ? <div className="mu-hero-meta">{meta}</div> : null}
                {actions ? <div className="mu-hero-actions">{actions}</div> : null}
            </div>
        </header>
    );
}

export function MusicLoading({ label }: { label: string }) {
    return (
        <div className="mu-loading" role="status" aria-live="polite">
            <span className="sr-only">{label}</span>
            <div className="mu-skel-hero bg-muted animate-pulse" aria-hidden />
            <div className="mu-grid" aria-hidden>
                {Array.from({ length: 12 }, (_, i) => <div key={i} className="mu-skel-tile bg-muted animate-pulse" />)}
            </div>
        </div>
    );
}

export function MusicError({ onRetry, title }: { onRetry: () => void; title?: string }) {
    const t = useTranslations("mx.music.state");
    return (
        <EmptyState tone="error" icon={<AlertTriangle aria-hidden />} title={title ?? t("error")} description={t("errorBody")}
            actions={<Button onClick={onRetry}>{t("retry")}</Button>} />
    );
}

export function MusicEmptyLibrary() {
    const t = useTranslations("mx.music.state");
    return <EmptyState icon={<Music2 aria-hidden />} title={t("emptyLibrary")} description={t("emptyLibraryBody")} />;
}

export function MusicNotFound({ backHref = "/media/music" }: { backHref?: string }) {
    const t = useTranslations("mx.music.state");
    return (
        <EmptyState icon={<Music2 aria-hidden />} title={t("notFound")} description={t("notFoundBody")}
            actions={<Button render={<Link href={backHref} />}>{t("backToMusic")}</Button>} />
    );
}

/** Wraps a grid of tiles with roving arrow keys (left/right/up/down by visual position). */
export function TileGrid({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
    return (
        <ul className={`mu-grid${className ? ` ${className}` : ""}`} aria-label={label} onKeyDown={gridKeys}>
            {children}
        </ul>
    );
}

export function gridKeys(e: React.KeyboardEvent<HTMLElement>) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
    const cur = document.activeElement as HTMLElement;
    const i = items.indexOf(cur);
    if (i < 0) return;
    let target: HTMLElement | undefined;
    if (e.key === "ArrowRight") target = items[i + 1];
    else if (e.key === "ArrowLeft") target = items[i - 1];
    else {
        const r = cur.getBoundingClientRect();
        const down = e.key === "ArrowDown";
        let best: { el: HTMLElement; d: number } | null = null;
        for (const el of items) {
            const b = el.getBoundingClientRect();
            if (down ? b.top <= r.top + 4 : b.top >= r.top - 4) continue;
            const d = Math.abs(b.top - r.top) * 4 + Math.abs(b.left - r.left);
            if (!best || d < best.d) best = { el, d };
        }
        target = best?.el;
    }
    if (!target) return;
    e.preventDefault();
    target.focus();
}
