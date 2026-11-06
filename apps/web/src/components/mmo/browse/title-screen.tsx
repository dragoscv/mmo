"use client";

/**
 * Title page (WP16-38, `/media/{kind}/{tmdbId}`) straight from the MMO Server (`/media/title`): full-bleed backdrop,
 * poster, logo/title, chips (year · certification · runtime · rating · 4K/HDR/DV · genres), overview,
 * Play/Resume → `/media/play/...` (`?file=` for a chosen version, `&s=&e=` for episodes), versions picker,
 * My list, trailer dialog (youtube-nocookie), seasons + episodes (tv), where to watch, cast, recommendations, similar.
 * `?play=1` (hero Play buttons) replaces itself with the player route as soon as the target is known.
 */
import Link, { useRouter } from "@/components/host/host-context";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, ChevronRight, ExternalLink, Play, Plus, RotateCcw, SquarePlay } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle } from "@mmo/ui";
import type { MediaKind, MediaTitleResponse, Offer } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { offlineVideoUrl } from "@/lib/mmo/offline/urls";
import { BackdropProvider, useBackdrop } from "../backdrop";
import { pickTrailer } from "../hero";
import { useMmo } from "../mmo-provider";
import { DownloadButton } from "../offline/download-button";
import { PlayOnTvButton } from "../play-on-tv";
import { MxRow } from "../row";
import { MxTitleCard, POSTER_VT } from "../title-card";
import { ErrorBlock, Unsupported, useMediaScope } from "./common";
import { EpisodeList, useSeason } from "./episodes";
import { formatChips, previewTarget, targetHref, versionChoices } from "./lib";
import { useAsync } from "./use-async";

export function TitleScreen({ kind, tmdbId }: { kind: MediaKind; tmdbId: number }) {
    return (
        <BackdropProvider>
            <TitleBody kind={kind} tmdbId={tmdbId} />
        </BackdropProvider>
    );
}

function TitleBody({ kind, tmdbId }: { kind: MediaKind; tmdbId: number }) {
    const t = useTranslations("mx.browse.title");
    const { media, scope } = useMediaScope();
    const router = useRouter();
    const params = useSearchParams();
    const autoplay = params?.get("play") === "1";
    const { load, retry } = useAsync<MediaTitleResponse>(scope ? `${scope}|${kind}|${tmdbId}` : null, (attempt) => {
        if (!media) return Promise.resolve(null);
        if (attempt > 0) media.invalidate();
        return media.mediaTitle(kind, tmdbId);
    });
    /** User override of `inWatchlist` (null = follow the server). */
    const [listOverride, setListOverride] = useState<boolean | null>(null);
    const [listBusy, setListBusy] = useState(false);
    const [listError, setListError] = useState(false);
    const [chosen, setChosen] = useState<string | null>(null);
    const [trailerOpen, setTrailerOpen] = useState(false);
    const { set } = useBackdrop();
    const { server, clients } = useMmo();

    const data = load.s === "ok" ? load.data : null;
    const det = data?.title ?? null;
    const inList = listOverride ?? data?.inWatchlist ?? false;
    useEffect(() => { if (det) set(det.backdropPath ?? det.posterPath); }, [det, set]);

    const target = useMemo(() => (data ? previewTarget(data, chosen) : null), [data, chosen]);
    const versions = useMemo(() => (data && kind === "movie" ? versionChoices(data.files) : []), [data, kind]);

    // `?play=1` → straight to the player (Back returns to the page without the flag).
    useEffect(() => {
        if (!autoplay || !data) return;
        if (target) router.replace(targetHref(kind, tmdbId, target));
        else router.replace(`/media/${kind}/${tmdbId}`, { scroll: false });
    }, [autoplay, data, target, kind, tmdbId, router]);

    if (load.s === "loading" || (autoplay && data && target)) return <TitleSkeleton label={autoplay ? t("starting") : t("loading")} />;
    if (load.s === "error") return <div className="pt-24"><ErrorBlock error={load.error} onRetry={retry} /></div>;
    if (load.s === "unsupported" || !data || !det) return <div className="pt-24"><Unsupported /></div>;

    const toggleList = async () => {
        if (!media || listBusy) return;
        const next = !inList;
        setListOverride(next);
        setListBusy(true);
        setListError(false);
        try {
            if (next) await media.watchlistAdd(kind, tmdbId); else await media.watchlistRemove(kind, tmdbId);
        } catch {
            setListOverride(!next);
            setListError(true);
        } finally {
            setListBusy(false);
        }
    };

    const trailer = pickTrailer(det);
    const logo = tmdbImg(det.logoPath, "w500");
    const poster = tmdbImg(det.posterPath, "w500");
    const year = det.releaseDate?.slice(0, 4);
    const chips = formatChips(data.files);
    const resuming = (target?.resumeSec ?? 0) > 0;
    const ep = target && target.season > 0 ? { s: target.season, e: target.episode } : null;
    const playLabel = resuming ? (ep ? t("resumeEp", ep) : t("resume")) : ep ? t("playEp", ep) : t("play");
    const playUrl = target ? targetHref(kind, tmdbId, target, chosen) : null;
    const startOverUrl = playUrl ? `${playUrl}${playUrl.includes("?") ? "&" : "?"}start=0` : null;
    const recs = det.recommendations.filter((c) => c.tmdbId !== tmdbId).slice(0, 30);
    const similar = det.similar.filter((c) => c.tmdbId !== tmdbId && !recs.some((r) => r.tmdbId === c.tmdbId && r.kind === c.kind)).slice(0, 30);
    const seasons = (det.seasons ?? []).filter((s) => s.seasonNumber > 0);

    return (
        <article>
            <section className="mxb-title-hero" aria-labelledby="mxb-title-h">
                <div className="mxb-poster-wrap">
                    {poster
                        // eslint-disable-next-line @next/next/no-img-element -- TMDB poster
                        ? <img src={poster} alt="" className="mxb-poster" decoding="async" style={{ viewTransitionName: POSTER_VT }} />
                        : <div className="mxb-poster" aria-hidden style={{ viewTransitionName: POSTER_VT }} />}
                </div>
                <div className="mxb-title-info">
                    {logo ? (
                        <>
                            {/* eslint-disable-next-line @next/next/no-img-element -- TMDB logo, transparent PNG */}
                            <img src={logo} alt="" className="mx-hero-logo" decoding="async" />
                            <h1 id="mxb-title-h" className="sr-only">{det.title}</h1>
                        </>
                    ) : <h1 id="mxb-title-h" className="mx-hero-title">{det.title}</h1>}
                    {det.tagline ? <p className="mxb-tagline">{det.tagline}</p> : null}
                    <div className="mx-hero-meta">
                        {year ? <span>{year}</span> : null}
                        {det.certification ? <span className="mx-chip">{det.certification}</span> : null}
                        {det.runtime ? <span>{t("runtime", { min: det.runtime })}</span> : null}
                        {kind === "tv" && det.numberOfSeasons ? <span>{t("seasons", { count: det.numberOfSeasons })}</span> : null}
                        {det.voteAverage ? <span aria-label={t("rating", { value: det.voteAverage.toFixed(1) })}>★ {det.voteAverage.toFixed(1)}</span> : null}
                        {chips.map((c) => <span key={c} className="mx-chip">{c}</span>)}
                        {det.genres.length ? <span>{det.genres.slice(0, 4).map((g) => g.name).join(" · ")}</span> : null}
                    </div>
                    {det.overview ? <p className="mxb-overview">{det.overview}</p> : null}
                    <div className="mxb-actions">
                        {playUrl ? (
                            <Button size="lg" render={<Link href={playUrl} />}>
                                <Play aria-hidden className="size-5" /> {playLabel}
                            </Button>
                        ) : (
                            <Button size="lg" disabled title={t("notOnServer")}><Play aria-hidden className="size-5" /> {t("play")}</Button>
                        )}
                        {startOverUrl && resuming ? (
                            <Button size="lg" variant="secondary" render={<Link href={startOverUrl} />}>
                                <RotateCcw aria-hidden className="size-5" /> {t("startOver")}
                            </Button>
                        ) : null}
                        <Button size="lg" variant="secondary" onClick={toggleList} aria-pressed={inList} loading={listBusy}>
                            {inList ? <Check aria-hidden className="size-5" /> : <Plus aria-hidden className="size-5" />} {inList ? t("inList") : t("addList")}
                        </Button>
                        {trailer ? (
                            <Button size="lg" variant="ghost" onClick={() => setTrailerOpen(true)}>
                                <SquarePlay aria-hidden className="size-5" /> {t("trailer")}
                            </Button>
                        ) : null}
                        {target ? (
                            <PlayOnTvButton
                                kind={kind}
                                tmdbId={tmdbId}
                                title={det.title}
                                fileId={target.file.serverFileId}
                                season={ep?.s}
                                episode={ep?.e}
                                positionSec={target.resumeSec}
                                size="lg"
                                variant="ghost"
                            />
                        ) : null}
                        {target && server && clients ? (
                            <DownloadButton item={{
                                serverId: server.deviceId,
                                profileId: clients.profiles.profileId,
                                kind: ep ? "episode" : "movie",
                                id: target.file.serverFileId,
                                title: det.title,
                                subtitle: ep ? `S${ep.s}E${ep.e}` : null,
                                poster,
                                durationSec: det.runtime ? det.runtime * 60 : undefined,
                                url: offlineVideoUrl(clients.cfg, target.file.serverFileId),
                            }} />
                        ) : null}
                    </div>
                    {target && resuming && target.leftMin ? <p className="mxb-play-sub">{t("minLeft", { count: target.leftMin })}</p> : null}
                    {!target ? <p className="mxb-play-sub">{t("notOnServer")}</p> : null}
                    {listError ? <p className="text-destructive text-sm" role="alert">{t("listError")}</p> : null}
                    {versions.length > 1 ? (
                        <div className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium" id="mxb-versions-l">{t("versions")}</span>
                            <div className="mxb-chips" role="radiogroup" aria-labelledby="mxb-versions-l">
                                {versions.map((f) => {
                                    const on = (chosen ?? target?.file.serverFileId) === f.serverFileId;
                                    return (
                                        <button key={f.serverFileId} type="button" role="radio" aria-checked={on} aria-current={on || undefined} className="mxb-chip" onClick={() => setChosen(f.serverFileId)} title={f.path}>
                                            {f.version.label || t("version")}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                </div>
            </section>

            {kind === "tv" && seasons.length > 0 ? (() => {
                const initial = target?.season && target.season > 0 ? target.season : seasons[0]?.seasonNumber ?? 1;
                return <Seasons key={initial} tmdbId={tmdbId} seasons={seasons} initial={initial} />;
            })() : null}

            <Offers data={data} />

            {det.cast && det.cast.length > 0 ? (
                <div className="mxb-block">
                    <MxRow title={t("cast")}>
                        {det.cast.slice(0, 24).map((p) => {
                            const img = tmdbImg(p.profilePath, "w185");
                            return (
                                <li key={`${p.id}:${p.role}`} className="mxb-cast">
                                    {img
                                        // eslint-disable-next-line @next/next/no-img-element -- TMDB headshot
                                        ? <img src={img} alt="" loading="lazy" decoding="async" />
                                        : <span className="mxb-cast-ph" aria-hidden />}
                                    <span className="mxb-cast-name">{p.name}</span>
                                    {p.role ? <span className="mxb-cast-role">{p.role}</span> : null}
                                </li>
                            );
                        })}
                    </MxRow>
                </div>
            ) : null}

            {recs.length > 0 ? (
                <div className="mxb-block">
                    <MxRow title={t("recommendations")}>
                        {recs.map((c) => <li key={`${c.kind}:${c.tmdbId}`}><MxTitleCard item={c} /></li>)}
                    </MxRow>
                </div>
            ) : null}
            {similar.length > 0 ? (
                <div className="mxb-block">
                    <MxRow title={t("similar")}>
                        {similar.map((c) => <li key={`${c.kind}:${c.tmdbId}`}><MxTitleCard item={c} /></li>)}
                    </MxRow>
                </div>
            ) : null}

            {trailer ? (
                <Dialog open={trailerOpen} onOpenChange={(open) => setTrailerOpen(open)}>
                    <DialogContent size="xl" mobile="center">
                        <DialogTitle>{t("trailerFor", { title: det.title })}</DialogTitle>
                        {trailerOpen ? (
                            <iframe
                                className="mxb-trailer"
                                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer)}?autoplay=1&rel=0&modestbranding=1&playsinline=1`}
                                title={t("trailerFor", { title: det.title })}
                                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                                allowFullScreen
                                referrerPolicy="strict-origin-when-cross-origin"
                            />
                        ) : null}
                    </DialogContent>
                </Dialog>
            ) : null}
        </article>
    );
}

function Seasons({ tmdbId, seasons, initial }: { tmdbId: number; seasons: { seasonNumber: number; name: string; episodeCount: number }[]; initial: number }) {
    const t = useTranslations("mx.browse.title");
    const [season, setSeason] = useState(initial);
    const { load, retry } = useSeason(tmdbId, season);
    return (
        <section className="mxb-block" aria-labelledby="mxb-eps-h">
            <div className="mx-row-head">
                <h2 id="mxb-eps-h" className="mx-row-title">{t("episodes")}</h2>
                <Link href={`/media/tv/${tmdbId}/season/${season}`} className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
                    {t("allEpisodes")} <ChevronRight aria-hidden className="size-4" />
                </Link>
            </div>
            {seasons.length > 1 ? (
                seasons.length > 12 ? (
                    <div>
                        <label htmlFor="mxb-season" className="sr-only">{t("season")}</label>
                        <select id="mxb-season" className="mxb-select" value={season} onChange={(e) => setSeason(Number(e.target.value))}>
                            {seasons.map((s) => <option key={s.seasonNumber} value={s.seasonNumber}>{t("seasonN", { n: s.seasonNumber })}</option>)}
                        </select>
                    </div>
                ) : (
                    <div className="mxb-chips" role="group" aria-label={t("season")}>
                        {seasons.map((s) => (
                            <button key={s.seasonNumber} type="button" className="mxb-chip" aria-pressed={s.seasonNumber === season} onClick={() => setSeason(s.seasonNumber)}>
                                {t("seasonN", { n: s.seasonNumber })}
                            </button>
                        ))}
                    </div>
                )
            ) : null}
            <EpisodeList tmdbId={tmdbId} load={load} retry={retry} />
        </section>
    );
}

const OFFER_ORDER: Offer["type"][] = ["subscription", "free", "ads", "rent", "buy"];

function Offers({ data }: { data: MediaTitleResponse }) {
    const t = useTranslations("mx.browse.title");
    const offers = [...data.availability.offers].sort((a, b) => OFFER_ORDER.indexOf(a.type) - OFFER_ORDER.indexOf(b.type));
    if (offers.length === 0) return null;
    return (
        <section className="mxb-block" aria-labelledby="mxb-offers-h">
            <h2 id="mxb-offers-h" className="mx-row-title">{t("whereToWatch")}</h2>
            <ul className="mxb-offers">
                {offers.map((o) => {
                    const logo = tmdbImg(o.logo, "w92");
                    return (
                        <li key={`${o.providerId}:${o.type}`}>
                            <a className="mxb-offer" href={o.launch.web || o.link || o.launch.search} target="_blank" rel="noopener noreferrer" aria-label={t("openOn", { name: o.name, type: t(`offer.${o.type}`) })}>
                                {logo
                                    // eslint-disable-next-line @next/next/no-img-element -- provider logo
                                    ? <img src={logo} alt="" loading="lazy" decoding="async" />
                                    : <span className="mxb-offer-ph" aria-hidden />}
                                <span className="flex flex-col">
                                    <span className="font-medium">{o.name}</span>
                                    <span className="mxb-offer-type">{t(`offer.${o.type}`)}</span>
                                </span>
                                <ExternalLink aria-hidden className="text-muted-foreground size-3.5" />
                            </a>
                        </li>
                    );
                })}
            </ul>
            {data.availability.attribution.length > 0 ? <p className="mxb-attrib">{t("attribution", { sources: data.availability.attribution.join(", ") })}</p> : null}
        </section>
    );
}

export function TitleSkeleton({ label }: { label: string }) {
    return (
        <div className="mxb-title-hero" aria-busy>
            <p className="sr-only" role="status">{label}</p>
            <div className="mxb-poster-wrap"><div className="mxb-poster bg-muted animate-pulse" aria-hidden style={{ viewTransitionName: POSTER_VT }} /></div>
            <div className="mxb-title-info" aria-hidden>
                <div className="mxb-skel-block bg-muted animate-pulse" style={{ height: "3.5rem", width: "60%" }} />
                <div className="mxb-skel-line bg-muted animate-pulse" style={{ width: "40%" }} />
                <div className="mxb-skel-block bg-muted animate-pulse" style={{ height: "5rem", width: "90%" }} />
                <div className="flex gap-3">
                    <div className="mxb-skel-block bg-muted animate-pulse" style={{ height: "2.75rem", width: "9rem" }} />
                    <div className="mxb-skel-block bg-muted animate-pulse" style={{ height: "2.75rem", width: "9rem" }} />
                </div>
            </div>
        </div>
    );
}
