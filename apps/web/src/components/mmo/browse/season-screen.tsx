"use client";

/** Season page (`/media/tv/{id}/season/{n}`): all episodes with stills, overview, progress and play links. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft } from "lucide-react";
import type { SeasonSummary, TitleDetails } from "@/lib/mmo/media-types";
import { BackdropProvider, useBackdrop } from "../backdrop";
import { useMmo } from "../mmo-provider";
import { EpisodeList, useSeason } from "./episodes";

export function SeasonScreen({ tmdbId, season }: { tmdbId: number; season: number }) {
    return <BackdropProvider><SeasonBody tmdbId={tmdbId} season={season} /></BackdropProvider>;
}

function SeasonBody({ tmdbId, season }: { tmdbId: number; season: number }) {
    const t = useTranslations("mx.browse.season");
    const { clients } = useMmo();
    const { set } = useBackdrop();
    const { load, retry } = useSeason(tmdbId, season);
    const [show, setShow] = useState<TitleDetails | null>(null);

    useEffect(() => {
        let alive = true;
        void clients?.media.mediaTitle("tv", tmdbId).then((r) => { if (alive && r) setShow(r.title); }).catch(() => undefined);
        return () => { alive = false; };
    }, [clients, tmdbId]);
    useEffect(() => { if (show) set(show.backdropPath); }, [show, set]);

    const seasons: SeasonSummary[] = (show?.seasons ?? []).filter((s) => s.seasonNumber > 0);
    const data = load.s === "ok" ? load.data : null;
    const heading = data?.name || t("seasonN", { n: season });

    return (
        <div className="pt-6">
            <Link href={`/media/tv/${tmdbId}`} className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline">
                <ChevronLeft aria-hidden className="size-4" /> {show?.title ?? t("back")}
            </Link>
            <div className="mx-page-head">
                <div>
                    <h1 className="mx-page-title">{heading}</h1>
                    {data ? <p className="mxb-count">{t("episodes", { count: data.episodes.length })}</p> : null}
                </div>
                {seasons.length > 1 ? (
                    <nav className="mxb-chips" aria-label={t("seasons")}>
                        {seasons.map((s) => (
                            <Link key={s.seasonNumber} href={`/media/tv/${tmdbId}/season/${s.seasonNumber}`} className="mxb-chip" aria-current={s.seasonNumber === season ? "true" : undefined}>
                                {t("seasonN", { n: s.seasonNumber })}
                            </Link>
                        ))}
                    </nav>
                ) : null}
            </div>
            {data?.overview ? <p className="mxb-overview mb-6">{data.overview}</p> : null}
            <EpisodeList tmdbId={tmdbId} load={load} retry={retry} showOverview />
        </div>
    );
}
