"use client";

/**
 * Cinematic hero (D25/D32): backdrop, logo (or title), meta chips, overview, one primary action.
 * After 3 s of rest (and no reduced motion / save-data) a muted YouTube trailer fades in behind.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Info, Play } from "lucide-react";
import { Button } from "@mmo/ui";
import type { TitleCard, TitleDetails } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { useMmo } from "./mmo-provider";
import { useBackdrop } from "./backdrop";
import { titleHref } from "./title-card";

export function pickTrailer(details: Pick<TitleDetails, "videos"> | null | undefined): string | null {
    const vids = details?.videos ?? [];
    const yt = vids.filter((v) => v.site === "YouTube");
    const best = yt.find((v) => v.type === "Trailer") ?? yt.find((v) => v.type === "Teaser");
    return best?.key ?? null;
}

function trailerAllowed(): boolean {
    if (typeof window === "undefined") return false;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    if (document.documentElement.dataset.motion === "reduced") return false;
    const conn = (navigator as { connection?: { saveData?: boolean } }).connection;
    return !conn?.saveData;
}

export function Hero({ item }: { item: TitleCard }) {
    // Remount per title: details + trailer state start fresh without resetting state in an effect.
    return <HeroBody key={`${item.kind}:${item.tmdbId}`} item={item} />;
}

function HeroBody({ item }: { item: TitleCard }) {
    const t = useTranslations("mx.shell.home");
    const locale = useLocale();
    const { clients } = useMmo();
    const { set } = useBackdrop();
    const [details, setDetails] = useState<TitleDetails | null>(null);
    const [trailerOn, setTrailerOn] = useState(false);

    useEffect(() => { set(item.backdropPath); }, [item.backdropPath, set]);

    useEffect(() => {
        let alive = true;
        void clients?.media.mediaTitle(item.kind, item.tmdbId).then((r) => { if (alive && r) setDetails(r.title); }).catch(() => undefined);
        return () => { alive = false; };
    }, [clients, item.kind, item.tmdbId]);

    const trailer = pickTrailer(details);
    useEffect(() => {
        if (!trailer || !trailerAllowed()) return;
        const id = setTimeout(() => setTrailerOn(true), 3000);
        return () => clearTimeout(id);
    }, [trailer]);

    const logo = tmdbImg(details?.logoPath ?? null, "w500");
    const year = item.releaseDate?.slice(0, 4);
    const genres = details?.genres.slice(0, 3).map((g) => g.name) ?? [];
    const runtime = details?.runtime ? new Intl.NumberFormat(locale).format(details.runtime) + " min" : null;
    return (
        <section className="mx-hero" aria-label={item.title}>
            {trailer && trailerOn ? (
                <iframe
                    title={item.title}
                    className="mx-hero-trailer"
                    data-on
                    tabIndex={-1}
                    aria-hidden
                    allow="autoplay; encrypted-media"
                    src={`https://www.youtube-nocookie.com/embed/${trailer}?autoplay=1&mute=1&controls=0&loop=1&playlist=${trailer}&modestbranding=1&playsinline=1&rel=0`}
                />
            ) : null}
            {logo
                // eslint-disable-next-line @next/next/no-img-element -- TMDB logo, transparent PNG
                ? <img src={logo} alt={item.title} className="mx-hero-logo" />
                : <h1 className="mx-hero-title">{item.title}</h1>}
            <div className="mx-hero-meta">
                {year ? <span>{year}</span> : null}
                {details?.certification ? <span className="mx-chip">{details.certification}</span> : null}
                {runtime ? <span>{runtime}</span> : null}
                {item.voteAverage ? <span>★ {item.voteAverage.toFixed(1)}</span> : null}
                {genres.length ? <span>{genres.join(" · ")}</span> : null}
            </div>
            {item.overview ? <p className="mx-hero-overview">{item.overview}</p> : null}
            <div className="mx-hero-actions">
                <Button size="lg" render={<Link href={`${titleHref(item.kind, item.tmdbId)}?play=1`} />}>
                    <Play aria-hidden className="size-5" /> {t("play")}
                </Button>
                <Button size="lg" variant="secondary" render={<Link href={titleHref(item.kind, item.tmdbId)} />}>
                    <Info aria-hidden className="size-5" /> {t("info")}
                </Button>
            </div>
        </section>
    );
}
