"use client";

/**
 * Episodes for one season (`/media/title/tv/{id}/season/{n}`): still, "N. Name", runtime/air date, progress,
 * "On your server" badge and a play link (best local version, resume handled by the player). Used by the
 * title page (with a season picker) and by the dedicated season page.
 */
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Play, Server } from "lucide-react";
import type { MediaSeasonResponse, SeasonEpisode } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { ErrorBlock, Unsupported, useGridKeys, useMediaScope, type Load } from "./common";
import { bestFile, playHref, progressRatio } from "./lib";
import { useAsync } from "./use-async";

export function useSeason(tmdbId: number, season: number | null) {
    const { media, scope } = useMediaScope();
    const key = scope && season != null ? `${scope}|${tmdbId}|${season}` : null;
    return useAsync<MediaSeasonResponse>(key, (attempt) => {
        if (!media || season == null) return Promise.resolve(null);
        if (attempt > 0) media.invalidate();
        return media.season(tmdbId, season);
    });
}

export function EpisodeCard({ tmdbId, ep, showOverview = false }: { tmdbId: number; ep: SeasonEpisode; showOverview?: boolean }) {
    const t = useTranslations("mx.browse.episodes");
    const fmt = useFormatter();
    const file = bestFile(ep.files);
    const ratio = progressRatio(ep.progress);
    const img = tmdbImg(ep.stillPath, "w500");
    const air = ep.airDate && /^\d{4}-\d{2}-\d{2}/.test(ep.airDate) ? fmt.dateTime(new Date(ep.airDate), { dateStyle: "medium" }) : null;
    const meta = [
        ep.runtime ? t("runtime", { min: ep.runtime }) : null,
        air,
        ep.progress?.completed ? t("watched") : null,
    ].filter(Boolean).join(" · ");
    const name = t("name", { n: ep.episodeNumber, name: ep.name || t("untitled") });
    const body = (
        <>
            <span className="mxb-ep-img">
                {img
                    // eslint-disable-next-line @next/next/no-img-element -- TMDB still
                    ? <img src={img} alt="" loading="lazy" decoding="async" />
                    : <span className="mx-card-fallback">{name}</span>}
                {file ? <span className="mxb-ep-play" aria-hidden><Play className="size-10" /></span> : null}
                {file ? <span className="mx-chip mxb-ep-badge"><Server aria-hidden className="size-3" /> {t("onServer")}</span> : null}
                {ratio != null ? <span className="mx-card-progress" aria-hidden><span style={{ width: `${Math.round(ratio * 100)}%` }} /></span> : null}
            </span>
            <span className="mxb-ep-title">{name}</span>
            {meta ? <span className="mxb-ep-meta">{meta}</span> : null}
            {showOverview && ep.overview ? <span className="mxb-ep-ov">{ep.overview}</span> : null}
        </>
    );
    if (!file) {
        return <div className="mxb-ep" aria-disabled="true" title={t("notOnServer")}>{body}<span className="sr-only">{t("notOnServer")}</span></div>;
    }
    const label = ep.progress && !ep.progress.completed && ep.progress.positionSec > 0 ? t("resumeLabel", { name }) : t("playLabel", { name });
    return (
        <Link href={playHref("tv", tmdbId, { season: ep.seasonNumber, episode: ep.episodeNumber })} className="mxb-ep" aria-label={label} prefetch={false}>
            {body}
        </Link>
    );
}

export function EpisodeSkeleton({ count = 6 }: { count?: number }) {
    return (
        <ul className="mxb-episodes" aria-hidden>
            {Array.from({ length: count }, (_, i) => (
                <li key={i} className="mxb-skel">
                    <div className="mxb-skel-img mxb-skel-wide bg-muted animate-pulse" />
                    <div className="mxb-skel-line bg-muted animate-pulse" />
                </li>
            ))}
        </ul>
    );
}

export function EpisodeList({ tmdbId, load, retry, showOverview }: {
    tmdbId: number; load: Load<MediaSeasonResponse>; retry: () => void; showOverview?: boolean;
}) {
    const t = useTranslations("mx.browse.episodes");
    const keys = useGridKeys();
    if (load.s === "loading") return <><p className="sr-only" role="status">{t("loading")}</p><EpisodeSkeleton /></>;
    if (load.s === "error") return <ErrorBlock error={load.error} onRetry={retry} />;
    if (load.s === "unsupported") return <Unsupported />;
    if (load.data.episodes.length === 0) return <p className="text-muted-foreground">{t("empty")}</p>;
    return (
        <ul className="mxb-episodes" aria-label={load.data.name} onKeyDown={keys}>
            {load.data.episodes.map((ep) => (
                <li key={`${ep.seasonNumber}:${ep.episodeNumber}`}><EpisodeCard tmdbId={tmdbId} ep={ep} showOverview={showOverview} /></li>
            ))}
        </ul>
    );
}
