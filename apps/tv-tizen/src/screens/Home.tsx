import { useEffect, useMemo, useState } from "react";
import type { ServerConfig, SessionUser } from "../lib/config";
import type { MmoClient, ProbedVideo, SubsonicAlbum } from "../lib/api";
import { focusFirst } from "../lib/focus";
import { allProgress, clearProgress } from "../lib/progress";
import { groupShows, isEpisode, type Show } from "../lib/shows";
import { t } from "../i18n/messages";
import { useLocale } from "../i18n/useLocale";
import { AlbumCard, Row, ShowCard, VideoCard, type Load } from "./cards";

interface Props {
    client: MmoClient;
    cfg: ServerConfig;
    user: SessionUser | null;
    onPlayVideo: (v: ProbedVideo) => void;
    onOpenShow: (show: Show) => void;
    onOpenAlbum: (a: SubsonicAlbum) => void;
    onSearch: (videos: ProbedVideo[]) => void;
    onDisconnect: () => void;
    onSignOut?: () => void;
}

export function HomeScreen({ client, cfg, user, onPlayVideo, onOpenShow, onOpenAlbum, onSearch, onDisconnect, onSignOut }: Props) {
    const [videos, setVideos] = useState<Load<ProbedVideo[]>>({ state: "loading" });
    const [newest, setNewest] = useState<Load<SubsonicAlbum[]>>({ state: "loading" });
    const [recent, setRecent] = useState<Load<SubsonicAlbum[]>>({ state: "loading" });
    const [locale, setLocale] = useLocale();
    // Bumped when resume data changes so cards/rows re-read localStorage.
    const [progressRev, setProgressRev] = useState(0);

    useEffect(() => {
        let alive = true;
        const wrap = <T,>(p: Promise<T>, set: (l: Load<T>) => void) =>
            p.then((data) => { if (alive) set({ state: "ok", data }); })
             .catch((e: Error) => { if (alive) set({ state: "error", message: e.message }); });
        wrap(client.listVideos(), setVideos);
        wrap(client.albumList("newest", 50), setNewest);
        wrap(client.albumList("recent", 30), setRecent);
        return () => { alive = false; };
    }, [client]);

    // Once the first row lands, put focus on it.
    useEffect(() => {
        if (videos.state !== "loading" || newest.state !== "loading") {
            const t = setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) focusFirst(); }, 50);
            return () => clearTimeout(t);
        }
    }, [videos.state, newest.state]);

    const all = videos.state === "ok" ? videos.data : [];
    const movies = useMemo(() => all.filter((v) => !isEpisode(v)), [all]);
    const shows = useMemo(() => groupShows(all), [all]);
    const continueWatching = useMemo(() => {
        const byId = new Map(all.map((v) => [v.fileId, v]));
        return allProgress().map((p) => byId.get(p.fileId)).filter((v): v is ProbedVideo => !!v);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [all, progressRev]);

    return (
        <div className="screen">
            <div className="home-header">
                <h1 className="screen-title">{t("home.title")}</h1>
                <div className="home-header-right">
                    <button className="btn secondary small" data-focusable data-testid="home-search" onClick={() => onSearch(all)}>🔍 {t("common.search")}</button>
                    {user && <span className="user" data-testid="home-user">👤 {user.name ?? user.id}</span>}
                    <span className="server">{cfg.baseUrl}</span>
                </div>
            </div>
            <div className="rows">
                {continueWatching.length > 0 && (
                    <Row title={t("home.continue")} load={videos} items={continueWatching} empty="" wide>
                        {(v) => <VideoCard key={v.fileId} v={v} client={client} onClick={() => onPlayVideo(v)} />}
                    </Row>
                )}
                <Row title={t("home.movies")} load={videos} items={movies} empty={t("home.moviesEmpty")} wide>
                    {(v) => <VideoCard key={v.fileId} v={v} client={client} onClick={() => onPlayVideo(v)} />}
                </Row>
                {(videos.state === "loading" || shows.length > 0) && (
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
