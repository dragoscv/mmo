import { useEffect, useMemo, useState } from "react";
import type { ServerConfig, SessionUser } from "../lib/config";
import type { MmoClient, ProbedVideo, SubsonicAlbum } from "../lib/api";
import type { MediaClient } from "../lib/media";
import type { MediaHome, TitleCard } from "../lib/media-types";
import { flushQueue, migrateLocalProgress } from "../lib/progress-sync";
import { focusFirst } from "../lib/focus";
import { allProgress, clearProgress } from "../lib/progress";
import { groupShows, isEpisode, type Show } from "../lib/shows";
import { t } from "../i18n/messages";
import { useLocale } from "../i18n/useLocale";
import { AlbumCard, Row, ShowCard, VideoCard, type Load } from "./cards";
import { HeroBillboard, MediaRow, SkeletonRows } from "./media-cards";

interface Props {
    client: MmoClient;
    media: MediaClient;
    cfg: ServerConfig;
    user: SessionUser | null;
    onPlayVideo: (v: ProbedVideo) => void;
    onOpenTitle: (c: TitleCard) => void;
    onOpenShow: (show: Show) => void;
    onOpenAlbum: (a: SubsonicAlbum) => void;
    onSearch: (videos: ProbedVideo[]) => void;
    onDisconnect: () => void;
    onSignOut?: () => void;
}

export function HomeScreen({ client, media, cfg, user, onPlayVideo, onOpenTitle, onOpenShow, onOpenAlbum, onSearch, onDisconnect, onSignOut }: Props) {
    const [videos, setVideos] = useState<Load<ProbedVideo[]>>({ state: "loading" });
    const [newest, setNewest] = useState<Load<SubsonicAlbum[]>>({ state: "loading" });
    const [recent, setRecent] = useState<Load<SubsonicAlbum[]>>({ state: "loading" });
    // `null` data = server without `/media` (404) → scan-based rows only.
    const [home, setHome] = useState<Load<MediaHome | null>>({ state: "loading" });
    const [locale, setLocale] = useLocale();
    // Bumped when resume data changes so cards/rows re-read localStorage.
    const [progressRev, setProgressRev] = useState(0);

    useEffect(() => {
        let alive = true;
        const wrap = <T,>(p: Promise<T>, set: (l: Load<T>) => void) =>
            p.then((data) => { if (alive) set({ state: "ok", data }); })
             .catch((e: Error) => { if (alive) set({ state: "error", message: e.message }); });
        wrap(media.mediaHome(), setHome);
        wrap(client.listVideos(), setVideos);
        wrap(client.albumList("newest", 50), setNewest);
        wrap(client.albumList("recent", 30), setRecent);
        // Server progress: retry the offline queue, then the one-shot local → server migration.
        void flushQueue(media).then(() => migrateLocalProgress(media)).then((n) => {
            if (alive && n > 0) { media.invalidate(); wrap(media.mediaHome(), setHome); }
        });
        return () => { alive = false; };
    }, [client, media]);

    // Once the first row lands, put focus on it.
    useEffect(() => {
        if (home.state !== "loading" || videos.state !== "loading") {
            const t = setTimeout(() => {
                if (!document.activeElement || document.activeElement === document.body) {
                    const rows = document.querySelector(".rows");
                    if (!rows || !focusFirst(rows)) focusFirst();
                }
            }, 50);
            return () => clearTimeout(t);
        }
    }, [home.state, videos.state]);

    const all = videos.state === "ok" ? videos.data : [];
    const movies = useMemo(() => all.filter((v) => !isEpisode(v)), [all]);
    const shows = useMemo(() => groupShows(all), [all]);
    const continueWatching = useMemo(() => {
        const byId = new Map(all.map((v) => [v.fileId, v]));
        return allProgress().map((p) => byId.get(p.fileId)).filter((v): v is ProbedVideo => !!v);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [all, progressRev]);

    const mediaHome = home.state === "ok" ? home.data : null;
    const rows = useMemo(() => (mediaHome?.rows ?? []).filter((r) => r.items.length > 0), [mediaHome]);
    const heroItems = useMemo(() => {
        const seen = new Set<string>();
        const out: TitleCard[] = [];
        for (const r of rows) {
            if (r.id === "continue") continue;
            for (const c of r.items) {
                const k = `${c.kind}:${c.tmdbId}`;
                if (!c.backdropPath || seen.has(k)) continue;
                seen.add(k); out.push(c);
                if (out.length >= 6) return out;
            }
        }
        return out;
    }, [rows]);
    const mediaMode = home.state === "loading" || (mediaHome !== null && rows.length > 0);

    return (
        <div className="screen">
            <div className="home-header">
                <h1 className="screen-title">{t("home.title")}</h1>
                <div className="home-header-right">
                    <button className="btn secondary small" data-focusable data-testid="home-search" onClick={() => onSearch(all)}>🔍 {t("common.search")}</button>
                    {user && <span className="user" data-testid="home-user">👤 {user.name ?? user.id}</span>}
                    <span className="server">{mediaHome?.serverName ?? cfg.baseUrl}</span>
                </div>
            </div>
            <div className="rows">
                {home.state === "loading" && <SkeletonRows n={2} />}
                {mediaMode && home.state === "ok" && heroItems.length > 0 && <HeroBillboard items={heroItems} media={media} onOpen={onOpenTitle} />}
                {mediaMode && rows.map((r) => <MediaRow key={r.id} row={r} media={media} onOpen={onOpenTitle} />)}
                {!mediaMode && continueWatching.length > 0 && (
                    <Row title={t("home.continue")} load={videos} items={continueWatching} empty="" wide>
                        {(v) => <VideoCard key={v.fileId} v={v} client={client} onClick={() => onPlayVideo(v)} />}
                    </Row>
                )}
                {(!mediaMode || movies.length > 0) && (
                    <Row title={t("home.movies")} load={videos} items={movies} empty={t("home.moviesEmpty")} wide>
                        {(v) => <VideoCard key={v.fileId} v={v} client={client} onClick={() => onPlayVideo(v)} />}
                    </Row>
                )}
                {((!mediaMode && videos.state === "loading") || shows.length > 0) && (
                    <Row title={t("home.shows")} load={videos} items={shows} empty="" wide>
                        {(s) => <ShowCard key={s.key} show={s} client={client} onClick={() => onOpenShow(s)} />}
                    </Row>
                )}
                <Row title={t("home.newAlbums")} load={newest} items={newest.state === "ok" ? newest.data : []} empty={t("home.newAlbumsEmpty")}>
                    {(a) => <AlbumCard key={a.id} a={a} client={client} onClick={() => onOpenAlbum(a)} />}
                </Row>
                <Row title={t("home.recent")} load={recent} items={recent.state === "ok" ? recent.data : []} empty={t("home.recentEmpty")}>
                    {(a) => <AlbumCard key={a.id} a={a} client={client} onClick={() => onOpenAlbum(a)} />}
                </Row>
                <div className="row">
                    <h2 className="row-title">{t("home.settings")}</h2>
                    <div className="row-track">
                        <button className="btn secondary" data-focusable data-testid="toggle-locale" onClick={() => setLocale(locale === "ro" ? "en" : "ro")}>
                            {t("home.language")}
                        </button>
                        <button className="btn secondary" data-focusable data-testid="clear-progress" onClick={() => { clearProgress(); setProgressRev((r) => r + 1); }}>
                            {t("home.clearProgress")}
                        </button>
                        <button className="btn secondary" data-focusable onClick={onDisconnect}>{t("home.changeServer")}</button>
                        {onSignOut && <button className="btn secondary" data-focusable data-testid="sign-out" onClick={onSignOut}>{t("home.signOut")}</button>}
                    </div>
                </div>
            </div>
        </div>
    );
}
