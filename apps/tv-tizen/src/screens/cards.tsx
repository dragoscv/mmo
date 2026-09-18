import type { ReactNode } from "react";
import type { MmoClient, ProbedVideo, SubsonicAlbum } from "../lib/api";
import { fmtDuration } from "../lib/format";
import { progressPct } from "../lib/progress";
import { useStill } from "../lib/useStill";
import { episodeCode, type Show } from "../lib/shows";
import { t } from "../i18n/messages";

export type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; message: string };

/** Poster (2/3) when the server matched artwork, else a landscape still from the scrubber sprite. */
export function VideoArt({ v, client }: { v: ProbedVideo; client: MmoClient }) {
    const still = useStill(v.posterPath ? null : client.spriteUrl(v.fileId));
    if (v.posterPath) return <img className="art" src={client.posterUrl(v.posterPath)} alt="" loading="lazy" />;
    if (still) return <div className="art still" style={{ backgroundImage: `url("${still}")` }} />;
    return <div className="art placeholder">🎬</div>;
}

export function ResumeBar({ fileId, dur }: { fileId: string; dur: number | null }) {
    const pct = progressPct(fileId, dur);
    if (pct == null) return null;
    return <div className="progress" data-testid="progress"><div style={{ width: `${pct}%` }} /></div>;
}

export function VideoCard({ v, client, onClick }: { v: ProbedVideo; client: MmoClient; onClick: () => void }) {
    const title = v.parsed.season != null ? `${v.parsed.title} ${episodeCode(v)}` : v.parsed.title;
    const sub = [v.parsed.year, v.height ? `${v.height}p` : null, v.videoCodec?.toUpperCase(), v.hdr && v.hdr !== "sdr" ? v.hdr.toUpperCase() : null, fmtDuration(v.durationSec)]
        .filter(Boolean).join(" · ");
    return (
        <button className={`card ${v.posterPath ? "poster" : "wide"}`} data-focusable onClick={onClick} title={v.path} data-testid="video-card">
            <VideoArt v={v} client={client} />
            <div className="meta">
                <div className="title">{title}</div>
                <div className="sub">{sub}</div>
            </div>
            <ResumeBar fileId={v.fileId} dur={v.durationSec} />
        </button>
    );
}

export function ShowCard({ show, client, onClick }: { show: Show; client: MmoClient; onClick: () => void }) {
    const first = show.episodes[0]!;
    return (
        <button className={`card ${first.posterPath ? "poster" : "wide"}`} data-focusable onClick={onClick} data-testid="show-card">
            <VideoArt v={first} client={client} />
            <div className="meta">
                <div className="title">{show.title}</div>
                <div className="sub">{t("home.episodes", { n: show.episodes.length })}</div>
            </div>
        </button>
    );
}

export function AlbumCard({ a, client, onClick }: { a: SubsonicAlbum; client: MmoClient; onClick: () => void }) {
    return (
        <button className="card" data-focusable onClick={onClick}>
            {a.coverArt
                ? <img className="art" src={client.coverArtUrl(a.coverArt, 300)} alt="" loading="lazy" />
                : <div className="art placeholder">♪</div>}
            <div className="meta">
                <div className="title">{a.name}</div>
                <div className="sub">{[a.artist, a.year, a.songCount ? t("home.songs", { n: a.songCount }) : null].filter(Boolean).join(" · ")}</div>
            </div>
        </button>
    );
}

export function SkeletonCard({ wide }: { wide?: boolean }) {
    return (
        <div className={`skeleton-card${wide ? " wide" : ""}`} aria-hidden="true">
            <div className="skeleton skeleton-art" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
        </div>
    );
}

export function Row<T>({ title, load, items, empty, wide, children }: {
    title: string; load: Load<unknown>; items: T[]; empty: string; wide?: boolean; children: (item: T) => ReactNode;
}) {
    return (
        <section className="row">
            <h2 className="row-title">{title}</h2>
            {load.state === "loading" && (
                <div className="row-track" aria-busy="true" data-testid="row-skeleton">
                    {Array.from({ length: 6 }, (_, i) => <SkeletonCard key={i} wide={wide} />)}
                </div>
            )}
            {load.state === "error" && <div className="empty">{t("common.error", { message: load.message })}</div>}
            {load.state === "ok" && items.length === 0 && empty && <div className="empty">{empty}</div>}
            {load.state === "ok" && items.length > 0 && <div className="row-track">{items.map(children)}</div>}
        </section>
    );
}
