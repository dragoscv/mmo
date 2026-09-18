import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { MmoClient, ProbedVideo } from "../lib/api";
import type { MediaClient } from "../lib/media";
import type { LibraryIndexRow, MediaKind, MediaTitleResponse, Offer, ProgressEntry, TitleCard } from "../lib/media-types";
import { appInstalled, launchOffer, offerUrl, type InstallState } from "../lib/launch";
import { markWatched, type TitleRef } from "../lib/progress-sync";
import { focusFirst } from "../lib/focus";
import { fmtClock } from "../lib/format";
import { t } from "../i18n/messages";
import { cardMeta, TitlePosterCard } from "./media-cards";

export interface PlayRequest {
    video: ProbedVideo;
    ref: TitleRef;
    resumeSec: number;
}

interface Props {
    client: MmoClient;
    media: MediaClient;
    kind: MediaKind;
    tmdbId: number;
    /** Card data for an instant header while `/media/title` loads. */
    seed?: TitleCard;
    /** Region label for the "no offers" copy (from `/media/home`). */
    region?: string;
    onPlay: (req: PlayRequest) => void;
    onOpenTitle: (c: TitleCard) => void;
}

type State = { s: "loading" } | { s: "ok"; data: MediaTitleResponse } | { s: "error"; message: string } | { s: "unsupported" };
type Launch = { s: "idle" } | { s: "launching"; name: string } | { s: "browser" } | { s: "qr"; name: string; url: string } | { s: "resolving" };

function fileLabel(f: LibraryIndexRow): string {
    const base = f.path.split(/[\\/]/).pop() ?? f.path;
    return f.season != null && f.episode != null ? `${t("title.episode", { s: f.season, e: f.episode })} · ${base}` : base;
}

function progressFor(p: ProgressEntry[], f: LibraryIndexRow): ProgressEntry | undefined {
    return p.find((e) => e.season === (f.season ?? 0) && e.episode === (f.episode ?? 0) && !e.completed && e.positionSec > 10);
}

export function TitleScreen({ client, media, kind, tmdbId, seed, region = "RO", onPlay, onOpenTitle }: Props) {
    const [st, setSt] = useState<State>({ s: "loading" });
    const [launch, setLaunch] = useState<Launch>({ s: "idle" });
    const [watched, setWatched] = useState(false);
    const [installed, setInstalled] = useState<Record<string, InstallState>>({});
    const qr = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        let alive = true;
        setSt({ s: "loading" });
        media.mediaTitle(kind, tmdbId)
            .then((data) => {
                if (!alive) return;
                if (data === null) { setSt({ s: "unsupported" }); return; }
                setSt({ s: "ok", data });
                setWatched(data.progress.some((p) => p.completed));
                const inst: Record<string, InstallState> = {};
                for (const o of data.availability.offers) {
                    const id = o.launch.tizen?.appId;
                    if (id && !(id in inst)) inst[id] = appInstalled(id);
                }
                setInstalled(inst);
            })
            .catch((e: Error) => { if (alive) setSt({ s: "error", message: e.message }); });
        return () => { alive = false; };
    }, [media, kind, tmdbId]);

    useEffect(() => {
        if (st.s === "loading") return;
        const h = setTimeout(() => focusFirst(), 40);
        return () => clearTimeout(h);
    }, [st.s]);

    useEffect(() => {
        if (launch.s !== "qr" || !qr.current) return;
        QRCode.toCanvas(qr.current, launch.url, { width: 260, margin: 1 }).catch(() => undefined);
    }, [launch]);

    const data = st.s === "ok" ? st.data : null;
    const title = data?.title ?? seed;
    const backdrop = media.image(title?.backdropPath, "w1280");
    const poster = media.image(title?.posterPath, "w500");
    const logo = data ? media.image(data.title.logoPath, "w500") : null;
    const ref: TitleRef = { kind, tmdbId };

    const play = async (f: LibraryIndexRow) => {
        if (!data) return;
        setLaunch({ s: "resolving" });
        try {
            const video = await client.resolveVideo(f.serverFileId, f.path);
            const p = progressFor(data.progress, f);
            onPlay({ video, ref: { kind, tmdbId, season: f.season ?? 0, episode: f.episode ?? 0 }, resumeSec: p?.positionSec ?? 0 });
        } catch (e) {
            setSt({ s: "error", message: (e as Error).message });
        } finally {
            setLaunch({ s: "idle" });
        }
    };

    const open = async (o: Offer) => {
        setLaunch({ s: "launching", name: o.name });
        const out = await launchOffer(o);
        if (out.via === "qr") setLaunch({ s: "qr", name: o.name, url: out.url });
        else if (out.via === "browser") setLaunch({ s: "browser" });
        else setLaunch({ s: "idle" });
    };

    const mark = async () => {
        if (!data) return;
        const dur = (data.title.runtime ?? 0) * 60;
        try { await markWatched(media, ref, dur); setWatched(true); } catch { /* offline: keep button */ }
    };

    const metaLine = title ? [
        cardMeta(title),
        data?.title.runtime ? t("title.runtime", { n: data.title.runtime }) : null,
        data?.title.numberOfSeasons ? t("title.seasons", { n: data.title.numberOfSeasons }) : null,
        data?.title.certification ?? null,
        data?.title.genres.map((g) => g.name).join(", ") || null,
    ].filter(Boolean).join(" · ") : "";

    return (
        <div className="screen title-screen" data-testid="title-screen">
            {backdrop && <div className="title-bg" style={{ backgroundImage: `url("${backdrop}")` }} />}
            <div className="title-fade" />
            <div className="rows title-body">
                <div className="title-head">
                    {poster ? <img className="title-poster" src={poster} alt="" /> : <div className="title-poster placeholder">🎬</div>}
                    <div className="title-info">
                        {logo ? <img className="title-logo" src={logo} alt={title?.title ?? ""} /> : <h1 className="screen-title" data-testid="title-name">{title?.title ?? "…"}</h1>}
                        {data?.title.tagline && <div className="title-tagline">{data.title.tagline}</div>}
                        <div className="title-meta">{metaLine}</div>
                        {title?.overview && <p className="title-overview">{title.overview}</p>}
                        {st.s === "loading" && <div className="spinner">{t("common.loading")}</div>}
                        {st.s === "error" && <div className="status error">{t("common.error", { message: st.message })}</div>}
                        {st.s === "unsupported" && <div className="status">{t("home.mediaUnavailable")}</div>}

                        {data && data.files.length > 0 && (
                            <section className="title-section" data-testid="title-sources">
                                <h2 className="row-title">{t("title.sources")}</h2>
                                <div className="btn-row wrap">
                                    {data.files.map((f) => {
                                        const p = progressFor(data.progress, f);
                                        return (
                                            <button key={f.serverFileId} className="btn" data-focusable data-testid="source-btn" onClick={() => void play(f)} title={f.path}>
                                                ▶ {t("title.playFrom", { server: data.serverName })}
                                                <span className="btn-sub">{fileLabel(f)}{p ? ` · ${t("title.resumeFrom", { time: fmtClock(p.positionSec) })}` : ""}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>
                        )}

                        {data && (
                            <section className="title-section" data-testid="title-offers">
                                <h2 className="row-title">{t("title.whereToWatch")}</h2>
                                {data.availability.offers.length === 0 && <div className="empty">{t("title.noOffers", { region })}</div>}
                                <div className="btn-row wrap">
                                    {data.availability.offers.map((o, i) => {
                                        const appId = o.launch.tizen?.appId;
                                        const state = appId ? installed[appId] ?? "unknown" : "missing";
                                        const logoUrl = media.image(o.logo, "w92");
                                        return (
                                            <button key={`${o.providerId}-${o.type}-${i}`} className="btn secondary provider-btn" data-focusable data-testid="provider-btn"
                                                data-app-id={appId ?? ""} data-installed={state} onClick={() => void open(o)} title={offerUrl(o)}>
                                                {logoUrl && <img className="provider-logo" src={logoUrl} alt="" />}
                                                <span className="provider-name">{o.name}</span>
                                                <span className="btn-sub">
                                                    {t(`title.offer.${o.type}` as "title.offer.subscription")}
                                                    {appId ? ` · ${state === "installed" ? t("title.installed") : state === "missing" ? t("title.notInstalled") : ""}` : ""}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {data.availability.attribution.length > 0 && <div className="attribution">{t("title.attribution", { sources: data.availability.attribution.join(", ") })}</div>}
                            </section>
                        )}

                        {data && (
                            <div className="btn-row" style={{ marginTop: 20 }}>
                                <button className="btn secondary" data-focusable data-testid="mark-watched" onClick={() => void mark()} disabled={watched}>
                                    {watched ? t("title.watched") : t("title.markWatched")}
                                </button>
                            </div>
                        )}

                        {launch.s === "launching" && <div className="status" data-testid="launch-status">{t("title.launching", { name: launch.name })}</div>}
                        {launch.s === "browser" && <div className="status ok" data-testid="launch-status">{t("title.launchedBrowser")}</div>}
                        {launch.s === "qr" && (
                            <div className="launch-qr" data-testid="launch-qr">
                                <canvas ref={qr} className="pair-qr" style={{ width: 260, height: 260 }} />
                                <div className="status">{t("title.launchQr", { name: launch.name })}</div>
                            </div>
                        )}
                    </div>
                </div>

                {data && data.title.similar.length > 0 && (
                    <section className="row media-row" data-focus-row="title:similar">
                        <h2 className="row-title">{t("title.similar")}</h2>
                        <div className="row-track">
                            {data.title.similar.slice(0, 20).map((c) => <TitlePosterCard key={`${c.kind}:${c.tmdbId}`} c={c} media={media} onClick={() => onOpenTitle(c)} />)}
                        </div>
                    </section>
                )}
                {data && data.title.recommendations.length > 0 && (
                    <section className="row media-row" data-focus-row="title:recs">
                        <h2 className="row-title">{t("title.recommended")}</h2>
                        <div className="row-track">
                            {data.title.recommendations.slice(0, 20).map((c) => <TitlePosterCard key={`${c.kind}:${c.tmdbId}`} c={c} media={media} onClick={() => onOpenTitle(c)} />)}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}
